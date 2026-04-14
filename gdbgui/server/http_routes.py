import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from werkzeug.utils import secure_filename

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    Response,
    url_for
)
from pygments.lexers import get_lexer_for_filename  # type: ignore

from gdbgui import htmllistformatter, __version__

from .constants import TEMPLATE_DIR, USING_WINDOWS, SIGNAL_NAME_TO_OBJ
from .http_util import (
    add_csrf_token_to_session,
    authenticate,
    client_error,
    csrf_protect,
)
from .share_function import require_uploaded_binary
import uuid

logger = logging.getLogger(__file__)
blueprint = Blueprint("http_routes", __name__, template_folder=str(TEMPLATE_DIR))

# ── Sandbox 路徑 ──────────────────────────────────────────────────────────────
_SANDBOX_DIR = Path(__file__).parent / "sandbox"
_STUB_C    = _SANDBOX_DIR / "stub.c"
_STUB_O    = _SANDBOX_DIR / "stub.o"
_WRAPPER   = _SANDBOX_DIR / "wrapper.sh"

# --wrap flags（LD 連結層完全封鎖，stub.c 有對應實作）
# 原則：只 wrap 幾乎不會被 C runtime 自身使用的函式，
# 避免把 printf 用到的 write() 也攔截掉。
_WRAP_FLAGS = [
    # shell 執行
    "-Wl,--wrap=system",
    "-Wl,--wrap=popen",
    # exec 系列
    "-Wl,--wrap=execl",
    "-Wl,--wrap=execle",
    "-Wl,--wrap=execlp",
    "-Wl,--wrap=execv",
    "-Wl,--wrap=execvp",
    "-Wl,--wrap=execvpe",
    "-Wl,--wrap=execve",
    # 建立子程序
    "-Wl,--wrap=fork",
    "-Wl,--wrap=vfork",
    # 刪除
    "-Wl,--wrap=unlink",
    "-Wl,--wrap=unlinkat",
    "-Wl,--wrap=remove",
    "-Wl,--wrap=rmdir",
    # 改名 / 移動
    "-Wl,--wrap=rename",
    "-Wl,--wrap=renameat",
    # 建立目錄
    "-Wl,--wrap=mkdir",
    "-Wl,--wrap=mkdirat",
    # 權限 / 擁有者
    "-Wl,--wrap=chmod",
    "-Wl,--wrap=fchmod",
    "-Wl,--wrap=chown",
    "-Wl,--wrap=fchown",
    # 符號連結 / 硬連結
    "-Wl,--wrap=symlink",
    "-Wl,--wrap=link",
    # 截斷
    "-Wl,--wrap=truncate",
    "-Wl,--wrap=ftruncate",
    # 動態載入惡意 .so
    "-Wl,--wrap=dlopen",
]

# ── 靜態分析規則 ──────────────────────────────────────────────────────────────
# 每個 tuple：(compiled_regex, 說明文字, severity)
# severity = "block" → 連結層也會封鎖（有 --wrap）
# severity = "warn"  → 只警告，無法從連結層攔截（如 ofstream、fopen write mode）

