import hashlib
import html as _html
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from werkzeug.utils import secure_filename

from .sandbox import jail_manager
from . import blocking

try:
    import requests as _requests
except ImportError:
    _requests = None

from flask import (
    Blueprint,
    abort,
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

from .constants import DEFAULT_GDB_EXECUTABLE, TEMPLATE_DIR, USING_WINDOWS, SIGNAL_NAME_TO_OBJ
from .http_util import (
    add_csrf_token_to_session,
    authenticate,
    client_error,
    csrf_protect,
    current_user_id,
    owner_key,
)
from . import db
from . import tags as tags_module
from .share_function import require_uploaded_binary
from . import lesson_gen
from .prerun import build_gdb_script, parse_prerun_output
import uuid

logger = logging.getLogger(__file__)
blueprint = Blueprint("http_routes", __name__, template_folder=str(TEMPLATE_DIR))

# ── Sandbox 路徑 ──────────────────────────────────────────────────────────────
_SANDBOX_DIR = Path(__file__).parent / "sandbox"
_STUB_C    = _SANDBOX_DIR / "stub.c"
_STUB_O    = _SANDBOX_DIR / "stub.o"
_WRAPPER   = _SANDBOX_DIR / "wrapper.sh"
#: 以 session 帳號讀檔的子行程。契約與理由見 sandbox/read_helper.py。
_READ_HELPER = str(_SANDBOX_DIR / "read_helper.py")

def _upload_root() -> str:
    """所有 session scratch 目錄的根。實際隔離環境下是 jail_manager.SCRATCH_ROOT
    （container-local，刻意不是共用 volume）。"""
    return current_app.config.get("upload_folder") or os.path.join(
        current_app.root_path, "uploads"
    )


def _session_prefix() -> str:
    """本請求的識別字串：既是 owner key（http_util.owner_key），也是 jail 的 key。

    這裡以前會在 Flask session 裡憑空生一個 uuid4（匿名的 `uploaded_prefix`）。
    全站要求登入之後匿名身分不再存在，唯一的身分來源是登入的使用者——所以這個
    函式現在只是 owner_key() 的別名，不再自己造身分。

    只產生一個字串，**不碰 jail_manager**，不建立任何作業系統資源。

    未登入時 abort(401) 而不是回退成匿名：fail closed。理論上到不了這裡
    （全域的 require_login 閘門在前面），這是那個不變式壞掉時的第二道網。
    """
    key = owner_key()
    if not key:
        logger.warning("[authz] refusing to serve a request with no identity")
        abort(401)
    return key


def _session_scratch(create: bool = True):
    """回傳 (prefix, jail, directory)。

    directory 是**這個 session 專屬**的 scratch 目錄：0700、屬於該 session 的
    臨時 OS 帳號。在此之前所有 session 的檔案都平放在同一個 uploads/ 目錄裡，
    只靠亂數檔名分隔——那不是權限，任何使用者程式都能 open() 別人的原始碼與
    binary。目錄權限才是真正的分隔。

    呼叫端要處理 jail_manager.TooManySessions（併發上限）。
    """
    prefix = _session_prefix()

    jail = jail_manager.acquire(prefix) if create else jail_manager.get(prefix)
    if jail is not None:
        return prefix, jail, str(jail.dir)

    # 隔離不可用（本機非 Docker 開發）：退回單純的 per-session 子目錄。
    # 這不是安全邊界，只是保持路徑結構一致。部署時 GDBGUI_REQUIRE_ISOLATION=1
    # 會讓 acquire() 直接拋例外，走不到這裡。
    directory = os.path.join(_upload_root(), prefix)
    os.makedirs(directory, exist_ok=True)
    return prefix, jail, directory


def _too_many_sessions_response():
    return client_error(
        {
            "message": "伺服器同時執行的除錯 session 已達上限，請稍後再試。",
            "stderr": "Server is at its concurrent debug-session limit. Try again shortly.",
        }
    )


def _run_confined(jail, argv, **kwargs):
    """以 session 帳號、在 user+net namespace 內執行 argv。

    編譯器也要進去：g++ 處理的是不可信的原始碼，`#include "/etc/…"` 之類的
    把戲會把檔案內容寫進錯誤訊息裡回傳給使用者。以 session 帳號編譯，讀得到的
    就只有系統上本來就人人可讀的東西，讀不到其他 session 的 scratch。

    走 blocking.run 而不是 subprocess.run：伺服器是 eventlet 單執行緒，直接
    subprocess.run 會把 hub 連同**所有** session 的 GDB 輸出轉發一起卡住
    （理由與量測見 blocking.py）。argv 沒有任何改變，confine() 的隔離照舊。
    """
    return blocking.run(jail_manager.confine(jail, list(argv)), **kwargs)


# ── 以 session 帳號讀檔（/read_file、/get_last_modified_unix_sec）────────────
#
# 為什麼存在、為什麼不是路徑白名單、失敗為什麼一律長同一個樣子：
# 完整說明在 sandbox/read_helper.py 的檔頭。這裡只放伺服器端的驅動。

#: 子行程逾時。正常是幾十毫秒（python 啟動 + 一次掃描）；這是最後一道網，
#: 用來擋 O_NONBLOCK + S_ISREG 沒預期到的阻塞裝置。
_READ_TIMEOUT_SECONDS = 20

#: 兩條檔案路由**唯一**的失敗訊息。
#:
#: 「檔案不存在」與「有這個檔案但你沒權限」必須無法分辨，否則那個任意路徑的
#: 存在性 oracle 只是換個形狀活下來。原本的實作除了區分這兩者，還把使用者送來的
#: path 直接插進訊息裡回去。這裡兩條路由、兩種原因，回的都是同一個 400 加同一句話。
_FILE_UNAVAILABLE_MESSAGE = "File not found or not accessible"


def _file_unavailable():
    return client_error({"message": _FILE_UNAVAILABLE_MESSAGE})


def _running_as_root() -> bool:
    """本行程是不是 root。

    刻意用 euid 而不是 `jail_manager.isolation_available()`：真正的不變式是
    「絕不以 root 的身分替某個請求碰檔案系統」。isolation_available() 在
    「是 root 但少了 setpriv」時會回 False，那條路徑就會悄悄以 root 讀檔——
    正好是要修掉的那個洞。
    """
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


def _child_env() -> dict:
    """給讀檔子行程的乾淨環境變數。

    `jail_manager.confine()` 現在用 `env -i`，所以真正決定子行程環境的是
    `jail_manager.child_environment()`，這裡設的東西在有 jail 時會被丟掉。
    留著它是為了「confine() 回傳原樣 argv」的那條路（jail is None，本機開發）：
    那時 subprocess 的 env= 是唯一的閘門，不設就等於把伺服器整份環境
    （含 NVIDIA_API_KEY / LESSON_AI_API_KEY）交出去。

    這支 helper 一個環境變數都不需要（絕對路徑呼叫、只用標準函式庫、
    自己解碼位元組所以不看 locale），那就一個都不給。
    """
    env = {"PATH": os.defpath}
    for name in ("SYSTEMROOT", "SystemRoot", "COMSPEC"):
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def _resolve_requested_path(path: str) -> str:
    """把前端看到的虛擬 `/workspace/…` 路徑翻回真實路徑。

    翻譯的來源是 Flask session 裡的 real_src_path。那一格曾經是一條跨使用者的
    讀取路徑（見 auth.py 與 tests/test_auth.py：登入時沒清乾淨的話，它指向
    **前一位**使用者的 scratch，而 /read_file 會以 root 把它讀出來）。

    新模型下這一格不再是權限判斷的一部分：不管它指到哪裡，實際的 open 都是以
    **本次請求自己的** session 帳號執行，別人的 scratch 是 0700，一律 EACCES。
    翻譯現在只影響「讀哪個檔」的方便性，不影響「讀不讀得到」。
    """
    virtual = session.get("virtual_src_path")
    real = session.get("real_src_path")
    if virtual and real and path == virtual:
        return real
    return path


def _confined_file_request(
    path: str, want_content: bool = False, start_line: int = 0, end_line: int = 0
):
    """以呼叫者自己的 session OS 帳號 stat／讀取 path，成功回 payload dict。

    **任何**失敗都回 None，呼叫端一律回同一個訊息。

    走 blocking.run（透過 _run_confined）而不是 subprocess.run：伺服器是 eventlet
    單執行緒，同步的 subprocess.run 會連同**所有** session 的 GDB 輸出轉發一起
    卡住（理由與量測見 blocking.py）。

    沒有 jail 就拒絕，**不 acquire**：4c54fc1 才剛把「便宜的請求會建立 OS 帳號」
    這件事拿掉（頁面載入曾經因此耗盡 MAX_SESSIONS）。前端只在 GDB 停下來時才抓
    原始碼，那時 jail 一定在。
    """
    prefix = owner_key()
    if not prefix:
        logger.warning("[read] refusing a file request with no identity")
        return None

    jail = jail_manager.get(prefix)
    if jail is None and _running_as_root():
        logger.warning(
            "[read] refusing to touch the filesystem as root: %s has no live jail",
            prefix[:8],
        )
        return None

    try:
        completed = _run_confined(
            jail,
            [sys.executable or "python3", _READ_HELPER],
            input=json.dumps(
                {
                    "path": path,
                    "want_content": bool(want_content),
                    "start_line": int(start_line),
                    "end_line": int(end_line),
                }
            ),
            capture_output=True,
            text=True,
            timeout=_READ_TIMEOUT_SECONDS,
            env=_child_env(),
        )
    except Exception:
        logger.exception("[read] the confined file helper failed to run")
        return None

    stderr = (completed.stderr or "").strip()[:200]
    if completed.returncode != 0:
        logger.warning("[read] helper exited %s: %s", completed.returncode, stderr)
        return None
    try:
        result = json.loads(completed.stdout)
    except ValueError:
        logger.warning("[read] helper produced unparsable output")
        return None
    if not isinstance(result, dict) or not result.get("ok"):
        logger.info("[read] refused for %s: %s", prefix[:8], stderr)
        return None
    if not isinstance(result.get("mtime"), (int, float)):
        return None
    if want_content and not isinstance(result.get("lines"), list):
        return None
    return result


# ── Layer 2：連結期 --wrap 攔截（stub.c 有對應實作）─────────────────────────
#
# **這不是安全邊界。** 直接下 syscall（inline asm、syscall()、自己組 PLT）就繞過了。
# 保留它的理由是教學：常見的誤用會在連結期就被擋下，並得到一句看得懂的錯誤訊息，
# 而不是執行到一半莫名其妙失敗。
#
# 真正的邊界是 sandbox/jail_manager.py：per-session OS 帳號 + 0700 scratch +
# user/network namespace + seccomp profile + ulimit。安全性的判斷請看那裡，
# 不要因為某個函式出現在這份清單裡就假設它「不可能被呼叫」。
#
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

# ── Layer 1：原始碼 regex 靜態分析 ───────────────────────────────────────────
#
# **這也不是安全邊界。** 巨集拼接、函式指標、inline asm、字串組合都能繞過，
# 而且 regex 本來就看不懂 C++ 語法。它的價值一樣是教學回饋：把常見誤用擋在
# 編譯前，給出中文說明，而不是讓學生對著執行期的怪錯誤發呆。
#
# 邊界是 sandbox/jail_manager.py（見上方 _WRAP_FLAGS 的說明）。
#
# 每個 tuple：(compiled_regex, 說明文字, severity)
# severity = "block" → 連結期 --wrap 也有對應 stub
# severity = "warn"  → 只警告，連結層攔不到（如 ofstream、fopen write mode）

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
        res = blocking.run(
            ["gcc", "-c", str(_STUB_C), "-o", str(_STUB_O)],
            capture_output=True, text=True, timeout=20,
        )
        if res.returncode != 0:
            logger.warning(f"[sandbox] stub compilation failed:\n{res.stderr}")
            return False
        # 編譯是以 session 帳號執行的，stub.o 必須人人可讀才連結得起來
        os.chmod(_STUB_O, 0o644)
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
    將 gTTS MP3 轉為 OGG Vorbis：
      - OGG 無 MP3 encoder delay，開頭不會被截掉
      - 檔案更小（約 -20%）

    轉檔用 mpg123 解碼成 WAV 再用 oggenc 編碼，而不是 ffmpeg。ffmpeg 為了硬體
    影像加速會相依 mesa 與 libllvm，在這個 image 裡多帶約 190 MB 完全用不到的
    東西；mpg123 + vorbis-tools 加起來只有幾 MB，輸出的 OGG 相同。
    兩個工具任一不存在時回退使用原始 MP3。
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

    # 嘗試轉 OGG（無 encoder delay）：mpg123 解碼 → oggenc 編碼，走 stdout/stdin
    # 串接，不落地中間的 WAV。任一工具缺席就靜靜回退 MP3。
    if not ogg_path.exists():
        tmp_ogg = ogg_path.with_suffix(".ogg.tmp")
        try:
            decode = blocking.run(
                ["mpg123", "-q", "-w", "-", str(mp3_path)],
                capture_output=True, timeout=15
            )
            if decode.returncode == 0 and decode.stdout:
                encode = blocking.run(
                    ["oggenc", "-Q", "-q", "3", "-o", str(tmp_ogg), "-"],
                    input=decode.stdout, capture_output=True, timeout=15
                )
                # 只有整條鏈成功才 rename 就位，避免半成品被當成快取命中
                if encode.returncode == 0 and tmp_ogg.exists() and tmp_ogg.stat().st_size > 0:
                    tmp_ogg.replace(ogg_path)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass  # mpg123 / oggenc 不存在，回退 MP3
        finally:
            tmp_ogg.unlink(missing_ok=True)

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

        # 本 session 專屬 scratch 目錄（0700，屬於本 session 的臨時 OS 帳號）
        try:
            prefix, jail, upload_dir = _session_scratch()
        except jail_manager.TooManySessions:
            return _too_many_sessions_response()
        except jail_manager.JailError:
            logger.exception("[jail] could not establish execution isolation")
            return client_error({"message": "無法建立執行隔離環境，已拒絕上傳。"})

        # store file with session prefix.
        # 用 O_NOFOLLOW 開檔而不是 uploaded.save(path)：檔名有一部分來自使用者，
        # 而 scratch 目錄是那個不可信 session 使用者可寫的 —— 他可以先在這個路徑
        # 放一條 symlink，讓 root 的寫入跑到 /etc 底下去。
        stored_filename = f"{prefix}_{filename}"
        dest_path = os.path.join(upload_dir, stored_filename)
        try:
            fd = os.open(
                dest_path,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                0o600,
            )
            with os.fdopen(fd, "wb") as f:
                uploaded.save(f)
        except OSError as e:
            return client_error({"message": "Failed to store upload", "detail": str(e)})
        jail_manager.chown_to_session(dest_path, jail, 0o600)

        name, ext = os.path.splitext(stored_filename)
        ext = ext.lower()

        # If C/C++ source -> compile to executable (g++ a.cpp -o a.a -g)
        if ext in (".c", ".cpp", ".cc", ".cxx", ".c++"):
            exec_filename = name + ".a"  # will produce e.g. a.a like your example
            exec_path = os.path.join(upload_dir, exec_filename)
            # choose compiler: prefer g++ for .cpp, gcc for .c (can be overridden via config)
            compiler = current_app.config.get("c_compiler") or ("g++" if ext != ".c" else "gcc")
            try:
                res = _run_confined(
                    jail,
                    [compiler, "-g", "-O0", "-no-pie", dest_path, "-o", exec_path],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if res.returncode != 0:
                    return client_error(
                        {"message": "Compilation failed", "stderr": res.stderr}
                    )
                # ensure executable permission
                try:
                    os.chmod(exec_path, 0o700)
                except Exception:
                    # non-fatal; proceed even if chmod fails
                    pass
            except FileNotFoundError:
                return client_error(
                    {"message": f"Compiler not found: {compiler}. Install it or set app.config['c_compiler']"}
                )
            except Exception as e:
                return client_error({"message": str(e)})

            # 只寫進 session。app.config["initial_binary_and_args"] 是 process 全域，
            # 保留給 CLI 啟動時帶進來的 binary；網頁編譯不再碰它（見 gdbgui() 的註解）。
            session["uploaded_binary"] = exec_path
        # If assembly uploaded (or other), use it directly
        else:
            session["uploaded_binary"] = dest_path

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

    # 本 session 專屬的 scratch 目錄（0700，屬於本 session 的臨時 OS 帳號）
    try:
        prefix, jail, upload_dir = _session_scratch()
    except jail_manager.TooManySessions:
        return _too_many_sessions_response()
    except jail_manager.JailError:
        logger.exception("[jail] could not establish execution isolation")
        return client_error({"message": "無法建立執行隔離環境，已拒絕編譯。"})

    _session_dir_abs = os.path.realpath(upload_dir)

    # 安全性檢查：只允許覆寫**本 session 自己** scratch 目錄內的既有檔案。
    # 以前這裡只檢查「在 uploads 根目錄底下」，所以帶著別人的路徑就能覆寫
    # 其他 session 的原始碼；現在比對的是本 session 的目錄。
    _filepath_safe = False
    if filepath:
        _filepath_abs = os.path.realpath(filepath)
        if _filepath_abs.startswith(_session_dir_abs + os.sep) and os.path.exists(
            _filepath_abs
        ):
            _filepath_safe = True

    if _filepath_safe:
        src_path = _filepath_abs
        ext = os.path.splitext(src_path)[1]
        stored_filename = os.path.basename(src_path)
    else:
        # Fallback to auto-generate a unique filename for the pasted source
        filename = f"pasted_{uuid.uuid4().hex}.cpp"
        ext = ".cpp"
        stored_filename = f"{prefix}_{filename}"
        src_path = os.path.join(upload_dir, stored_filename)

    try:
        # 檔案由伺服器（root）寫入，但編譯器與 GDB 以 session 帳號執行，
        # 交出所有權它們才讀得到。write_session_file 用 O_NOFOLLOW —— scratch
        # 目錄是那個不可信使用者可寫的，普通 open() 會被 symlink 導去別的地方。
        jail_manager.write_session_file(src_path, code, jail, 0o600)
    except Exception as e:
        return client_error({"message": "Failed to write source file", "detail": str(e)})

    # Virtual path shown to users (hides real filesystem layout)
    _vfilename = "main.cpp" if not _filepath_safe else os.path.basename(src_path)
    virtual_src_path = f"/workspace/{_vfilename}"
    session["virtual_src_path"] = virtual_src_path
    session["real_src_path"] = src_path

    binary_path_result = None
    sandbox_warnings = []  # 靜態分析警告，回傳給前端

    # If C/C++ source -> compile to executable
    if ext.lower() in (".c", ".cpp", ".cc", ".cxx", ".c++"):
        # ── 靜態分析：偵測危險呼叫 ────────────────────────────────────────
        detected = _check_dangerous_code(code)
        block_items = [item for item in detected if item["severity"] == "block"]
        warn_items  = [item for item in detected if item["severity"] == "warn"]

        if block_items:
            # 封鎖類直接中止，回傳 EPERM 並拒絕編譯
            lines = ["安全政策封鎖（EPERM）：偵測到以下危險函式呼叫，編譯已中止："]
            lines += [f"  • {item['desc']}" for item in block_items]
            logger.warning(f"[sandbox] BLOCKED compilation: {[i['desc'] for i in block_items]}")
            return client_error({
                "message": "Compilation blocked by security policy (EPERM)",
                "stderr": "\n".join(lines),
            })

        for item in warn_items:
            sandbox_warnings.append(
                f"[sandbox:警告] {item['desc']}（連結層無法攔截，請注意使用）"
            )
        if warn_items:
            logger.info(f"[sandbox] warnings: {[i['desc'] for i in warn_items]}")

        # ── 編譯 stub.o（若尚未編譯）──────────────────────────────────────
        stub_available = _ensure_stub_compiled()

        name_only, _ = os.path.splitext(stored_filename)
        exec_filename = name_only + ".a"
        exec_path = os.path.join(upload_dir, exec_filename)
        compiler = current_app.config.get("c_compiler") or ("g++" if ext.lower() != ".c" else "gcc")

        compile_cmd = [compiler, "-g", "-O0", "-no-pie", src_path, "-o", exec_path]
        if stub_available:
            compile_cmd += [str(_STUB_O)] + _WRAP_FLAGS

        try:
            res = _run_confined(
                jail, compile_cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if res.returncode != 0:
                # 若加入 stub 導致失敗（少數情況），降級重試（不含 stub 連結層）
                if stub_available:
                    logger.warning("[sandbox] compile with stub failed, retrying without link-time stubs")
                    res2 = _run_confined(
                        jail, [compiler, "-g", "-O0", "-no-pie", src_path, "-o", exec_path],
                        capture_output=True, text=True, timeout=30,
                    )
                    if res2.returncode != 0:
                        return client_error({"message": "Compilation failed", "stderr": res2.stderr.replace(src_path, virtual_src_path)})
                    sandbox_warnings.append("[sandbox] 連結層攔截失敗，已改以一般模式編譯（請告知管理員）")
                else:
                    return client_error({"message": "Compilation failed", "stderr": res.stderr.replace(src_path, virtual_src_path)})
            try:
                os.chmod(exec_path, 0o700)
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

        # exec-wrapper 只做 ulimit（sandbox/wrapper.sh）。降權與 namespace 隔離
        # 由 jail_manager 在更外層完成——GDB 自己就在裡面跑，因為跨 uid /
        # 跨 user namespace 的 ptrace 加了 CAP_SYS_PTRACE 也不會動。
        session["exec_wrapper"] = str(_WRAPPER)

    else:
        # non-C source: just register the source file as uploaded_binary
        session["uploaded_binary"] = src_path
        binary_path_result = src_path

    # Write the program input to a .in file
    input_filename = f"{prefix}_input.in"
    input_path = os.path.join(upload_dir, input_filename)
    try:
        # 被除錯的程式（session 帳號）要能讀這個 stdin 檔
        jail_manager.write_session_file(input_path, program_input, jail, 0o600)
    except Exception as e:
        logger.warning(f"Failed to write input file: {e}")

    session["uploaded_input"] = input_path

    if request.headers.get("Accept") == "application/json":
        import secrets as _secrets
        run_token = _secrets.token_hex(16)
        session["run_token"] = run_token
        # Store in SessionManager so WebSocket handlers can validate without cookie-session lag.
        _manager = current_app.config.get("_manager")
        if _manager is not None:
            _manager.run_tokens[session.get("csrf_token", "")] = run_token

        return jsonify({
            "status": "success",
            "binary_path": binary_path_result,
            "source_path": virtual_src_path,       # virtual /workspace path (display only)
            "gdb_source_path": src_path,           # real filesystem path (used for GDB operations)
            "input_path": input_path,
            "exec_wrapper": session.get("exec_wrapper"),
            "gdb_subst_cmd": f"set substitute-path {src_path} {virtual_src_path}",
            "sandbox_warnings": sandbox_warnings,
            "run_token": run_token,
        })

    return redirect(url_for(".gdbgui"))






@blueprint.route("/read_file", methods=["GET"])
@csrf_protect
def read_file():
    """Read a file and return its contents as an array.

    每一次檔案系統接觸都在 `_confined_file_request` 裡、以**呼叫者自己的**
    session OS 帳號執行。這條路由自己不再 stat、不再 open——它以前兩件事都以
    root 做，而 path 直接來自 request.args。理由與實測見 sandbox/read_helper.py。

    語意刻意與原本逐項對齊（前端的捲動與快取是照這些數字算的）：
    num_lines_in_file 沿用 `split("\\n")` 的行數、end_line 夾到檔案長度、
    回傳範圍內的空行換成一個空白（否則 lexer 會把它吃掉、行號就對不上）。
    """

    def should_highlight():
        try:
            return json.loads(request.args.get("highlight", "true"))
        except Exception as e:
            if current_app.debug:
                print("Raising exception since debug is on")
                raise e

            else:
                return True  # highlight argument was invalid for some reason, default to true

    path = request.args.get("path") or ""
    try:
        start_line = max(1, int(request.args.get("start_line")))  # make sure it's not negative
        end_line = int(request.args.get("end_line"))
    except (TypeError, ValueError):
        # 以前少一個參數會直接 500（未捕捉的 TypeError）。回一般的拒絕訊息，
        # 不讓「參數壞掉」與「檔案讀不到」變成兩種可分辨的結果。
        return _file_unavailable()

    payload = _confined_file_request(
        _resolve_requested_path(path),
        want_content=True,
        start_line=start_line,
        end_line=end_line,
    )
    if payload is None:
        return _file_unavailable()

    num_lines_in_file = payload["num_lines"]
    end_line = min(num_lines_in_file, end_line)  # make sure we don't try to go too far

    # if leading lines are '', then the lexer will strip them out, but we want
    # to preserve blank lines. Insert a space whenever we find a blank line.
    lines_of_interest = [line if line != "" else " " for line in payload["lines"]]

    try:
        # 只看副檔名，不碰檔案系統。刻意用呼叫端送來的 path 而不是翻譯後的真實
        # 路徑——兩者副檔名一樣，而真實路徑不必要地帶著 scratch 目錄名。
        lexer = get_lexer_for_filename(path)
    except Exception:
        lexer = None

    if lexer and should_highlight():
        highlighted = True
        # convert string into tokens
        tokens = lexer.get_tokens("\n".join(lines_of_interest))
        # format tokens into nice, marked up list of html
        formatter = (
            htmllistformatter.HtmlListFormatter()
        )  # Don't add newlines after each line
        source_code = formatter.get_marked_up_list(tokens)
    else:
        highlighted = False
        source_code = [_html.escape(line) for line in lines_of_interest]

    return jsonify(
        {
            "source_code_array": source_code,
            # 回呼叫端自己送來的路徑。以前這裡回的是翻譯後的真實路徑，
            # 等於把 scratch 目錄名（含 session 身分）送回前端；前端也沒在用它。
            "path": path,
            "last_modified_unix_sec": payload["mtime"],
            "highlighted": highlighted,
            "start_line": start_line,
            "end_line": end_line,
            "num_lines_in_file": num_lines_in_file,
        }
    )


@blueprint.route("/get_last_modified_unix_sec", methods=["GET"])
@csrf_protect
def get_last_modified_unix_sec():
    """Get last modified unix time for a given file.

    以前這條路由整個就只是 `os.path.isfile` + `os.path.getmtime`，兩者都以 root
    執行、path 直接來自 request.args——也就是一個純粹的任意路徑存在性與修改時間
    oracle。現在它和 /read_file 走同一條降權路徑，可及範圍完全相同。
    """
    path = request.args.get("path") or ""
    payload = _confined_file_request(_resolve_requested_path(path))
    if payload is None:
        return _file_unavailable()
    # path 回的是呼叫端自己送來的那個字串：前端拿它跟 inferior_binary_path 比對。
    return jsonify({"path": path, "last_modified_unix_sec": payload["mtime"]})


@blueprint.route("/help")
def help_route():
    return redirect("https://github.com/cs01/gdbgui/blob/master/HELP.md")


@blueprint.route("/docs/authoring-guide")
def authoring_guide():
    # 給 AI agent / 老師取用的教案撰寫指南，回傳原始 markdown。
    # 全站要求登入之後這條也需要登入（不在 PUBLIC_ENDPOINTS 裡）——豁免清單
    # 只有登入流程本身與靜態資源，其餘一律預設拒絕。
    # root_path 是 gdbgui/server（app 建立於 gdbgui.server），repo root 在上兩層
    p = Path(current_app.root_path).parents[1] / "AUTHORING_GUIDE.md"
    if not p.exists():
        return "AUTHORING_GUIDE.md not found", 404
    return (
        p.read_text(encoding="utf-8"),
        200,
        {"Content-Type": "text/markdown; charset=utf-8"},
    )


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
        gdbgui_sessions=manager.get_dashboard_data(owner_key=owner_key()),
        csrf_token=session["csrf_token"],
        default_command=current_app.config["gdb_command"],
    )


# 除錯器。以前掛在 "/"；主頁讓給教案瀏覽之後搬到這裡。
# endpoint 名稱刻意維持 "gdbgui"——模板裡既有的 url_for('http_routes.gdbgui')
# 因此自動指向 /edit，不必逐一改呼叫端。
@blueprint.route("/edit", methods=["GET"])
@authenticate
def gdbgui():
    # ── 這條路徑刻意**不**碰 jail_manager ────────────────────────────────────
    #
    # 以前它無條件 jail_manager.acquire()（再加上「session 裡沒有 binary 就當場
    # 編一支預設 hello world」），所以單純打開一個頁面就會建立一個臨時 OS 帳號
    # 與 scratch 目錄，而且要等 IDLE_TIMEOUT_SECONDS（3600 秒）閒置回收才會還。
    # 不必登入、不必開 websocket、不必跑任何程式：GDBGUI_MAX_SESSIONS 次
    # GET / 就把所有人的併發額度吃光——一個 pre-auth 的 DoS。
    #
    # 渲染這一頁真正需要的只有身分（＝jail 的 key），而那現在直接就是登入的
    # 使用者，連產生字串都不必。jail 改成在真的要用時才建立，那些路徑本來就
    # 已經是這樣做的：
    #   /upload、/create_and_upload（要編譯）與 websocket connect（要起 GDB）。
    # 身分跟著使用者走，所以 websocket 那端 acquire() 得到的必然是同一個
    # key 的 jail。
    _session_prefix()

    # session 裡記的 binary 可能已經隨著上一個 jail 被回收而消失（scratch 是
    # 暫存，session 結束或閒置逾時就整個刪掉）。留著一個指向不存在檔案的路徑
    # 只會讓前端拿它去餵 GDB 然後噴錯，直接清掉，讓 UI 回到「還沒編譯」的乾淨
    # 狀態即可——重新編譯本來就是使用者的下一個動作。
    #
    # 這裡以前是「當場編一支預設 hello world」，那正是頁面渲染會取得 jail 的
    # 原因；預設樣板由前端 Monaco 提供，伺服器不需要為了它 fork 一個編譯器。
    bin_path = session.get("uploaded_binary")
    if bin_path and not os.path.exists(bin_path):
        logger.info("[session] uploaded binary is gone; clearing stale session paths")
        for key in ("uploaded_binary", "uploaded_input", "real_src_path", "virtual_src_path"):
            session.pop(key, None)

    """Render the main gdbgui interface"""
    gdbpid = request.args.get("gdbpid", 0)
    gdb_command = request.args.get("gdb_command", current_app.config["gdb_command"])
    add_csrf_token_to_session()

    # Make 'light' the default theme by listing it first. The frontend
    # uses initial_data.themes[0] as the default when no stored preference
    # exists in localStorage.
    THEMES = ["light", "monokai"]
    # 優先用**這個 session 自己的** binary。app.config["initial_binary_and_args"]
    # 是 process 全域的，現在只剩一個來源：CLI 起 gdbgui 時帶的參數（cli.py）。
    # 網頁上傳／編譯過去也會寫它，於是任何一次編譯都會把該使用者的 scratch 路徑
    # （路徑裡含他的 session id）留給下一個載入頁面的陌生人。那些寫入已經移除，
    # 因為每個寫入點旁邊本來就有等價的 session["uploaded_binary"]。
    # 所以這個 fallback 現在只會回到「部署者自己在命令列指定的 binary」，
    # 那是部署設定、不是別的使用者的資料。
    _session_binary = session.get("uploaded_binary")
    initial_data = {
        "csrf_token": session["csrf_token"],
        "gdbgui_version": __version__,
        "gdbpid": gdbpid,
        "gdb_command": gdb_command,
        "initial_binary_and_args": (
            [_session_binary]
            if _session_binary
            else current_app.config["initial_binary_and_args"]
        ),
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

    return jsonify(manager.get_dashboard_data(owner_key=owner_key()))


@blueprint.route("/kill_session", methods=["PUT"])
@authenticate
def kill_session():
    from .app import manager

    pid = request.json.get("gdbpid")
    if not pid:
        return Response(
            "Missing required parameter: gdbpid",
            401,
        )

    # 沒有擁有者檢查的話，任何人都能用可列舉的小整數 pid 殺掉別人正在跑的
    # GDB。回應不區分「不存在」與「不是你的」，理由同 attach 那條路徑。
    debug_session = manager.debug_session_from_pid(pid)
    if debug_session is None or not debug_session.is_owned_by(owner_key()):
        logger.warning(
            "[authz] refused kill of gdbpid %s (session exists: %s)",
            pid,
            debug_session is not None,
        )
        return jsonify({"success": True})

    manager.remove_debug_session(debug_session)
    return jsonify({"success": True})


#: 訊號端點**唯一**的拒絕訊息。理由與 sessionmanager.ATTACH_REFUSED_MESSAGE
#: 相同：只要「沒有 session」「目標還沒起來」「那個 pid 不是你的」「行程已經
#: 結束」之間有任何可觀察的差別，這個端點就變成一台探測機。全部同形。
SIGNAL_REFUSED_MESSAGE = "No signal was sent."

#: 呼叫端唯一能指定的東西：**哪一個**目標。pid 一律由伺服器解析。
SIGNAL_TARGETS = ("gdb", "inferior")


def _signal_refused():
    return jsonify({"message": SIGNAL_REFUSED_MESSAGE}), 400


def _pid_owner_uid(pid: int):
    """/proc/<pid> 的擁有者 uid（＝該行程的有效 uid）；查不到回 None。"""
    try:
        return os.stat(f"/proc/{pid}").st_uid
    except OSError:
        return None


@blueprint.route("/send_signal", methods=["POST"])
@authenticate
def send_signal():
    """對**呼叫者自己的** GDB 或被除錯程式送訊號。

    這裡以前是 /send_signal_to_pid：從 form 讀一個 pid、轉成 int，然後以容器內
    的 root 執行 os.kill()。沒有 @authenticate，沒有擁有者檢查。任何有 session
    的人都能對 PID 1（tini）、gdbgui 伺服器自己、或別人的 GDB 與別人正在跑的
    程式送任意訊號——公開註冊的部署上這是直接的服務中斷與跨使用者干擾。

    修法不是「驗證使用者送上來的 pid」，而是**不讓呼叫端送 pid**：
    請求只能指名目標的種類（gdb / inferior），pid 由伺服器從呼叫者擁有的
    debug session 解析。使用者能表達的東西裡不再存在「別人的 pid」這個值，
    整類漏洞就消失了，而不是在它旁邊多加一層檢查。

    三道關卡，全部 fail closed：
      1. 目標名稱必須在 SIGNAL_TARGETS 白名單內（pid 不可由請求提供）。
      2. debug session 必須存在且屬於 owner_key()（同一個身分來源、同一個
         is_owned_by 原語，與 attach / kill 一致）。
      3. 解析出來的 pid 現在必須真的屬於這個 session 的 OS 帳號。
         第 3 點是深度防禦：gdb pid 是伺服器自己 fork 的可以信任，但 inferior
         pid 來自 GDB 的 MI 串流，而使用者可以在 GDB console 打任意指令；
         有隔離時每個 session 一個 uid，所以 root 的行程（PID 1、伺服器本身）
         與別的 session 的行程都不可能通過這一關。
    """
    from .app import manager

    signal_name = request.form.get("signal_name", "").upper()
    target = request.form.get("target", "")

    if signal_name not in SIGNAL_NAME_TO_OBJ or target not in SIGNAL_TARGETS:
        logger.warning(
            "[authz] refused signal request (signal=%r target=%r)", signal_name, target
        )
        return _signal_refused()

    debug_session = manager.debug_session_from_owner(owner_key())
    if debug_session is None:
        logger.warning("[authz] refused signal: caller owns no live debug session")
        return _signal_refused()

    pid = debug_session.pid if target == "gdb" else debug_session.inferior_pid
    if not pid or pid <= 1:
        logger.warning("[authz] refused signal: no live %s to signal", target)
        return _signal_refused()

    jail = jail_manager.get(debug_session.jail_key) if debug_session.jail_key else None
    if jail is not None:
        expected_uid = jail.uid
    else:
        # 沒有隔離＝本機單一使用者的開發模式（部署時 GDBGUI_REQUIRE_ISOLATION=1
        # 會讓 GDB 根本起不來，見 sessionmanager.add_new_debug_session）。
        # 那時候所有東西都跟伺服器同一個 uid，這一關檢不出東西，但也不放行
        # 任何「不是伺服器 uid」的行程。geteuid 不存在（Windows）就直接拒絕。
        geteuid = getattr(os, "geteuid", None)
        expected_uid = geteuid() if geteuid is not None else None

    if expected_uid is None or _pid_owner_uid(pid) != expected_uid:
        logger.warning(
            "[authz] refused signal to pid %s: not owned by this session's account", pid
        )
        return _signal_refused()

    signal_value = int(SIGNAL_NAME_TO_OBJ[signal_name])
    try:
        os.kill(pid, signal_value)
    except OSError:
        logger.warning("[signal] os.kill(%s, %s) failed", pid, signal_value)
        return _signal_refused()

    # 回應刻意不含 pid：使用者不需要它，而回音出去只是把剛剛拿掉的那個
    # 「pid 是可觀察的」的性質再送回去。
    return jsonify(
        {"message": f"sent signal {signal_name} ({signal_value}) to {target}"}
    )


# ── AI 錯誤解釋 ───────────────────────────────────────────────────────────────

_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
_NVIDIA_MODEL    = "meta/llama-3.3-70b-instruct"

@blueprint.route("/api/explain_error", methods=["POST"])
@authenticate
def explain_error():
    """接收編譯錯誤列表與原始碼，呼叫 NVIDIA NIM API 回傳繁體中文解釋。"""
    if _requests is None:
        return jsonify({"error": "伺服器缺少 requests 套件，請執行 pip install requests"}), 500

    api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not api_key:
        return jsonify({"error": "伺服器尚未設定 NVIDIA_API_KEY 環境變數"}), 503

    body = request.get_json(silent=True) or {}
    errors  = body.get("errors",  [])
    source  = body.get("source",  "")
    language = body.get("language", "C++")

    if not errors:
        return jsonify({"error": "沒有錯誤資訊可分析"}), 400

    error_block = "\n".join(
        f"第 {e.get('line','?')} 行｜[{e.get('severity','error')}] {e.get('message','')}"
        for e in errors
    )

    prompt = (
        f"你是一位 {language} 教學助理，請用繁體中文回答。\n"
        f"學生的程式發生以下編譯錯誤：\n\n"
        f"{error_block}\n\n"
        f"學生的原始碼如下：\n```{language}\n{source}\n```\n\n"
        "請對每一個錯誤：\n"
        "1. 用簡單易懂的話解釋錯誤原因\n"
        "2. 提供修正方式（必要時附上修正後的程式碼片段）\n\n"
        "回答請簡潔，適合初學者閱讀。"
    )

    try:
        resp = _requests.post(
            f"{_NVIDIA_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": _NVIDIA_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1024,
                "temperature": 0.3,
            },
            timeout=30,
        )
    except Exception as e:
        return jsonify({"error": f"呼叫 NVIDIA API 失敗：{e}"}), 502

    if resp.status_code != 200:
        return jsonify({"error": f"NVIDIA API 回傳錯誤 {resp.status_code}：{resp.text[:300]}"}), 502

    try:
        explanation = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        return jsonify({"error": f"解析 API 回應失敗：{e}"}), 502

    return jsonify({"explanation": explanation})


# ── AI 生成教案 ──────────────────────────────────────────────────────────────

def _as_str(value) -> str:
    """把 JSON body 欄位安全轉成 str。

    request.get_json() 的欄位型別完全由呼叫端決定（例如攻擊者可送
    {"base_url": 123} 或 {"model": ["x"]}），而 lesson_gen 的函式
    （validate_base_url / resolve_api_key / build_messages 的 instruction 參數）
    內部呼叫 .strip()，只假設輸入是 str 或 None。若直接把非 str 值傳進去，
    "truthy 非 str" 的值（如整數 123、非空 list）會在 .strip() 上丟出
    AttributeError，變成未預期的 500 而非乾淨的 400。
    這裡 fail-closed：非 str 一律視為空字串 ""，交由下游各自的空值分支處理
    （validate_base_url("") → 預設 URL；resolve_api_key 空字串 → 略過該來源；
    build_messages 空 instruction → 不附加額外指示）。
    """
    return value if isinstance(value, str) else ""


@blueprint.route("/api/generate_lesson", methods=["POST"])
@authenticate
def generate_lesson():
    """把 .cpp 原始碼與教案指南送給 OpenAI 相容模型，回傳帶 //@ 註解的版本。"""
    if _requests is None:
        return jsonify({"message": "伺服器缺少 requests 套件，請執行 pip install requests"}), 500

    body = request.get_json(silent=True) or {}
    source = body.get("source", "")
    if not isinstance(source, str) or not source.strip():
        return jsonify({"message": "source 不可為空"}), 400
    if len(source.encode("utf-8")) > lesson_gen.MAX_SOURCE_BYTES:
        return jsonify({"message": "原始碼超過 100 KB 上限"}), 400

    base_url = lesson_gen.validate_base_url(_as_str(body.get("base_url", "")))
    if base_url is None:
        return jsonify({"message": "base_url 僅允許 https://"}), 400
    model = _as_str(body.get("model")).strip() or lesson_gen.DEFAULT_MODEL
    request_api_key = _as_str(body.get("api_key", "")).strip()
    if request_api_key:
        api_key = request_api_key
    elif lesson_gen.env_key_allowed(base_url):
        api_key = lesson_gen.resolve_api_key("", os.environ)
    else:
        # 自訂（非預設）base_url 一律不得退回伺服器環境變數 key，
        # 否則攻擊者可把伺服器金鑰以 Bearer 送到任意主機（金鑰外洩）。
        return jsonify({
            "message": "自訂 base_url 需在面板填入自己的 API key（伺服器金鑰僅限預設服務使用）"
        }), 400
    if not api_key:
        return jsonify(
            {"message": "未提供 API key：請在面板填入，或於伺服器設定 LESSON_AI_API_KEY / NVIDIA_API_KEY"}
        ), 400

    guide_path = Path(current_app.root_path).parents[1] / "AUTHORING_GUIDE.md"
    if not guide_path.exists():
        return jsonify({"message": "伺服器找不到 AUTHORING_GUIDE.md"}), 500
    guide_md = guide_path.read_text(encoding="utf-8")

    try:
        resp = _requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": lesson_gen.build_messages(
                    guide_md, source, _as_str(body.get("instruction", ""))
                ),
                "max_tokens": 4096,
                "temperature": 0.3,
            },
            timeout=120,
        )
    except Exception as e:
        return jsonify({"message": f"呼叫模型 API 失敗：{e}"}), 502

    if resp.status_code != 200:
        return jsonify({"message": f"模型 API 回傳 {resp.status_code}：{resp.text[:300]}"}), 502

    try:
        raw = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        return jsonify({"message": f"解析模型回應失敗：{e}"}), 502

    code = lesson_gen.strip_code_fences(raw)
    if not code.strip():
        return jsonify({"message": "模型未輸出程式碼"}), 502
    return jsonify({"code": code})


