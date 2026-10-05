import hashlib
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path

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

from gdbgui import __version__

from .constants import TEMPLATE_DIR, USING_WINDOWS, SIGNAL_NAME_TO_OBJ
from .http_util import (
    add_csrf_token_to_session,
    authenticate,
    client_error,
    current_user_id,
    owner_key,
)
from . import db, live_quiz
from . import tags as tags_module
from . import lesson_gen

logger = logging.getLogger(__file__)
blueprint = Blueprint("http_routes", __name__, template_folder=str(TEMPLATE_DIR))

def _session_prefix() -> str:
    """本請求的識別字串（＝owner key，http_util.owner_key）。

    這裡以前會在 Flask session 裡憑空生一個 uuid4（匿名的 `uploaded_prefix`）。
    全站要求登入之後匿名身分不再存在，唯一的身分來源是登入的使用者——所以這個
    函式現在只是 owner_key() 的別名，不再自己造身分。

    只產生一個字串，不建立任何作業系統資源。

    未登入時 abort(401) 而不是回退成匿名：fail closed。理論上到不了這裡
    （全域的 require_login 閘門在前面），這是那個不變式壞掉時的第二道網。
    """
    key = owner_key()
    if not key:
        logger.warning("[authz] refusing to serve a request with no identity")
        abort(401)
    return key


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