_DANGEROUS_PATTERNS = [
    # ── Shell 執行（連結層封鎖）────────────────────────────────────────────
    (re.compile(r'\bsystem\s*\('),      "system()     — 執行 shell 命令",           "block"),
    (re.compile(r'\bpopen\s*\('),       "popen()      — 開啟 shell 子程序管道",      "block"),

    # ── 程序建立 / 取代（連結層封鎖）───────────────────────────────────────
    (re.compile(r'\bfork\s*\('),        "fork()       — 建立子程序",                "block"),
    (re.compile(r'\bvfork\s*\('),       "vfork()      — 建立子程序",                "block"),
    (re.compile(r'\bexecl[pev]?\s*\('), "execl*()     — 取代當前程序",              "block"),
    (re.compile(r'\bexecv[pe]?\s*\('),  "execv*()     — 取代當前程序",              "block"),
    (re.compile(r'\bexecve\s*\('),      "execve()     — 取代當前程序（syscall）",    "block"),
    (re.compile(r'\bposix_spawn\s*\('), "posix_spawn()— 建立新程序",                "warn"),

    # ── 刪除（連結層封鎖）──────────────────────────────────────────────────
    (re.compile(r'\bunlinkat?\s*\('),   "unlink()     — 刪除檔案",                  "block"),
    (re.compile(r'\bremove\s*\('),      "remove()     — 刪除檔案/目錄",             "block"),
    (re.compile(r'\brmdir\s*\('),       "rmdir()      — 刪除目錄",                  "block"),

    # ── 改名 / 移動（連結層封鎖）───────────────────────────────────────────
    (re.compile(r'\brenameat?\s*\('),   "rename()     — 移動/重命名檔案",           "block"),

    # ── 建立目錄（連結層封鎖）──────────────────────────────────────────────
    (re.compile(r'\bmkdirat?\s*\('),    "mkdir()      — 建立目錄",                  "block"),

    # ── 權限 / 擁有者（連結層封鎖）─────────────────────────────────────────
    (re.compile(r'\bf?chmod\s*\('),     "chmod()      — 修改檔案權限",              "block"),
    (re.compile(r'\bf?chown\s*\('),     "chown()      — 修改檔案擁有者",            "block"),

    # ── 連結（連結層封鎖）──────────────────────────────────────────────────
    (re.compile(r'\bsymlink\s*\('),     "symlink()    — 建立符號連結",              "block"),
    (re.compile(r'\blink\s*\('),        "link()       — 建立硬連結",               "block"),

    # ── 截斷（連結層封鎖）──────────────────────────────────────────────────
    (re.compile(r'\bftruncate\s*\('),   "ftruncate()  — 截斷檔案",                  "block"),
    (re.compile(r'\btruncate\s*\('),    "truncate()   — 截斷檔案",                  "block"),

    # ── 動態載入（連結層封鎖）──────────────────────────────────────────────
    (re.compile(r'\bdlopen\s*\('),      "dlopen()     — 動態載入 .so（可載入惡意庫）","block"),

    # ── 低階寫入（僅靜態警告，C runtime 內部也會用，不適合 wrap）───────────
    (re.compile(r'\bopen\s*\(.*O_WRONLY|O_CREAT|O_TRUNC'), "open(O_WRONLY/O_CREAT) — 低階寫入/建立檔案", "warn"),
    (re.compile(r'\bcreat\s*\('),       "creat()      — 建立並開啟寫入檔案",        "warn"),
    (re.compile(r'\bmknod\s*\('),       "mknod()      — 建立裝置/特殊檔案",         "warn"),
    (re.compile(r'\bmkfifo\s*\('),      "mkfifo()     — 建立具名管道",              "warn"),
    (re.compile(r'\bmkstemp\s*\('),     "mkstemp()    — 建立臨時可寫檔案",          "warn"),

    # ── fopen 寫入模式（僅靜態警告）────────────────────────────────────────
    # 匹配 fopen(xxx, "w") / fopen(xxx, "a") / fopen(xxx, "w+") 等寫入模式
    (re.compile(r'\bfopen\s*\([^,]+,\s*"[wa]'), "fopen(\"w\"/\"a\") — 開啟檔案寫入/附加", "warn"),
    (re.compile(r'\bfreopen\s*\('),     "freopen()    — 重新導向檔案流",            "warn"),

    # ── C++ 檔案流（僅靜態警告）────────────────────────────────────────────
    (re.compile(r'\bofstream\b'),       "ofstream     — C++ 寫入檔案流",            "warn"),
    (re.compile(r'\bfstream\b'),        "fstream      — C++ 讀寫檔案流",            "warn"),
    # C++17 std::filesystem
    (re.compile(r'\bfilesystem\s*::'), "std::filesystem — C++17 檔案系統操作",     "warn"),
    (re.compile(r'\bfs\s*::\s*(remove|rename|copy|create_directory|permissions)'),
                                        "fs::remove/rename/copy — filesystem 危險操作", "warn"),

    # ── 網路（僅靜態警告，可能外洩資料）───────────────────────────────────
    (re.compile(r'\bsocket\s*\('),      "socket()     — 開啟網路連接（可能外洩資料）","warn"),
    (re.compile(r'\bconnect\s*\('),     "connect()    — 連接遠端主機",              "warn"),
    (re.compile(r'\bbind\s*\('),        "bind()       — 監聽網路埠",               "warn"),

    # ── 發送信號 / 權限提升（僅靜態警告）──────────────────────────────────
    (re.compile(r'\bkill\s*\('),        "kill()       — 向其他程序發送信號",        "warn"),
    (re.compile(r'\bsetuid\s*\('),      "setuid()     — 提升程序權限",             "warn"),
    (re.compile(r'\bsetgid\s*\('),      "setgid()     — 提升程序群組權限",         "warn"),
    (re.compile(r'\bsetenv\s*\('),      "setenv()     — 修改環境變數",             "warn"),
    (re.compile(r'\bputenv\s*\('),      "putenv()     — 修改環境變數",             "warn"),

    # ── 記憶體映射寫入（僅靜態警告）────────────────────────────────────────
    (re.compile(r'\bmmap\s*\('),        "mmap()       — 記憶體映射（含 MAP_SHARED 可能寫入檔案）","warn"),
]