# ── Ghost pre-run：批次 gdb 呼叫樹快照 ────────────────────────────────────────

PRERUN_TIMEOUT_SECONDS = 15
PRERUN_MAX_STDOUT_BYTES = 2_000_000
PRERUN_MAX_CONCURRENT = 2

# 併發防護（DoS 緩解）：
#   1. per-session lock -- 同一 session 不能同時打兩個 prerun 請求（避免同一使用者
#      用多分頁/重複點擊疊加出多個 gdb 行程）。
#   2. 全域 BoundedSemaphore -- 不論多少個不同 session，同時最多只有
#      PRERUN_MAX_CONCURRENT 個 gdb batch 行程在跑（避免多 session 聯手把伺服器
#      的 CPU/記憶體耗盡）。
# 兩者皆用 acquire(blocking=False)：拿不到就立刻回 busy，絕不讓 request 排隊等待
# （排隊本身就是另一種資源耗盡面）。
_prerun_session_locks: "dict[str, threading.Lock]" = {}
_prerun_session_locks_guard = threading.Lock()
_prerun_global_semaphore = threading.BoundedSemaphore(PRERUN_MAX_CONCURRENT)


def _acquire_prerun_slot(prefix: str) -> bool:
    """Non-blocking acquire of the per-session lock + global concurrency
    semaphore. Returns True if both were acquired (caller MUST call
    _release_prerun_slot(prefix) in a finally block), False if either is
    busy (in which case nothing was acquired -- no cleanup needed)."""
    with _prerun_session_locks_guard:
        session_lock = _prerun_session_locks.get(prefix)
        if session_lock is None:
            session_lock = threading.Lock()
            _prerun_session_locks[prefix] = session_lock

    if not session_lock.acquire(blocking=False):
        return False

    if not _prerun_global_semaphore.acquire(blocking=False):
        session_lock.release()
        return False

    return True