# 除錯器。以前掛在 "/"；主頁讓給教案瀏覽之後搬到這裡。
# endpoint 名稱刻意維持 "gdbgui"——模板裡既有的 url_for('http_routes.gdbgui')
# 因此自動指向 /edit，不必逐一改呼叫端。
@blueprint.route("/edit", methods=["GET"])
@authenticate
def gdbgui():
    # 渲染這一頁只需要身分。未登入在全域 require_login 就被擋下；這一行是
    # 那個不變式壞掉時的第二道網（fail closed，見 _session_prefix）。
    _session_prefix()

    """Render the main gdbgui interface"""
    # 伺服器 GDB 已移除，程式在瀏覽器內的 wasm 引擎執行。下列幾項刻意**不再**
    # 讀請求或 session：
    #   * ?gdbpid= / ?gdb_command=：舊的深連結仍會從 / 轉到這裡，但這兩個值不再
    #     回音進頁面（伺服器沒有 GDB 行程可接、也沒有命令可下）。
    #   * session["uploaded_binary"]：舊 cookie 可能還帶著 GDB 時代的伺服器路徑；
    #     直接忽略，不 stat、不回音。
    # gdb_command / initial_binary_and_args 兩個鍵仍保留（前端會讀），給固定的空值。
    add_csrf_token_to_session()

    # Make 'light' the default theme by listing it first. The frontend
    # uses initial_data.themes[0] as the default when no stored preference
    # exists in localStorage.
    THEMES = ["light", "monokai"]
    initial_data = {
        "csrf_token": session["csrf_token"],
        "gdbgui_version": __version__,
        "gdb_command": None,
        "initial_binary_and_args": [],
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


#: 教案生成的輸出上限與等待上限。兩個值都由「一份教案有多大、模型有多慢」決定，
#: 不是隨手填的：見下方 max_tokens 與 timeout 的註解。
LESSON_MAX_OUTPUT_TOKENS = 16384
LESSON_GEN_TIMEOUT_SECONDS = 600


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

    payload = {
        "model": model,
        "messages": lesson_gen.build_messages(
            guide_md, source, _as_str(body.get("instruction", ""))
        ),
        # 一份教案的輸出量：dp3_knapsack.cpp 這種長度粗估就要 4800 tokens，
        # 舊的 4096 會在中間把程式碼截斷（而且截斷後看起來像一份完整教案）。
        "max_tokens": LESSON_MAX_OUTPUT_TOKENS,
        "temperature": 0.3,
        # 非串流不是效能選擇，是能不能完成的問題。實測 NVIDIA 的閘道在
        # 302 秒整砍掉請求（縮小 prompt 也一樣，所以瓶頸是總時間不是輸入量），
        # 而一份教案要 704 秒。串流讓連線上持續有資料，閘道就不會判逾時。
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    def relay():
        """把上游的 SSE 轉成 NDJSON 一行一塊往前端送。

        為什麼是 NDJSON 而不是原封轉發 SSE：前端要的是「文字增量」加上最後一份
        去掉圍欄的完整程式碼，而去圍欄要等全部收完才能做。自己定一行一個 JSON
        物件最省事，前端用 fetch 的 ReadableStream 逐行 parse 即可。

        串流一旦開始就送不出 HTTP 狀態碼了，所以錯誤只能以 {"error": ...} 這一行
        傳達——前端必須把它當成失敗，不能當成內容。
        """
        pieces = []
        saw_reasoning = False
        try:
            with _requests.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload,
                stream=True,
                # 串流時這是「兩塊資料之間」的上限，不是整體上限。實測首塊要
                # 143.9 秒（排隊 + prefill），所以不能設得太小。
                timeout=LESSON_GEN_TIMEOUT_SECONDS,
            ) as upstream:
                if upstream.status_code != 200:
                    detail = upstream.text[:300]
                    yield json.dumps(
                        {"error": f"模型 API 回傳 {upstream.status_code}：{detail}"},
                        ensure_ascii=False,
                    ) + "\n"
                    return
                for line in upstream.iter_lines():
                    parsed = lesson_gen.sse_delta(line)
                    if not parsed:
                        continue
                    kind, text = parsed
                    if kind == "content":
                        # 只有 content 是要留下來的教案；推理過程不能寫進去。
                        pieces.append(text)
                        yield json.dumps({"delta": text}, ensure_ascii=False) + "\n"
                    else:
                        # 思考過程純粹當進度用。推理階段長達數分鐘，沒有它畫面
                        # 會整整幾分鐘空白，使用者只會以為當掉。
                        saw_reasoning = True
                        yield json.dumps({"thinking": text}, ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps({"error": f"呼叫模型 API 失敗：{e}"}, ensure_ascii=False) + "\n"
            return

        code = lesson_gen.strip_code_fences("".join(pieces))
        if not code.strip():
            # 推理型模型會把輸出額度花在思考上（實測 12 行的程式：思考 1622 塊、
            # 教案 65 塊）。程式一長，推理量跟著漲，可能在動筆前就把額度用光——
            # 那時候的症狀和「模型壞掉」一模一樣，訊息必須說清楚差別。
            reason = (
                "模型把輸出額度都用在思考上，還沒寫出程式碼就到達上限。"
                "請把程式改短一點再試，或請管理員調高 LESSON_MAX_OUTPUT_TOKENS。"
                if saw_reasoning else "模型未輸出程式碼"
            )
            yield json.dumps({"error": reason}, ensure_ascii=False) + "\n"
            return
        yield json.dumps({"done": True, "code": code}, ensure_ascii=False) + "\n"

    return current_app.response_class(
        relay(),
        mimetype="application/x-ndjson",
        # 前面若有反向代理，這一行要求它不要把串流緩衝起來——緩衝會讓
        # 「使用者看得到進度」這件事失效，也讓閘道重新開始計算閒置時間。
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


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
    可區分，就變成一台「哪些 id 有主人」的探測機。兩者同形。
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
        normalized_quiz = live_quiz.validate_quiz_bundle(bundle)
    except live_quiz.QuizRejected:
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)
    if "quiz" in bundle:
        bundle["quiz"] = normalized_quiz

    try:
        bundle_json = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return None, (jsonify({"message": LESSON_INVALID_MESSAGE}), 400)
    if len(bundle_json.encode("utf-8")) > db.MAX_BUNDLE_BYTES:
        return None, (jsonify({"message": LESSON_TOO_LARGE_MESSAGE}), 413)

    return (title, bundle_json), None


def _optional_parent_version():
    """讀取 owner PUT 的可選父版本；payload 已由 _lesson_payload 驗過。"""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "parent_version" not in body:
        return None
    parent_version = body["parent_version"]
    if (
        isinstance(parent_version, bool)
        or not isinstance(parent_version, int)
        or parent_version <= 0
        or parent_version > db.SQLITE_MAX_INTEGER
    ):
        raise db.LessonRejected("parent version must be a positive integer")
    return parent_version


def _version_payload(row, include_bundle=True):
    """將版本資料列轉為 API 回應；損壞快照由呼叫端視為不存在。"""
    payload = {
        "version": int(row["version"]),
        "parent_version": (
            int(row["parent_version"])
            if row["parent_version"] is not None
            else None
        ),
        "title": row["title"],
        "created_at": row["created_at"],
    }
    if include_bundle:
        payload["bundle"] = json.loads(row["bundle_json"])
    return payload


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
        result = db.create_lesson_with_version(user_id, title, bundle_json)
    except db.LessonQuotaExceeded as exc:
        return _quota_response(exc)
    except db.LessonRejected:
        return jsonify({"message": LESSON_INVALID_MESSAGE}), 400
    return jsonify(
        {
            "id": result.lesson_id,
            "forked": False,
            "version": result.version,
            "changed": result.changed,
        }
    ), 201


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
            parent_version = _optional_parent_version()
            result = db.update_lesson_owned_by(
                lesson_id, user_id, title, bundle_json, parent_version
            )
            if result is None:
                return _lesson_not_found()
            return jsonify(
                {
                    "id": result.lesson_id,
                    "forked": False,
                    "version": result.version,
                    "changed": result.changed,
                }
            )
        result = db.create_lesson_with_version(user_id, title, bundle_json)
    except db.LessonQuotaExceeded as exc:
        return _quota_response(exc)
    except db.LessonRejected:
        return jsonify({"message": LESSON_INVALID_MESSAGE}), 400
    return jsonify(
        {
            "id": result.lesson_id,
            "forked": True,
            "version": result.version,
            "changed": result.changed,
        }
    ), 201


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
            "current_version": int(row["current_version"]),
        }
    )