def _ensure_stub_compiled() -> bool:
    """確保 sandbox/stub.o 已編譯；回傳是否成功。"""
    if _STUB_O.exists():
        return True
    try:
        res = subprocess.run(
            ["gcc", "-c", str(_STUB_C), "-o", str(_STUB_O)],
            capture_output=True, text=True, timeout=20,
        )
        if res.returncode != 0:
            logger.warning(f"[sandbox] stub compilation failed:\n{res.stderr}")
            return False
        logger.info("[sandbox] stub.o compiled successfully")
        return True
    except Exception as e:
        logger.warning(f"[sandbox] stub compilation error: {e}")
        return False

def _check_dangerous_code(code: str) -> list:
    """掃描原始碼，回傳偵測到的危險呼叫清單。
    每項為 dict: { "desc": str, "severity": "block"|"warn" }
    """
    # 移除單行與多行注釋，避免誤報注釋中的 system()
    stripped = re.sub(r'//[^\n]*', '', code)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
    # 移除字串常量中的內容（避免 printf("system(") 誤報）
    stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', stripped)
    stripped = re.sub(r"'(?:[^'\\]|\\.)*'", "''", stripped)

    found = []
    seen_descs = set()
    for pattern, desc, severity in _DANGEROUS_PATTERNS:
        if desc not in seen_descs and pattern.search(stripped):
            found.append({"desc": desc, "severity": severity})
            seen_descs.add(desc)
    return found

# 快取目錄：/tmp/gdbgui_tts/，同一段文字只生成一次 MP3
_TTS_CACHE_DIR = Path(tempfile.gettempdir()) / "gdbgui_tts"
_TTS_CACHE_DIR.mkdir(exist_ok=True)


@blueprint.route("/tts_audio")
@authenticate
def tts_audio():
    """生成並回傳 TTS 音訊。相同文字直接從快取回傳，節省資源。
    使用 ffmpeg 將 gTTS MP3 轉為 OGG Vorbis：
      - OGG 無 MP3 encoder delay，開頭不會被截掉
      - 檔案更小（約 -20%）
    若 ffmpeg 不存在則回退使用原始 MP3。
    """
    text = request.args.get("text", "").strip()
    if not text:
        return client_error({"message": "text is required"})

    lang = "zh-TW"
    cache_key = hashlib.md5(f"{lang}:{text}".encode("utf-8")).hexdigest()
    mp3_path = _TTS_CACHE_DIR / f"{cache_key}.mp3"
    ogg_path = _TTS_CACHE_DIR / f"{cache_key}.ogg"

    # 生成 MP3（gTTS）
    if not mp3_path.exists():
        try:
            from gtts import gTTS
            tts = gTTS(text=text, lang="zh-TW", slow=False)
            tts.save(str(mp3_path))
        except Exception as e:
            logger.error(f"[tts_audio] gTTS error: {e}")
            return Response("TTS generation failed", status=503)

    # 嘗試用 ffmpeg 轉 OGG（無 encoder delay）
    if not ogg_path.exists():
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(mp3_path),
                 "-c:a", "libvorbis", "-q:a", "3",
                 str(ogg_path)],
                capture_output=True, timeout=15
            )
            if result.returncode != 0:
                ogg_path.unlink(missing_ok=True)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass  # ffmpeg 不存在，回退 MP3

    if ogg_path.exists():
        return send_file(str(ogg_path), mimetype="audio/ogg", conditional=True)

    return send_file(str(mp3_path), mimetype="audio/mpeg", conditional=True)