def _release_prerun_slot(prefix: str) -> None:
    _prerun_global_semaphore.release()
    with _prerun_session_locks_guard:
        session_lock = _prerun_session_locks.pop(prefix, None)
    if session_lock is not None:
        session_lock.release()


@blueprint.route("/api/prerun_calltree", methods=["POST"])
@authenticate
def prerun_calltree():
    """在 `gdb --batch` 下重跑本 session 已編譯的 binary 一次，蒐集完整呼叫樹快照。

    安全設計（威脅模型見 task-1-report.md）：
      - 完全不讀取 request body / query string 任何欄位；所有輸入只來自
        server-side session 狀態（uploaded_binary / real_src_path /
        exec_wrapper / uploaded_input）與登入身分（owner_key），避免攻擊者透過
        任意參數指定要執行的 binary 或注入 gdb 腳本內容。
      - binary 必須存在、realpath 必須落在**本 session 自己的 scratch 目錄**內、
        檔名必須以本 session 的 owner key + "_" 開頭 -- 防止透過 session
        竄改或路徑穿越去執行別的 session / 系統上任意的可執行檔。
      - gdb 以本 session 的臨時 OS 帳號、在 user+net namespace 內執行
        （_run_confined）；exec-wrapper 額外套用 ulimit 資源限制。
      - build_gdb_script 對 session 狀態做字元 allowlist/denylist 驗證，壞值
        直接 ValueError -> invalid_session_state，絕不把未驗證字串餵給 gdb。
      - subprocess 逾時 15 秒即視為失敗（timeout 逾時 Python 會自動 kill 該行程）。
      - gdb stdout 直接導向暫存檔（stderr 導向 DEVNULL），行程結束後只從檔案讀取
        前 2MB 才解析 -- 從不把整條 pipe/檔案讀進記憶體，避免一直不撞到使用者
        函式中斷點的失控子行程把記憶體撐爆。
      - per-session lock + 全域 BoundedSemaphore(2) 限制併發 gdb 行程數量。
      - 任何失敗一律回傳 {"ok": false, "reason": <分類字串>}，never 內含檔案路徑。
    """
    binary = session.get("uploaded_binary")
    src = session.get("real_src_path")
    # 身分只從 owner_key() 來（登入的使用者），不從 session 裡另一格自己記的
    # 字串來——兩個來源就會有一天對不齊，而對不齊的那一天就是授權漏洞。
    prefix = owner_key() or ""

    # 只認本 session 自己的 scratch 目錄（不建立新的：沒有就是沒有）
    jail = jail_manager.get(prefix) if prefix else None
    if jail is not None:
        session_dir = str(jail.dir)
    else:
        session_dir = os.path.join(_upload_root(), prefix) if prefix else ""

    if (
        not binary
        or not src
        or not prefix
        or not os.path.isfile(binary)
        or not os.path.realpath(binary).startswith(os.path.realpath(session_dir) + os.sep)
        or not os.path.basename(binary).startswith(prefix + "_")
    ):
        return jsonify({"ok": False, "reason": "no_binary"}), 200

    input_path = session.get("uploaded_input")
    if not input_path or not os.path.isfile(input_path):
        input_path = None

    try:
        script = build_gdb_script(
            os.path.basename(src),
            session.get("exec_wrapper"),
            input_path,
        )
    except ValueError:
        logger.warning("[prerun] rejected invalid session state building gdb script")
        return jsonify({"ok": False, "reason": "invalid_session_state"}), 200

    if not _acquire_prerun_slot(prefix):
        return jsonify({"ok": False, "reason": "busy"}), 200

    gdb_exe = current_app.config.get("gdb_path") or DEFAULT_GDB_EXECUTABLE

    script_path = None
    stdout_path = None
    error_reason = None
    raw_stdout = b""

    try:
        # 腳本要放在本 session 的 scratch 目錄並交給 session 帳號 —— GDB 以該
        # 帳號執行，讀不到 root 在 /tmp 建的 0600 檔案。
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, dir=session_dir or None
        ) as tf:
            tf.write(script)
            script_path = tf.name
        jail_manager.chown_to_session(script_path, jail, 0o600)

        # gdb's stdout is written directly to this file by the OS (subprocess
        # dup2's the fd into the child) -- Python never buffers the full
        # output in memory, no matter how much the inferior prints before
        # ever hitting a user-function breakpoint. stderr is discarded.
        with tempfile.NamedTemporaryFile(suffix=".stdout", delete=False) as stdout_f:
            stdout_path = stdout_f.name
            try:
                # GDB 一樣進 session 帳號 + user/net namespace。
                # stdout 走的是繼承的 fd，所以檔案本身的權限不影響寫入。
                proc = _run_confined(
                    jail,
                    [gdb_exe, "--batch", "-nx", "-x", script_path, binary],
                    stdout=stdout_f,
                    stderr=subprocess.DEVNULL,
                    timeout=PRERUN_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                logger.warning("[prerun] gdb batch pre-run timed out")
                error_reason = "prerun_timeout"
            except Exception:
                logger.exception("[prerun] failed to invoke gdb for batch pre-run")
                error_reason = "prerun_failed"

        if error_reason is None:
            if proc.returncode != 0:
                logger.warning(
                    "[prerun] gdb batch pre-run exited with code %s", proc.returncode
                )
                error_reason = "prerun_failed"
            else:
                # Bounded read from disk -- never the full file/pipe.
                with open(stdout_path, "rb") as f:
                    raw_stdout = f.read(PRERUN_MAX_STDOUT_BYTES)
    finally:
        for path in (script_path, stdout_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        _release_prerun_slot(prefix)

    if error_reason is not None:
        return jsonify({"ok": False, "reason": error_reason}), 200

    stdout = raw_stdout.decode("utf-8", errors="replace")
    snaps = parse_prerun_output(stdout)
    if snaps is None:
        return jsonify({"ok": False, "reason": "parse_failed"}), 200

    return jsonify({"ok": True, "snapshots": snaps})


# ── 教案分享 ──────────────────────────────────────────────────────────────────
#
# 設計文件：docs/superpowers/specs/2026-07-30-lesson-sharing-design.md
#
# ## 這個切片的整個授權面是一條規則
#
#   **user_id 永遠取自 session，絕不從請求讀取。**
#
# 與 owner_key() 同一個形狀：請求裡能表達的東西當中，不存在「別人的身分」
# 這個值。所以「請求夾帶 user_id 會怎樣」的答案不是「會被驗掉」，而是
# 「根本沒有那條讀取路徑」——底下四條路由沒有任何一處讀 body 的 user_id。
#
# ## 「另存為自己的」不是特例
#
# 開啟別人的教案、改幾行、按儲存：沒有 fork 的話這個動作要嘛失敗、要嘛覆寫
# 對方的。PUT 到不屬於自己的教案時改成在自己名下建立一份新的（原件一個位元組
# 都不會動，因為那條路徑上根本沒有 UPDATE）。
#
# ## 可見性
#
# 每一篇都對每一個登入者可見（使用者 2026-07-30 決定）。沒有 visibility 欄位、
# 沒有軟刪除、沒有「每條查詢都要記得過濾」的那類漏洞。理由見 db.py 的說明。

#: 請求本體的位元組上限，在**解析 JSON 之前**就擋。
#:
#: 只檢查 bundle 大小是不夠的：那要先讓 Flask 把整份 body 讀進記憶體、再讓
#: json 把它建成 Python 物件，一個 500 MB 的請求在被判定為「太大」之前就已經
#: 把記憶體吃掉了。留兩倍 bundle 上限的餘裕給 JSON 轉義與其他欄位。
MAX_LESSON_REQUEST_BYTES = 2 * db.MAX_BUNDLE_BYTES

#: 錯誤訊息刻意只描述「使用者這邊哪裡不對」，不含任何伺服器路徑、限制以外的
#: 內部細節，也不區分「不存在」與「不是你的」（見 _lesson_not_found）。
LESSON_TOO_LARGE_MESSAGE = "教案內容超過大小上限，請縮小後再儲存。"
LESSON_INVALID_MESSAGE = "教案標題或內容格式不正確。"
LESSON_NOT_FOUND_MESSAGE = "找不到這個教案。"
#: 只描述「這個請求哪裡不對」——不提教案是否存在、屬於誰。與其他 400 訊息同樣
#: 的規則：讀得出違反了哪一條輸入規則，讀不出伺服器上有什麼。
TAGS_FIELD_REQUIRED_MESSAGE = "請提供 tags 欄位（要清空標籤請送空字串）。"


def _quota_response(exc):
    """配額用盡的回應。

    跟「格式不正確」分開，因為使用者要做的事不同：格式問題要改內容，配額問題
    要刪掉舊教案。訊息帶上「已用／上限」讓對方知道自己站在哪裡，但只講他自己
    的數字，不洩漏其他使用者的資料或任何路徑。
    """
    used_mb = exc.used / (1024 * 1024)
    limit_mb = exc.limit / (1024 * 1024)
    if "site" in str(exc):
        msg = "全站儲存空間已滿，暫時無法新增教案，請稍後再試或聯絡管理員。"
    else:
        msg = f"你的儲存空間已滿（已用 {used_mb:.1f} MB / 上限 {limit_mb:.0f} MB），請先刪除舊教案。"
    return jsonify({"message": msg}), 413


def _lesson_author() -> int:
    """本次請求要記在誰名下。**唯一**來源是 session。

    未登入時 abort(401) 而不是回退成任何預設身分：fail closed。理論上到不了
    這裡（全域 require_login 閘門 + @authenticate 在前面），這是那個不變式
    壞掉時的第二道網——與 _session_prefix() 同一個模式。
    """
    user_id = current_user_id()
    if user_id is None:
        logger.warning("[authz] refusing a lesson write with no identity")
        abort(401)
    return user_id


def _lesson_not_found():
    """「沒有這篇教案」與「這篇不是你的」回同一個東西。

    可見性是全公開，所以「存在與否」本身不是秘密；但刪除的拒絕若與「不存在」
    可區分，就變成一台「哪些 id 有主人」的探測機。兩者同形，理由與
    SIGNAL_REFUSED_MESSAGE / ATTACH_REFUSED_MESSAGE 一致。
    """
    return jsonify({"message": LESSON_NOT_FOUND_MESSAGE}), 404


def _lesson_payload():
    """驗過的 ((title, bundle_json), None)，或 (None, error_response)。

    回傳的 bundle_json 是**伺服器自己 json.dumps 出來的**，不是使用者送來的
    字串原文：這樣資料庫裡的那一欄保證是合法 JSON（GET 會把它 parse 回去），
    而且大小上限量的是實際會被寫進去的那份位元組。
    """
    length = request.content_length
    if length is None or length > MAX_LESSON_REQUEST_BYTES:
        # content_length is None＝chunked／沒宣告長度。一樣拒絕：不宣告長度就
        # 沒有辦法在讀進來之前知道它多大，而「先讀再說」正是要避免的東西。
        return None, (jsonify({"message": LESSON_TOO_LARGE_MESSAGE}), 413)

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)

    title = body.get("title")
    bundle = body.get("bundle")
    # body 裡就算夾帶 user_id 也不會被看到——這裡只取這兩個欄位。
    if not isinstance(title, str) or not isinstance(bundle, dict):
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)

    title = title.strip()
    if not title or len(title) > db.MAX_TITLE_LENGTH:
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)
    if any(ch < " " or ch == "\x7f" for ch in title):
        # 控制字元在 HTML 裡不可見，但會弄壞 log 與匯出格式（同 auth 的
        # display_name 檢查）。這不是 XSS 防線——那一層是模板的 autoescape。
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)

    try:
        bundle_json = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)
    if len(bundle_json.encode("utf-8")) > db.MAX_BUNDLE_BYTES:
        return None, (jsonify({"message": LESSON_TOO_LARGE_MESSAGE}), 413)

    return (title, bundle_json), None


