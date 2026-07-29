import binascii
import logging
import os
from functools import wraps

from flask import Response, abort, current_app, jsonify, request, session

logger = logging.getLogger(__file__)


def add_csrf_token_to_session():
    if "csrf_token" not in session:
        session["csrf_token"] = binascii.hexlify(os.urandom(20)).decode("utf-8")


def owner_key():
    """本次請求的「擁有者身分」—— 授權判斷唯一的身分來源。

    ★ 這是接上登入時要改的那一個地方 ★

    目前回傳 Flask session 的 uploaded_prefix，也就是 jail 已經在用的同一把
    key（jail_manager.acquire(session_key)）。刻意**不另外發明**一組平行身分：
    多一套身分就多一個會跟 jail 對不齊的地方。

    等登入（子專案 A）落地後，這個函式改成回傳 user id 即可，
    debug session 的擁有權判斷（DebugSession.is_owned_by）與所有呼叫端都不用動。

    回傳 None 代表「這個請求沒有身分」。所有判斷都必須 fail closed：
    沒有身分不等於符合任何東西。
    """
    return session.get("uploaded_prefix")


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


def authenticate(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if current_app.config.get("gdbgui_auth_user_credentials") is not None:
            auth = request.authorization
            if (
                not auth
                or not auth.username
                or not auth.password
                or not credentials_are_valid(auth.username, auth.password)
            ):
                return Response(
                    "You must log in to continue.",
                    401,
                    {"WWW-Authenticate": 'Basic realm="gdbgui_login"'},
                )

        return f(*args, **kwargs)

    return wrapper


def credentials_are_valid(username, password):
    user_credentials = current_app.config.get("gdbgui_auth_user_credentials")
    if user_credentials is None:
        return False

    elif len(user_credentials) < 2:
        return False

    return user_credentials[0] == username and user_credentials[1] == password
