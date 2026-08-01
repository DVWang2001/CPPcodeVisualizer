import binascii
import logging
import os
from functools import wraps
from typing import Optional

from flask import abort, jsonify, redirect, request, session, url_for

logger = logging.getLogger(__file__)

#: 未登入時 API 路徑得到的訊息。刻意不描述「為什麼」——不區分「沒登入」與
#: 「登入了但沒權限」，那是兩個不該被外面分辨出來的狀態。
AUTH_REQUIRED_MESSAGE = "authentication required"

#: **唯一**不需要登入的 endpoint 白名單。
#:
#: 這是一份 endpoint 名稱（不是 URL 路徑）的清單，因為 endpoint 是路由註冊時
#: 就決定的、不會被路徑比對的細節（尾斜線、大小寫、路徑參數）繞過。
#:
#: 預設拒絕：不在這裡面的一律要求登入，**包含還沒對應到任何路由的請求**。
#: 之後新增路由的人若忘記想這件事，結果是「需要登入」而不是「不小心公開」。
PUBLIC_ENDPOINTS = frozenset(
    {
        "auth.login",
        "auth.register",
        "auth.logout",
        "live_quiz.join_page",
        "live_quiz.guest_join",
        "live_quiz.guest_state_route",
        "live_quiz.guest_answer",
        # Flask 內建的靜態檔案路由。登入頁自己要用到 CSS/favicon。
        "static",
    }
)

# Guest writes have no login session and therefore no session CSRF token. They remain
# same-origin checked globally and authenticate with a signed token or HttpOnly cookie.
CSRF_EXEMPT_ENDPOINTS = frozenset(
    {"live_quiz.guest_join", "live_quiz.guest_answer"}
)


def add_csrf_token_to_session():
    if "csrf_token" not in session:
        session["csrf_token"] = binascii.hexlify(os.urandom(20)).decode("utf-8")


def current_user_id() -> Optional[int]:
    """已登入的 user id，未登入回 None。

    session 的內容由 Flask 用 SECRET_KEY 簽章，客戶端改不動，但仍然做型別
    檢查：一個壞掉的 session（舊格式、手動塞的測試資料）應該等於「沒有身分」，
    而不是讓一個字串或 True 一路流進 owner_key() 去當 jail 的 key。
    """
    user_id = session.get("user_id")
    if isinstance(user_id, bool) or not isinstance(user_id, int):
        return None
    if user_id <= 0:
        return None
    return user_id


def owner_key() -> Optional[str]:
    """本次請求的「擁有者身分」—— 授權判斷唯一的身分來源。

    jail 歸屬（jail_manager.acquire）、debug session 擁有權
    （DebugSession.is_owned_by）與訊號授權全部以它為鍵，所以換掉這裡的來源，
    那些程式碼一行都不用動就跟著綁到使用者身上。這正是 93e829d 留下的接縫。

    ## 為什麼是 16 位 hex 而不是整數的 user id

    jail_manager 會把這把 key 放進 useradd 的 argv，所以它只接受
    `[0-9a-f]{8,64}`（jail_manager._SESSION_KEY_RE）。`f"{id:016x}"` 就是那個
    user id，只是寫成固定寬度的十六進位——是編碼，不是另一個身分。刻意不做
    雜湊：出事時 `0000000000000007` 能直接對回 users.id = 7，而這把 key 從來
    不是 secret（它只在伺服器端被產生與比對，永遠不從客戶端讀進來）。

    回傳 None 代表「這個請求沒有身分」。所有判斷都必須 fail closed：
    沒有身分不等於符合任何東西。
    """
    user_id = current_user_id()
    if user_id is None:
        return None
    return f"{user_id:016x}"


def is_cross_origin(request):
    """Compare headers HOST and ORIGIN. Remove protocol prefix from ORIGIN, then
    compare. Return true if they are not equal
    example HTTP_HOST: '127.0.0.1:5000'
    example HTTP_ORIGIN: 'http://127.0.0.1:5000'
    """
    origin = request.environ.get("HTTP_ORIGIN")
    host = request.environ.get("HTTP_HOST")
    if origin is None:
        # origin is sometimes omitted by the browser when origin and host are equal
        return False

    if origin.startswith("http://"):
        origin = origin.replace("http://", "")
    elif origin.startswith("https://"):
        origin = origin.replace("https://", "")
    return host != origin


def csrf_protect(f):
    """A decorator to add csrf protection by validing the X_CSRFTOKEN
    field in request header"""

    @wraps(f)
    def wrapper(*args, **kwargs):
        token = session.get("csrf_token", None)
        if token is None or token != request.environ.get("HTTP_X_CSRFTOKEN"):
            logger.warning("Received invalid csrf token. Aborting")
            abort(403)
        # call original request handler
        return f(*args, **kwargs)

    return wrapper


def client_error(obj):
    return jsonify(obj), 400


# ---------------------------------------------------------------------------
# 登入閘門
#
# 一套機制、兩個掛載點：
#
#   * require_login()  —— 註冊成 before_request 的**主閘門**。預設拒絕，
#     白名單是 PUBLIC_ENDPOINTS。新增路由不需要記得掛任何東西。
#   * @authenticate    —— 既有的路由裝飾器，實作換成同一個判斷。
#
# 這不是兩套平行的認證：兩者共用 current_user_id() 這一個判斷、同一個
# session 欄位、同一個使用者資料表。裝飾器留著是因為它已經掛在敏感路由上，
# 而且萬一日後有人動了 before_request 的註冊或順序，那些路由仍然是關著的。
# ---------------------------------------------------------------------------


def _wants_html() -> bool:
    """這個請求是瀏覽器在導頁，還是程式在打 API？

    導頁要導去登入頁（否則使用者只看到一段 JSON），API 要拿到 401（否則
    fetch() 會跟著 302 拿到一頁 HTML，再在 JSON.parse 上噴一個看不懂的錯）。

    預設是「導頁」而不是「API」：預設猜錯只是 UX 差一點，兩條路都一樣是拒絕。
    刻意不看 `accept_html`——瀏覽器與 curl 的預設 Accept 都含 `*/*`，那個旗標
    對兩者都是 True，分不出東西。看的是「最偏好的型別是不是 JSON」。
    """
    if request.method != "GET":
        return False
    if request.path.startswith("/api/"):
        return False
    accept = request.accept_mimetypes
    if accept and accept.best == "application/json":
        return False
    return True


def deny_unauthenticated():
    """未登入的統一回應。"""
    if _wants_html():
        return redirect(url_for("auth.login"))
    return jsonify({"message": AUTH_REQUIRED_MESSAGE}), 401


def require_login():
    """before_request：全站預設拒絕。

    `request.endpoint is None` 代表這個 URL 沒有對應到任何路由。那也一律拒絕，
    而不是讓它去撞 404：對未登入者來說「這條路徑存不存在」本身就不該可觀察，
    而且「預設拒絕」如果對未知路徑破例，就不是預設拒絕了。
    """
    if request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if current_user_id() is not None:
        return None
    return deny_unauthenticated()


def authenticate(f):
    """路由層的登入檢查（與 require_login 同一個判斷，見上面的說明）。"""

    @wraps(f)
    def wrapper(*args, **kwargs):
        if current_user_id() is None:
            return deny_unauthenticated()
        return f(*args, **kwargs)

    return wrapper