@blueprint.route("/api/lessons", methods=["POST"])
@authenticate
def create_lesson():
    """建立一篇教案。擁有者取自 session。"""
    user_id = _lesson_author()
    fields, error = _lesson_payload()
    if error is not None:
        return error
    title, bundle_json = fields
    try:
        lesson_id = db.create_lesson(user_id, title, bundle_json)
    except db.LessonQuotaExceeded as exc:
        return _quota_response(exc)
    except db.LessonRejected:
        return jsonify({"message": LESSON_INVALID_MESSAGE}), 400
    return jsonify({"id": lesson_id, "forked": False}), 201


@blueprint.route("/api/lessons/<int:lesson_id>", methods=["PUT"])
@authenticate
def update_lesson(lesson_id: int):
    """更新自己的教案；目標不屬於自己時改為在自己名下建立一份副本。

    非擁有者走的是 create_lesson，那條路徑上沒有任何 UPDATE，所以原件不可能
    被改到。擁有者那一條仍然走 `WHERE id = ? AND user_id = ?`（db 層），不是
    只靠這裡的 if。
    """
    user_id = _lesson_author()
    fields, error = _lesson_payload()
    if error is not None:
        return error
    title, bundle_json = fields

    existing = db.lesson_by_id(lesson_id)
    if existing is None:
        return _lesson_not_found()

    try:
        if int(existing["user_id"]) == user_id:
            if not db.update_lesson_owned_by(lesson_id, user_id, title, bundle_json):
                return _lesson_not_found()
            return jsonify({"id": lesson_id, "forked": False})
        new_id = db.create_lesson(user_id, title, bundle_json)
    except db.LessonQuotaExceeded as exc:
        return _quota_response(exc)
    except db.LessonRejected:
        return jsonify({"message": LESSON_INVALID_MESSAGE}), 400
    return jsonify({"id": new_id, "forked": True}), 201