# @blueprint.route("/upload", methods=["GET", "POST"])
# def upload_source_code():


@blueprint.route("/upload", methods=["GET", "POST"])
@authenticate
def upload():
    """Upload a binary or source file. If C/C++ source is uploaded,
    compile it to assembly (.s) and use that assembly for the session."""
    add_csrf_token_to_session()

    if request.method == "POST":
        uploaded = request.files.get("binary")
        if not uploaded or uploaded.filename == "":
            return client_error({"message": "No file uploaded"})

        filename = secure_filename(uploaded.filename)

        # ensure a per-session prefix exists and use it to avoid filename collisions
        if "uploaded_prefix" not in session:
            session["uploaded_prefix"] = uuid.uuid4().hex
        prefix = session["uploaded_prefix"]

        upload_dir = current_app.config.get("upload_folder") or os.path.join(
            current_app.root_path, "uploads"
        )
        os.makedirs(upload_dir, exist_ok=True)

        # store file with session prefix
        stored_filename = f"{prefix}_{filename}"
        dest_path = os.path.join(upload_dir, stored_filename)
        uploaded.save(dest_path)

        name, ext = os.path.splitext(stored_filename)
        ext = ext.lower()

        # If C/C++ source -> compile to executable (g++ a.cpp -o a.a -g)
        if ext in (".c", ".cpp", ".cc", ".cxx", ".c++"):
            exec_filename = name + ".a"  # will produce e.g. a.a like your example
            exec_path = os.path.join(upload_dir, exec_filename)
            # choose compiler: prefer g++ for .cpp, gcc for .c (can be overridden via config)
            compiler = current_app.config.get("c_compiler") or ("g++" if ext != ".c" else "gcc")
            try:
                res = subprocess.run(
                    [compiler, "-g", "-O0", dest_path, "-o", exec_path],
                    capture_output=True,
                    text=True,
                )
                if res.returncode != 0:
                    return client_error(
                        {"message": "Compilation failed", "stderr": res.stderr}
                    )
                # ensure executable permission
                try:
                    os.chmod(exec_path, 0o755)
                except Exception:
                    # non-fatal; proceed even if chmod fails
                    pass
            except FileNotFoundError:
                return client_error(
                    {"message": f"Compiler not found: {compiler}. Install it or set app.config['c_compiler']"}
                )
            except Exception as e:
                return client_error({"message": str(e)})

            session["uploaded_binary"] = exec_path
            current_app.config["initial_binary_and_args"] = [exec_path]
        # If assembly uploaded (or other), use it directly
        else:
            session["uploaded_binary"] = dest_path
            current_app.config["initial_binary_and_args"] = [dest_path]

        return redirect(url_for(".gdbgui"))

    # render upload page - use template name relative to templates folder
    return render_template("upload.html", csrf_token=session["csrf_token"])



