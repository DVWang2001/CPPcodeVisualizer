import logging
import os
from flask import Flask, abort, request, session

# python-engineio 4.10+ 將 max_decode_packets 改為 1（強制 v4 協議），
# 但瀏覽器 socket.io client 仍會批次送多個封包，造成大量 ValueError。
# 用兩層防禦：class attribute + monkey-patch decode，確保各版本都能正常。
try:
    from engineio import payload as _eio_payload

    # 層 1：直接設 class attribute（舊版有效）
    if hasattr(_eio_payload.Payload, 'max_decode_packets'):
        _eio_payload.Payload.max_decode_packets = 500

    # 層 2：替換 decode，移除 packet 數量上限檢查（新版有效）
    _orig_payload_decode = _eio_payload.Payload.decode

    def _patched_payload_decode(self, encoded_payload):
        # 暫時把 class attribute 調高（有些版本在方法內讀 self.__class__）
        _cls = type(self)
        _old = getattr(_cls, 'max_decode_packets', None)
        try:
            _cls.max_decode_packets = 500
            return _orig_payload_decode(self, encoded_payload)
        except ValueError as exc:
            if 'Too many packets' in str(exc):
                pass  # 忽略，直接回傳已解析的部分
            else:
                raise
        finally:
            if _old is not None:
                _cls.max_decode_packets = _old

    _eio_payload.Payload.decode = _patched_payload_decode
except Exception:
    pass
from flask_compress import Compress  # type: ignore
from flask_socketio import SocketIO  # type: ignore

from . import auth, db, live_quiz
from .constants import STATIC_DIR, TEMPLATE_DIR
from .http_routes import blueprint
from .http_util import CSRF_EXEMPT_ENDPOINTS, is_cross_origin, require_login

logger = logging.getLogger(__file__)
# Create flask application and add some configuration keys to be used in various callbacks
app = Flask(__name__, template_folder=str(TEMPLATE_DIR), static_folder=str(STATIC_DIR))
# 必須在 Compress(app) 之前設定：Flask-Compress 用 setdefault 讀這個鍵，先設先贏。
#
# Flask-Compress 1.10.1 的預設清單只有 `application/javascript`，但 IANA 後來把
# JavaScript 的註冊型別改成 `text/javascript`，Werkzeug 跟著改了。兩邊對不上的結果是
# 下面那行 `Compress(app)` 對**所有** JS 檔完全空轉——站台上 14.4 MB 的 JS 全部未壓縮
# 送出（gzip 後只有 3.5 MB）。使用者的症狀是點進教案要等兩分鐘，而伺服器端一切正常：
# 沒有錯誤、沒有慢查詢，loopback 上 3.6 MB 的檔案 0.035 秒就吐完，瓶頸全在網路上。
#
# 兩種型別都留著：舊的 Werkzeug 仍會回 application/javascript，拿掉會在舊環境上復發。
app.config["COMPRESS_MIMETYPES"] = [
    "text/html",
    "text/css",
    "text/xml",
    "application/json",
    "application/javascript",
    "text/javascript",
    # 瀏覽器內 C++ 引擎的編譯器資產（clang.wasm/lld.wasm/sysroot.tar/headers.tar，
    # 合計 ~92 MB，首次造訪才會抓）：wasm 位元碼與 tar 裡的標頭檔文字都壓得動，
    # 沒設這兩個型別時 Flask-Compress 完全跳過它們，全部未壓縮送出。ETag 條件式
    # 請求已經讓重複造訪很便宜，這裡壓縮成本只落在真的第一次下載的人身上。
    "application/wasm",
    "application/x-tar",
]
Compress(
    app
)  # add gzip compression to Flask. see https://github.com/libwilliam/flask-compress


def _static_max_age(filename):
    """static/vendor/ 底下的東西可以無限期快取，其餘不行。

    vendor/ 是釘死版本的第三方檔案（光 monaco-editor 就 13MB）。沒有 max-age 時
    Flask 只給 ETag，瀏覽器每次開頁都要為每個檔案送一次條件式請求換一個 304——
    位元組省下來了，但幾百次往返全打在單核機器的 Python 伺服器上，一個班同時進來
    就是它在忙這個。這些檔案的內容永遠不會變，換版本等於換路徑。

    app 自己的 JS 不能比照辦理：`main.js?_={{version}}` 的 version 只在發版時變，
    重新 build 不變，長期快取會讓學生拿到舊的前端。
    """
    if filename and filename.startswith("vendor/"):
        return 31536000  # 1 年，這是 Cache-Control 允許的實務上限
    return None  # 其餘維持原本的 ETag 條件式請求


app.get_send_file_max_age = _static_max_age
app.register_blueprint(blueprint)
app.register_blueprint(auth.blueprint)
app.register_blueprint(live_quiz.blueprint)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["project_home"] = None
app.config["remap_sources"] = {}
app.config["MOBILE_JOIN_BASE_URL"] = os.environ.get("MOBILE_JOIN_BASE_URL", "")

# 資料庫：建立資料目錄（0700）並套用 migration。必須在讀 SECRET_KEY 之前。
db.initialize()