@blueprint.route("/api/lessons/<int:lesson_id>", methods=["DELETE"])
@authenticate
def delete_lesson(lesson_id: int):
    """硬刪除自己的教案。非擁有者一律拒絕（不是變成別的行為）。"""
    user_id = _lesson_author()
    try:
        deleted = db.delete_lesson_owned_by(lesson_id, user_id)
    except db.LessonRejected:
        return _lesson_not_found()
    if not deleted:
        logger.info("[authz] refused delete of lesson %s", lesson_id)
        return _lesson_not_found()
    return jsonify({"ok": True})


@blueprint.route("/api/lessons/<int:lesson_id>", methods=["GET"])
@authenticate
def get_lesson(lesson_id: int):
    """讀一篇教案的 bundle。任何登入者都可以（可見性見上）。"""
    row = db.lesson_by_id(lesson_id)
    if row is None:
        return _lesson_not_found()
    try:
        bundle = json.loads(row["bundle_json"])
    except ValueError:
        # 寫入時是伺服器自己 dumps 的，所以理論上到不了這裡。
        logger.warning("[lessons] lesson %s holds unparsable json", lesson_id)
        return _lesson_not_found()
    return jsonify(
        {
            "id": int(row["id"]),
            "title": row["title"],
            "bundle": bundle,
            "author_username": row["username"],
            "author_display_name": row["display_name"],
            "updated_at": row["updated_at"],
            "is_mine": current_user_id() == int(row["user_id"]),
        }
    )


