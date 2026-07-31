"""註冊、登入、登出、個人檔案。

設計文件：docs/superpowers/specs/2026-07-29-user-profile-slice-design.md

## 這裡刻意**沒有**的東西

**登入失敗的速率限制。** 使用者於 2026-07-29 明確決定不做，理由是會要求所有人
使用拋棄式密碼。後果記錄於設計文件：公開註冊 + 無速率限制 = 任何人可對任一
帳號無限次嘗試密碼。若日後對外開放，這是第一個該補的東西。

**不做的其他項目**：密碼重設（需要 email）、頭像（檔案上傳是獨立的攻擊面）、
學習紀錄統計。

## 保留下來、因為它們不用花力氣

  * 密碼雜湊：`werkzeug.security`（預設 scrypt），一行呼叫，werkzeug 是 Flask
    既有相依。
  * Cookie `HttpOnly`：Flask 預設即開啟。
  * 登入錯誤訊息不區分「帳號不存在」與「密碼錯誤」：寫一個字串比寫兩個更短。
    連**時間**也不區分——帳號不存在時照樣跑一次雜湊驗證（見 _verify_password），
    否則「回得特別快」就是一台帳號存在性的探測機。
  * CSRF：沿用既有的全域 before_request 防護（app.py），登入／註冊表單都帶
    csrf_token 隱藏欄位。
"""

import logging
import re
from typing import Optional

from flask import Blueprint, abort, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from . import blocking, db, tags
from .constants import TEMPLATE_DIR
from .http_util import add_csrf_token_to_session, current_user_id

logger = logging.getLogger(__name__)

blueprint = Blueprint("auth", __name__, template_folder=str(TEMPLATE_DIR))


#: 3–32 字元，小寫英數加底線/連字號，頭尾必須是英數。
#: 它同時是個人檔案的網址（/u/<username>），所以不能含 `/`、`.`、`%` 之類會
#: 改變路徑意義的字元；一律轉小寫則讓 UNIQUE 約束等於「不會有兩個看起來一樣
#: 的帳號」（Alice 與 alice 不能並存）。
USERNAME_RE = re.compile(r"\A[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]\Z")

MIN_PASSWORD_LENGTH = 8
#: scrypt 的成本由參數決定而不是輸入長度，但沒有理由讓人送 10 MB 的密碼進來。
MAX_PASSWORD_LENGTH = 1024
MAX_DISPLAY_NAME_LENGTH = 64

#: 登入失敗**唯一**的一句話。不區分「沒有這個帳號」與「密碼錯了」。
LOGIN_FAILED_MESSAGE = "帳號或密碼錯誤。"

USERNAME_TAKEN_MESSAGE = "這個使用者名稱已經有人用了。"
USERNAME_INVALID_MESSAGE = (
    "使用者名稱需為 3–32 個字元，只能用小寫英文、數字、底線與連字號，且頭尾為英數。"
)
PASSWORD_TOO_SHORT_MESSAGE = f"密碼至少需要 {MIN_PASSWORD_LENGTH} 個字元。"
PASSWORD_TOO_LONG_MESSAGE = f"密碼不可超過 {MAX_PASSWORD_LENGTH} 個字元。"
DISPLAY_NAME_INVALID_MESSAGE = f"顯示名稱不可為空，且不超過 {MAX_DISPLAY_NAME_LENGTH} 個字元。"


# ---------------------------------------------------------------------------
# 密碼
# ---------------------------------------------------------------------------

#: 帳號不存在時拿來比對的假雜湊。lazily 產生（產生它本身就要跑一次 scrypt，
#: 不值得在每次 import 時付這個成本）。
_dummy_hash: Optional[str] = None


def _hash_password(password: str) -> str:
    """scrypt 是刻意慢的，而伺服器是 eventlet 單執行緒。

    直接呼叫會把整個 hub 卡住約 100 ms —— 那段時間**所有**使用者的 HTTP 請求
    與 GDB 輸出轉發都停擺（背景見 blocking.py）。沒有速率限制的情況下，連續打
    /login 就等於一個放大過的 DoS。丟到 tpool 執行緒去跑，雜湊參數一個都沒動。
    """
    return blocking.call(generate_password_hash, password)


def _check_password(password_hash: str, password: str) -> bool:
    try:
        return bool(blocking.call(check_password_hash, password_hash, password))
    except (ValueError, TypeError):
        # 壞掉的雜湊字串等於「驗不過」，不是 500。
        logger.warning("[auth] stored password hash could not be parsed")
        return False


def _verify_password(stored_hash: Optional[str], password: str) -> bool:
    """帳號不存在時也跑一次雜湊比對。

    少了這一步，「沒有這個帳號」會在幾微秒內回來，而「密碼錯了」要等 scrypt
    跑完（約 100 ms）。訊息相同但時間差了三個數量級，等於還是有一台帳號存在性
    的探測機——而且是公開註冊的部署，那份名單直接對應到 /u/<username>。
    """
    global _dummy_hash
    if stored_hash is None:
        if _dummy_hash is None:
            _dummy_hash = _hash_password("gdbgui-account-that-does-not-exist")
        _check_password(_dummy_hash, password)
        return False
    return _check_password(stored_hash, password)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