# 這裡以前是 `binascii.hexlify(os.urandom(24))`——每次啟動換一把新鑰匙，所有
# session 立刻失效。沒有登入時無所謂；有了登入之後，那代表每次部署或重啟都把
# 所有人登出。金鑰現在活在 0600 的檔案裡、放在 0700 的資料目錄底下，那個目錄
# 不在任何 session 帳號讀得到的地方（見 db.py 的模組說明）。
app.secret_key = db.get_or_create_secret_key()

# HttpOnly 是 Flask 預設；SameSite=Lax 讓瀏覽器不會在跨站的 POST 帶上 cookie，
# 疊在既有的全域 CSRF token 檢查之上，一行、零成本。
# Secure 要靠 HTTPS，而目前的部署是 http://；用環境變數開，預設不開（開了會
# 讓 http 部署完全無法登入，那是比缺一個旗標更糟的失效模式）。
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("GDBGUI_SECURE_COOKIES") == "1"

# ── 請求本體的全域上限 ────────────────────────────────────────────────────────
#
# 沒有這一條的話，一個「Content-Length: 2 GB」的請求就是一台單請求全站中斷機：
# `request.get_json()` / `request.files` 會把整份 body 讀進記憶體之後，才輪到任何
# 路由層的驗證。部署是單容器、eventlet 單 worker、`mem_limit: 3g`，compose 裡沒有
# 反向代理替我們擋 body，而註冊是開放的——攻擊者資格免費。
#
# 刻意訂在**全域**而不是逐路由補：同樣的洞現在至少還在 http_routes 的
# explain_error、generate_lesson 與 lessons 的 request.get_json() 幾處，只補一條會讓
# 下一個人以為這件事已經想過了。之後新增、作者沒想過這件事的路由也自動受保護。
#
# 16 MB 是「擋得住 OOM」的上限，同時涵蓋 /api/generate_lesson、/api/lessons 與
# /api/explain_error 的請求 body（原本為 /upload 收編譯後執行檔而訂，該路由已移除）。
#
# http_routes._lesson_payload() 既有的 512 KB 檢查**保留不動**：它比較嚴，繼續
# 當教案路由自己的上限。這一條是所有路由的地板，不是誰的替代品。
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

socketio = SocketIO(manage_session=False)
live_quiz.register_socket_handlers(socketio)


@app.before_request
def csrf_protect_all_post_and_cross_origin_requests():
    """returns None upon success"""
    success = None
    if is_cross_origin(request):
        logger.warning("Received cross origin request. Aborting")
        abort(403)
    if request.endpoint in CSRF_EXEMPT_ENDPOINTS:
        return success
    # DELETE 加進來的理由與 POST/PUT 完全一樣：它會改變伺服器狀態
    # （/api/lessons/<id> 是硬刪除）。跨站的 DELETE 目前還被另外兩層擋著
    # （SameSite=Lax 不帶 cookie、上面的 is_cross_origin 會 403），但一個
    # 「只保護部分變更方法」的 CSRF 閘門遲早會在有人加第五條路由時漏掉。
    if request.method in ["POST", "PUT", "DELETE", "PATCH"]:
        server_token = session.get("csrf_token")
        if not isinstance(server_token, str) or not server_token:
            # session 裡沒有 token 時，底下每一個 `server_token == X` 都會在
            # 「請求也沒帶」的情況下變成 None == None 而放行。已登入的 session
            # 一定有 token（start_user_session 會種），所以這條只會擋到未登入的
            # 請求——但一個「兩邊都沒有就算通過」的比對不該存在。
            logger.warning("Received a state-changing request with no session token")
            abort(403)
        if server_token == request.form.get("csrf_token"):
            return success
        elif server_token == request.environ.get("HTTP_X_CSRFTOKEN"):
            return success
        else:
            # get_json(silent=True) 而不是 request.json：後者在 Content-Type
            # 不是 application/json 時會丟 415，於是「CSRF token 不對」與
            # 「body 不是 JSON」變成兩種不同的失敗，而且 415 比 403 難查。
            # 判斷本身沒有放寬——token 仍然必須完全相等才放行。
            body = request.get_json(silent=True)
            if isinstance(body, dict) and server_token == body.get("csrf_token"):
                return success
            logger.warning("Received invalid csrf token. Aborting")
            abort(403)


# ── 全站登入閘門 ──────────────────────────────────────────────────────────────
#
# **預設拒絕。** 白名單只有 /login、/register、/logout 與靜態資源
# （http_util.PUBLIC_ENDPOINTS）；其餘所有已註冊路由——包含之後才加上去、
# 作者忘了想這件事的那些——一律要求登入。
#
# 註冊在 CSRF 檢查**之後**：跨來源與 CSRF token 先驗，未登入者因此也不會有一條
# 繞過那兩道檢查的捷徑。
#
# 這不是第二套認證機制，是同一套的另一個掛載點：它與 @authenticate 裝飾器共用
# http_util.current_user_id() 這一個判斷（說明見 http_util）。
app.before_request(require_login)