@blueprint.route("/api/lessons/<int:lesson_id>/tags", methods=["POST"])
@authenticate
def update_lesson_tags(lesson_id: int):
    """整批設定一篇教案的標籤。只有作者可以。

    刻意不叫 set_lesson_tags——那是 tags.py 裡做實事的那個函式的名字，
    兩個同名會讓「哪一個擋權限」變成要看 import 才知道的事。

    刻意**不**沿用 PUT /api/lessons/<id> 的 fork 行為（那條在教案不是你的
    時候會另存一份副本）。改內容是創作，另存合理；改標籤不是。靜默 fork 會
    讓使用者以為自己整理了教案庫，其實只是替自己複製了一堆。
    """
    user_id = _lesson_author()
    # 缺欄位**不等於**清空。`get_json(silent=True)` 在任何解析失敗時都回 None
    # （Content-Type 打錯、body 被截斷、送 [] 或 0、body 是空的），若把那一律
    # 當成 raw=""，一個破壞性操作就會在「請求根本沒讀懂」時 fail open 並回 200。
    # 要清空標籤必須明確送 {"tags": ""}。
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "tags" not in payload:
        return jsonify({"message": TAGS_FIELD_REQUIRED_MESSAGE}), 400
    raw = payload["tags"]

    try:
        result = tags_module.set_lesson_tags(lesson_id, user_id, raw)
    except tags_module.TagRejected as exc:
        return jsonify({"message": str(exc)}), 400

    if result is None:
        logger.info("[authz] refused tag write on lesson %s", lesson_id)
        return _lesson_not_found()
    return jsonify({"tags": result})