@blueprint.route("/api/lessons/<int:lesson_id>/versions", methods=["GET"])
@authenticate
def get_lesson_versions(lesson_id: int):
    """只列出目前登入擁有者的版本摘要。"""
    rows = db.lesson_versions_owned_by(lesson_id, _lesson_author())
    if not rows:
        return _lesson_not_found()
    return jsonify(
        {
            "versions": [_version_payload(row, include_bundle=False) for row in rows],
            "current_version": int(rows[0]["version"]),
        }
    )


@blueprint.route("/api/lessons/<int:lesson_id>/versions/<int:version>", methods=["GET"])
@authenticate
def get_lesson_version(lesson_id: int, version: int):
    """只取得目前登入擁有者的一份完整快照。"""
    row = db.lesson_version_owned_by(lesson_id, _lesson_author(), version)
    if row is None:
        return _lesson_not_found()
    try:
        return jsonify(_version_payload(row))
    except ValueError:
        logger.warning("[lessons] version %s of lesson %s holds unparsable json", version, lesson_id)
        return _lesson_not_found()


@blueprint.route("/api/lessons/<int:lesson_id>/versions/<int:version>/diff", methods=["GET"])
@authenticate
def get_lesson_version_diff(lesson_id: int, version: int):
    """只取得目前登入擁有者的快照與它的父快照。"""
    rows = db.lesson_version_diff_owned_by(lesson_id, _lesson_author(), version)
    if rows is None:
        return _lesson_not_found()
    snapshot, parent = rows
    try:
        return jsonify(
            {
                "version": _version_payload(snapshot),
                "parent": _version_payload(parent) if parent is not None else None,
            }
        )
    except ValueError:
        logger.warning("[lessons] version %s of lesson %s holds unparsable json", version, lesson_id)
        return _lesson_not_found()


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
    # 舊的除錯器深連結：/?lesson=N（教案庫與外部書籤）、/?gdbpid=N
    # （dashboard 的 "Copy Sharable URL" 產生過這種網址，可能已經被貼到別處）、
    # /?gdb_command=...（dashboard 的 "Start a new gdb session" 換位前打的
    # 就是這條，同樣可能被存成書籤）。主頁換了用途，但那些連結必須繼續有用，
    # 而且**整個 query string 要原樣帶過去**——參數在轉址時被丟掉，使用者
    # 拿到的是一個「看起來成功、行為卻不同」的頁面，比直接壞掉更難查。
    if any(k in request.args for k in ("lesson", "gdbpid", "gdb_command")):
        qs = request.query_string.decode("utf-8", "replace")
        target = url_for("http_routes.gdbgui")
        return redirect(f"{target}?{qs}" if qs else target)

    add_csrf_token_to_session()

    # 在進資料庫和模板前先正規化，讓 UI 與查詢使用完全相同的篩選條件。
    q = db._clean_query(request.args.get("q", ""))
    selected_tags = db._clean_tags(request.args.getlist("tag"))
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
    """教案庫的舊網址。內容搬到主頁了，但書籤要繼續有用。

    轉址帶的是原始 query string，不是 `request.args.to_dict(flat=True)`——
    後者對重複參數（例如 `tag=a&tag=b`）只留第一個，會悄悄吃掉多選標籤。
    """
    qs = request.query_string.decode("utf-8", "replace")
    target = url_for("http_routes.lesson_library")
    return redirect(f"{target}?{qs}" if qs else target)
