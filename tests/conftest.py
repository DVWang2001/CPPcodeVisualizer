"""測試共用的設定與登入輔助。

## 為什麼要在這裡改資料目錄

`gdbgui.server.app` 在 **import 時**就會 `db.initialize()`（建目錄、套 migration）
並讀出 SECRET_KEY。預設的資料目錄是 `/var/lib/gdbgui`——正在服務的容器裡那就是
真正的使用者資料庫。`docker compose exec gdbgui pytest tests/` 打在線上容器時，
測試會把測試帳號寫進真實資料表。

conftest.py 是 pytest 最先 import 的東西，所以在這裡設環境變數就趕得及在
`gdbgui.server.db` 第一次被 import 之前生效。

## 為什麼登入輔助要走真正的 /register 與 /login

直接 `session["user_id"] = 1` 比較快，但那樣測到的就不是「註冊→登入→拿到身分」
這條真實路徑。這些測試裡有好幾條的主張是「隔離跟著**使用者**走」，用手塞的
session 去測那件事等於自己把要驗的東西假設掉了。
"""

import os
import tempfile
from pathlib import Path
from typing import Optional

import pytest

# ── 必須在 import gdbgui.server.db 之前 ──────────────────────────────────────
_TEST_DATA_DIR = Path(
    os.environ.get("GDBGUI_TEST_DATA_DIR") or tempfile.mkdtemp(prefix="gdbgui-tests-")
)
os.environ["GDBGUI_DATA_DIR"] = str(_TEST_DATA_DIR)

from gdbgui.server import db  # noqa: E402  (順序是刻意的，見上)

# 保險：就算 db 已經被別的東西先 import 過，也把它指到測試目錄。
db.DATA_DIR = _TEST_DATA_DIR

assert db.data_dir() == _TEST_DATA_DIR, (
    "tests must not touch the real database at /var/lib/gdbgui"
)


TEST_PASSWORD = "correct-horse-battery-staple"

_username_counter = 0


def unique_username(prefix: str = "u") -> str:
    """每次呼叫都不一樣，而且符合 auth.USERNAME_RE。

    測試之間不共用帳號：帳號現在**就是**隔離的單位（一個使用者一個 jail、
    一個 debug session），共用帳號會讓兩個測試意外地共用一個 GDB。
    """
    global _username_counter
    _username_counter += 1
    return f"{prefix}{os.getpid()}x{_username_counter}"


class LoggedInUser:
    """一個已登入的瀏覽器：cookie jar、csrf token、user id、owner key。"""

    def __init__(self, app, client, user_id: int, username: str, csrf: str):
        self.app = app
        self.http = client
        self.user_id = user_id
        self.username = username
        self.csrf = csrf
        self.owner_key = owner_key_of(app, client)

    # 舊測試用 `visitor.prefix` 這個名字指同一樣東西（jail 的 key）。
    @property
    def prefix(self) -> str:
        return self.owner_key


def owner_key_of(app, client) -> Optional[str]:
    """這個 client 的 owner key，**用正式的那個函式算**。

    刻意不在測試裡複製 `f"{user_id:016x}"` 這條公式：複製一份之後，
    owner_key() 的實作改了而測試沒改，測試會繼續「通過」。
    """
    from flask import session as flask_session

    from gdbgui.server.http_util import owner_key

    with client.session_transaction() as sess:
        user_id = sess.get("user_id")

    with app.test_request_context():
        if user_id is not None:
            flask_session["user_id"] = user_id
        return owner_key()


def register_user(app, username: Optional[str] = None, password: str = TEST_PASSWORD,
                  display_name: Optional[str] = None) -> LoggedInUser:
    """走真正的 /register 表單註冊並登入，回傳這個瀏覽器。"""
    username = username or unique_username()
    display_name = display_name or f"Test {username}"

    client = app.test_client()
    assert client.get("/register").status_code == 200
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    response = client.post(
        "/register",
        data={
            "csrf_token": csrf,
            "username": username,
            "display_name": display_name,
            "password": password,
        },
    )
    assert response.status_code == 302, response.data

    with client.session_transaction() as sess:
        user_id = sess["user_id"]
        csrf = sess["csrf_token"]

    return LoggedInUser(app, client, int(user_id), username, csrf)


def login_user(app, username: str, password: str = TEST_PASSWORD) -> LoggedInUser:
    """既有帳號、新瀏覽器（模擬換一台電腦登入同一個帳號）。"""
    client = app.test_client()
    assert client.get("/login").status_code == 200
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    response = client.post(
        "/login",
        data={"csrf_token": csrf, "username": username, "password": password},
    )
    assert response.status_code == 302, response.data

    with client.session_transaction() as sess:
        user_id = sess["user_id"]
        csrf = sess["csrf_token"]

    return LoggedInUser(app, client, int(user_id), username, csrf)


@pytest.fixture
def flask_app():
    from gdbgui.server.app import app

    app.config["gdb_command"] = "gdb"
    return app


@pytest.fixture
def logged_in(flask_app):
    """一個全新的已登入使用者，測試結束時把它的 jail 收掉。"""
    from gdbgui.server.sandbox import jail_manager

    user = register_user(flask_app)
    try:
        yield user
    finally:
        jail_manager.release(user.owner_key)