@blueprint.route("/", methods=["GET"])
@authenticate
def lesson_library():
    """主頁：可搜尋、可依標籤篩選的教案清單。

    標題與作者顯示名稱是使用者輸入，全部靠 Jinja 的 autoescape 轉義
    （模板裡沒有任何 |safe，也沒有任何使用者字串被插進 <script>）。
    """
    # /?lesson=42 是除錯器的舊深連結（教案庫頁與外部書籤都在用）。
    # 主頁換了用途，但那些連結必須繼續有用。
    requested_lesson = request.args.get("lesson")
    if requested_lesson is not None:
        return redirect(url_for("http_routes.gdbgui", lesson=requested_lesson))

    add_csrf_token_to_session()

    q = request.args.get("q", "")
    # tag 是可重複參數：/?tag=stl&tag=bst。上限在 db 層截斷。
    selected_tags = request.args.getlist("tag")
    show_all_tags = request.args.get("alltags") == "1"

    per_page = db.LESSONS_PER_PAGE
    total = db.search_count(q=q, tags=selected_tags)
    last_page = max(1, -(-total // per_page))  # ceil

    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    # 夾到 [1, last_page]：否則 ?page=99999999999 會變成一個
    # OFFSET 999999999990 的全表掃描，一個 GET 就能點的 DoS。
    page = min(max(1, page), last_page)

    lessons = db.search_lessons(q=q, tags=selected_tags,
                                limit=per_page, offset=(page - 1) * per_page)
    facets = db.tag_counts(q=q, tags=selected_tags,
                           limit=None if show_all_tags else db.FACET_LIMIT)
    facet_total = len(db.tag_counts(q=q, tags=selected_tags))

    return render_template(
        "lessons.html",
        lessons=lessons,
        lesson_tags=tags_module.tags_for_lessons([row["id"] for row in lessons]),
        facets=facets,
        facet_total=facet_total,
        show_all_tags=show_all_tags,
        q=q,
        selected_tags=[t for t in selected_tags if t],
        page=page,
        last_page=last_page,
        total=total,
        per_page=per_page,
        current_user_id=current_user_id(),
        csrf_token=session["csrf_token"],
    )


@blueprint.route("/lessons", methods=["GET"])
@authenticate
def lesson_library_legacy():
    """教案庫的舊網址。內容搬到主頁了，但書籤要繼續有用。"""
    return redirect(url_for("http_routes.lesson_library", **request.args.to_dict(flat=True)))