def start_user_session(user_id: int) -> None:
    """登入成功：**整個** session 換新，再放進新身分。

    session.clear() 是必須的，兩個獨立的理由：

    1. Session fixation：登入前後共用同一份 session 內容，等於讓攻擊者可以先
       把一個他知道的 session 餵給受害者。

    2. 前一個使用者的殘留路徑。同一個瀏覽器換人登入時，session 裡還留著
       `uploaded_binary` / `real_src_path` / `virtual_src_path`——那些指向**前一位**
       使用者的 scratch 目錄。/read_file 會把 virtual_src_path 翻譯成
       real_src_path 然後以 root 讀出來，所以不清掉就是一條跨使用者的讀取路徑。
    """
    session.clear()
    session["user_id"] = int(user_id)
    add_csrf_token_to_session()


def end_user_session() -> None:
    session.clear()


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------


@blueprint.route("/login", methods=["GET", "POST"])
def login():
    add_csrf_token_to_session()

    if request.method == "POST":
        username = (request.form.get("username") or "").strip().lower()
        password = request.form.get("password") or ""

        user = db.user_by_username(username) if username else None
        stored_hash = user["password_hash"] if user is not None else None

        if len(password) > MAX_PASSWORD_LENGTH or not _verify_password(
            stored_hash, password
        ):
            # 伺服器 log 裡也不寫是哪一種失敗、不寫嘗試的帳號名——那份 log 之後
            # 若被誰看到，就是一份「有人在猜這些帳號」的清單。
            logger.info("[auth] login attempt refused")
            return (
                render_template(
                    "login.html",
                    error=LOGIN_FAILED_MESSAGE,
                    csrf_token=session["csrf_token"],
                ),
                401,
            )

        start_user_session(int(user["id"]))
        logger.info("[auth] user %s logged in", user["id"])
        return redirect(url_for("http_routes.gdbgui"))

    if current_user_id() is not None:
        return redirect(url_for("http_routes.gdbgui"))

    return render_template("login.html", csrf_token=session["csrf_token"])


@blueprint.route("/register", methods=["GET", "POST"])
def register():
    add_csrf_token_to_session()

    if request.method == "POST":
        username = (request.form.get("username") or "").strip().lower()
        display_name = (request.form.get("display_name") or "").strip()
        password = request.form.get("password") or ""

        error = _validate_registration(username, display_name, password)
        if error is None:
            user_id = db.create_user(username, _hash_password(password), display_name)
            if user_id is None:
                error = USERNAME_TAKEN_MESSAGE

        if error is not None:
            return (
                render_template(
                    "register.html",
                    error=error,
                    username=username,
                    display_name=display_name,
                    csrf_token=session["csrf_token"],
                ),
                400,
            )

        start_user_session(user_id)
        logger.info("[auth] registered user %s", user_id)
        return redirect(url_for("auth.profile", username=username))

    if current_user_id() is not None:
        return redirect(url_for("http_routes.gdbgui"))

    return render_template("register.html", csrf_token=session["csrf_token"])


def _validate_registration(
    username: str, display_name: str, password: str
) -> Optional[str]:
    if not USERNAME_RE.fullmatch(username):
        return USERNAME_INVALID_MESSAGE
    if not display_name or len(display_name) > MAX_DISPLAY_NAME_LENGTH:
        return DISPLAY_NAME_INVALID_MESSAGE
    if any(ch < " " or ch == "\x7f" for ch in display_name):
        # 控制字元在 HTML 裡不可見，但會弄壞 log 與匯出格式。
        return DISPLAY_NAME_INVALID_MESSAGE
    if len(password) < MIN_PASSWORD_LENGTH:
        return PASSWORD_TOO_SHORT_MESSAGE
    if len(password) > MAX_PASSWORD_LENGTH:
        return PASSWORD_TOO_LONG_MESSAGE
    return None


@blueprint.route("/logout", methods=["GET", "POST"])
def logout():
    """登出是狀態變更，所以只有 POST 真的做事。

    GET 只是渲染一個一顆按鈕的確認表單。這樣 `<img src="/logout">` 之類的
    跨站請求動不了任何東西（POST 那條走既有的全域 CSRF 檢查）。
    """
    if request.method == "POST":
        end_user_session()
        return redirect(url_for("auth.login"))

    add_csrf_token_to_session()
    return render_template("logout.html", csrf_token=session["csrf_token"])


@blueprint.route("/u/<username>", methods=["GET"])
def profile(username: str):
    """個人檔案：顯示名稱 + **這個人自己的**教案清單。

    需要登入（不在 PUBLIC_ENDPOINTS 裡）——設計決定是「整個系統都需要登入」，
    個人檔案頁沒有例外。
    """
    user = db.user_by_username((username or "").strip().lower())
    if user is None:
        abort(404)

    lessons = db.lessons_for_user(int(user["id"]))
    add_csrf_token_to_session()
    return render_template(
        "profile.html",
        profile_username=user["username"],
        display_name=user["display_name"],
        created_at=user["created_at"],
        lessons=lessons,
        lesson_tags=tags.tags_for_lessons([row["id"] for row in lessons]),
        is_self=(current_user_id() == int(user["id"])),
        csrf_token=session["csrf_token"],
    )