@blueprint.route("/create_and_upload", methods=["POST"])
@authenticate
def create_and_upload():
    """Create a source file from posted code, compile it (if C/C++),
    save resulting executable in session and redirect to gdbgui.
    Expects form fields:
      - code: the source code
      - filename: optional filename (e.g. pasted.cpp). If missing, uses pasted_code.cpp
      - csrf_token: csrf token (checked by before_request)
    """
    add_csrf_token_to_session()

    import uuid
    import os
    
    code = request.form.get("code")
    filepath = request.form.get("filepath")
    program_input = request.form.get("program_input", "")
    
    if not code:
        return client_error({"message": "No code submitted"})

    # ensure a per-session prefix exists and use it to avoid filename collisions
    if "uploaded_prefix" not in session:
        session["uploaded_prefix"] = uuid.uuid4().hex
    prefix = session["uploaded_prefix"]

    # Determine where to save the code
    if filepath and os.path.exists(filepath):
        src_path = filepath
        ext = os.path.splitext(src_path)[1]
        stored_filename = os.path.basename(src_path)
        upload_dir = os.path.dirname(src_path)
    else:
        # Fallback to auto-generate a unique filename for the pasted source
        filename = f"pasted_{uuid.uuid4().hex}.cpp"
        ext = ".cpp"

        upload_dir = current_app.config.get("upload_folder") or os.path.join(
            current_app.root_path, "uploads"
        )
        os.makedirs(upload_dir, exist_ok=True)

        stored_filename = f"{prefix}_{filename}"
        src_path = os.path.join(upload_dir, stored_filename)

    try:
        with open(src_path, "w") as f:
            f.write(code)
    except Exception as e:
        return client_error({"message": "Failed to write source file", "detail": str(e)})

    binary_path_result = None
    sandbox_warnings = []  # 靜態分析警告，回傳給前端

    # If C/C++ source -> compile to executable
    if ext.lower() in (".c", ".cpp", ".cc", ".cxx", ".c++"):
        # ── 靜態分析：偵測危險呼叫 ────────────────────────────────────────
        detected = _check_dangerous_code(code)
        if detected:
            for item in detected:
                if item["severity"] == "block":
                    sandbox_warnings.append(
                        f"[sandbox:封鎖] {item['desc']}（執行時將被攔截並回傳 EPERM）"
                    )
                else:
                    sandbox_warnings.append(
                        f"[sandbox:警告] {item['desc']}（連結層無法攔截，請注意使用）"
                    )
            logger.info(f"[sandbox] detected dangerous calls: {[i['desc'] for i in detected]}")

        # ── 編譯 stub.o（若尚未編譯）──────────────────────────────────────
        stub_available = _ensure_stub_compiled()

        name_only, _ = os.path.splitext(stored_filename)
        exec_filename = name_only + ".a"
        exec_path = os.path.join(upload_dir, exec_filename)
        compiler = current_app.config.get("c_compiler") or ("g++" if ext.lower() != ".c" else "gcc")

        # 基本編譯命令；若 stub 可用則附加 --wrap flags 與 stub.o
        compile_cmd = [compiler, "-g", "-O0", src_path, "-o", exec_path]
        if stub_available:
            compile_cmd += [str(_STUB_O)] + _WRAP_FLAGS

        try:
            res = subprocess.run(
                compile_cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if res.returncode != 0:
                # 若加入 stub 導致失敗（少數情況），降級重試（不含 sandbox）
                if stub_available:
                    logger.warning("[sandbox] compile with stub failed, retrying without sandbox")
                    res2 = subprocess.run(
                        [compiler, "-g", "-O0", src_path, "-o", exec_path],
                        capture_output=True, text=True, timeout=30,
                    )
                    if res2.returncode != 0:
                        return client_error({"message": "Compilation failed", "stderr": res2.stderr})
                    sandbox_warnings.append("[sandbox] 沙箱連結失敗，以無沙箱模式編譯（請告知管理員）")
                else:
                    return client_error({"message": "Compilation failed", "stderr": res.stderr})
            try:
                os.chmod(exec_path, 0o755)
            except Exception:
                pass
        except FileNotFoundError:
            return client_error({"message": f"Compiler not found: {compiler}."})
        except subprocess.TimeoutExpired as e:
            return client_error({"message": "Compilation timed out", "detail": str(e)})
        except Exception as e:
            return client_error({"message": str(e)})

        session["uploaded_binary"] = exec_path
        binary_path_result = exec_path
        current_app.config["initial_binary_and_args"] = [exec_path]
    else:
        # non-C source: just register the source file as uploaded_binary
        session["uploaded_binary"] = src_path
        binary_path_result = src_path
        current_app.config["initial_binary_and_args"] = [src_path]

    # Write the program input to a .in file
    input_filename = f"{prefix}_input.in"
    input_path = os.path.join(upload_dir, input_filename)
    try:
        with open(input_path, "w") as f:
            f.write(program_input)
    except Exception as e:
        logger.warning(f"Failed to write input file: {e}")

    session["uploaded_input"] = input_path

    if request.headers.get("Accept") == "application/json":
        return jsonify({
            "status": "success",
            "binary_path": binary_path_result,
            "source_path": src_path,
            "input_path": input_path,
            "sandbox_warnings": sandbox_warnings,
        })

    return redirect(url_for(".gdbgui"))






@blueprint.route("/read_file", methods=["GET"])
@csrf_protect
def read_file():
    """Read a file and return its contents as an array"""

    def should_highlight():
        try:
            return json.loads(request.args.get("highlight", "true"))
        except Exception as e:
            if current_app.debug:
                print("Raising exception since debug is on")
                raise e

            else:
                return True  # highlight argument was invalid for some reason, default to true

    path = request.args.get("path")
    start_line = int(request.args.get("start_line"))
    start_line = max(1, start_line)  # make sure it's not negative
    end_line = int(request.args.get("end_line"))

    if path and os.path.isfile(path):
        try:
            last_modified = os.path.getmtime(path)
            with open(path, "r") as f:
                raw_source_code_list = f.read().split("\n")
                num_lines_in_file = len(raw_source_code_list)
                end_line = min(
                    num_lines_in_file, end_line
                )  # make sure we don't try to go too far

                # if leading lines are '', then the lexer will strip them out, but we want
                # to preserve blank lines. Insert a space whenever we find a blank line.
                for i in range((start_line - 1), (end_line)):
                    if raw_source_code_list[i] == "":
                        raw_source_code_list[i] = " "
                raw_source_code_lines_of_interest = raw_source_code_list[
                    (start_line - 1) : (end_line)
                ]
            try:
                lexer = get_lexer_for_filename(path)
            except Exception:
                lexer = None

            if lexer and should_highlight():
                highlighted = True
                # convert string into tokens
                tokens = lexer.get_tokens("\n".join(raw_source_code_lines_of_interest))
                # format tokens into nice, marked up list of html
                formatter = (
                    htmllistformatter.HtmlListFormatter()
                )  # Don't add newlines after each line
                source_code = formatter.get_marked_up_list(tokens)
            else:
                highlighted = False
                source_code = raw_source_code_lines_of_interest

            return jsonify(
                {
                    "source_code_array": source_code,
                    "path": path,
                    "last_modified_unix_sec": last_modified,
                    "highlighted": highlighted,
                    "start_line": start_line,
                    "end_line": end_line,
                    "num_lines_in_file": num_lines_in_file,
                }
            )

        except Exception as e:
            return client_error({"message": "%s" % e})

    else:
        return client_error({"message": "File not found: %s" % path})


@blueprint.route("/get_last_modified_unix_sec", methods=["GET"])
@csrf_protect
def get_last_modified_unix_sec():
    """Get last modified unix time for a given file"""
    path = request.args.get("path")
    if path and os.path.isfile(path):
        try:
            last_modified = os.path.getmtime(path)
            return jsonify({"path": path, "last_modified_unix_sec": last_modified})

        except Exception as e:
            return client_error({"message": "%s" % e, "path": path})

    else:
        return client_error({"message": "File not found: %s" % path, "path": path})


@blueprint.route("/help")
def help_route():
    return redirect("https://github.com/cs01/gdbgui/blob/master/HELP.md")


@blueprint.route("/dashboard", methods=["GET"])
@authenticate
def dashboard():
    resp = require_uploaded_binary()
    if resp:
        return resp
    manager = current_app.config.get("_manager")

    add_csrf_token_to_session()

    """display a dashboard with a list of all running gdb processes
    and ability to kill them, or open a new tab to work with that
    GdbController instance"""
    return render_template(
        "dashboard.html",
        gdbgui_sessions=manager.get_dashboard_data(),
        csrf_token=session["csrf_token"],
        default_command=current_app.config["gdb_command"],
    )


@blueprint.route("/", methods=["GET"])
@authenticate
def gdbgui():
    # check if user didn't upload file
    # check if user didn't upload file, OR if the uploaded file is missing from disk
    resp = require_uploaded_binary()
    should_create_default = False
    
    if resp:
        # Case 1: No file in session
        should_create_default = True
    else:
        # Case 2: File in session, but check if it exists on disk
        bin_path = session.get("uploaded_binary")
        upload_dir = current_app.config.get("upload_folder") or os.path.join(
            current_app.root_path, "uploads"
        )
        # Determine if we should check for missing source
        # Only check if the binary is inside our uploads folder (don't mess with external local debug targets)
        if bin_path and os.path.abspath(bin_path).startswith(os.path.abspath(upload_dir)):
            if not os.path.exists(bin_path):
                should_create_default = True
            else:
                # Also check if corresponding source exists (assuming .a -> .cpp/.c mapping from uploads)
                # If it's a .a file we created, we expect a source file
                base, ext = os.path.splitext(bin_path)
                if ext == '.a':
                     # Check common extensions
                     found_source = False
                     for src_ext in ['.cpp', '.c', '.cc', '.cxx', '.c++']:
                         if os.path.exists(base + src_ext):
                             found_source = True
                             break
                     if not found_source:
                         logger.info(f"Binary {bin_path} exists but source missing. Recreating default.")
                         should_create_default = True

    if should_create_default:
        # Create a default hello world cpp
        upload_dir = current_app.config.get("upload_folder") or os.path.join(
            current_app.root_path, "uploads"
        )
        os.makedirs(upload_dir, exist_ok=True)
        
        filename = f"default_hello_{uuid.uuid4().hex}.cpp"
        src_path = os.path.join(upload_dir, filename)
        
        default_code = '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n'
        
        with open(src_path, "w") as f:
            f.write(default_code)
            
        # Compile it
        name_only, _ = os.path.splitext(filename)
        exec_filename = name_only + ".a"
        exec_path = os.path.join(upload_dir, exec_filename)
        compiler = current_app.config.get("c_compiler") or "g++"
        
        try:
            res = subprocess.run(
                [compiler, "-g", "-O0", src_path, "-o", exec_path],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if res.returncode == 0:
                try:
                    os.chmod(exec_path, 0o755)
                except Exception:
                    pass
                
                # Set session variables
                session["uploaded_binary"] = exec_path
                current_app.config["initial_binary_and_args"] = [exec_path]
            else:
                 # If compilation fails, log and fallback to redirect if strictly needed
                 logger.error(f"Default hello world compilation failed: {res.stderr}")
                 if resp: return resp 
        except Exception as e:
            logger.error(f"Default hello world generation failed: {e}")
            if resp: return resp

    """Render the main gdbgui interface"""
    gdbpid = request.args.get("gdbpid", 0)
    gdb_command = request.args.get("gdb_command", current_app.config["gdb_command"])
    add_csrf_token_to_session()

    # Make 'light' the default theme by listing it first. The frontend
    # uses initial_data.themes[0] as the default when no stored preference
    # exists in localStorage.
    THEMES = ["light", "monokai"]
    initial_data = {
        "csrf_token": session["csrf_token"],
        "gdbgui_version": __version__,
        "gdbpid": gdbpid,
        "gdb_command": gdb_command,
        "initial_binary_and_args": current_app.config["initial_binary_and_args"],
        "project_home": current_app.config["project_home"],
        "remap_sources": current_app.config["remap_sources"],
        "themes": THEMES,
        "signals": SIGNAL_NAME_TO_OBJ,
        "using_windows": USING_WINDOWS,
    }

    import time
    return render_template(
        "gdbgui.html",
        version=__version__ + str(time.time()),
        debug=current_app.debug,
        initial_data=initial_data,
        themes=THEMES,
    )


@blueprint.route("/dashboard_data", methods=["GET"])
@authenticate
def dashboard_data():
    manager = current_app.config.get("_manager")

    return jsonify(manager.get_dashboard_data())


@blueprint.route("/kill_session", methods=["PUT"])
@authenticate
def kill_session():
    from .app import manager

    pid = request.json.get("gdbpid")
    if pid:
        manager.remove_debug_session_by_pid(pid)
        return jsonify({"success": True})
    else:
        return Response(
            "Missing required parameter: gdbpid",
            401,
        )


@blueprint.route("/send_signal_to_pid", methods=["POST"])
def send_signal_to_pid():
    signal_name = request.form.get("signal_name", "").upper()
    pid_str = str(request.form.get("pid"))
    try:
        pid_int = int(pid_str)
    except ValueError:
        return (
            jsonify(
                {
                    "message": "The pid %s cannot be converted to an integer. Signal %s was not sent."
                    % (pid_str, signal_name)
                }
            ),
            400,
        )

    if signal_name not in SIGNAL_NAME_TO_OBJ:
        raise ValueError("no such signal %s" % signal_name)
    signal_value = int(SIGNAL_NAME_TO_OBJ[signal_name])

    try:
        os.kill(pid_int, signal_value)
    except Exception:
        return (
            jsonify(
                {
                    "message": "Process could not be killed. Is %s an active PID?"
                    % pid_int
                }
            ),
            400,
        )
    return jsonify(
        {
            "message": "sent signal %s (%s) to process id %s"
            % (signal_name, signal_value, pid_str)
        }
    )
