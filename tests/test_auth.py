"""認證、資料層、身分接縫的測試。

對應設計文件的驗證項目 1–6 與 8：
  1. migration 從空資料庫套到最新版，重複執行為 idempotent
  2. 密碼雜湊有 salt；正確密碼過、錯誤密碼不過
  3. 註冊：重複 username 被拒
  4. 登入錯誤訊息對「帳號不存在」與「密碼錯誤」完全相同
  5. owner_key() 登入後回傳 user id、未登入回 None
  6. 個人檔案頁只列出該使用者的教案
  8. 未登入的 websocket 連線被拒絕，即使帶著有效的 CSRF token
"""

import sqlite3
from contextlib import closing

import pytest
from werkzeug.security import check_password_hash, generate_password_hash

from gdbgui.server import auth, db
from gdbgui.server.http_util import current_user_id, owner_key

from .conftest import TEST_PASSWORD, login_user, register_user, unique_username


# ---------------------------------------------------------------------------
# 1. Migration
# ---------------------------------------------------------------------------


@pytest.fixture
def empty_db(tmp_path, monkeypatch):
    """一個全新的空資料庫目錄（不碰測試共用的那個）。"""
    data_dir = tmp_path / "data"
    monkeypatch.setattr(db, "DATA_DIR", data_dir)
    return data_dir


def test_migrations_apply_from_an_empty_database(empty_db):
    assert db.schema_version() == 0

    applied = db.migrate()

    assert applied == len(db.migration_files()) >= 1
    assert db.schema_version() == applied

    with closing(db.connect()) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {"users", "lessons", "schema_version"} <= tables


def test_migrations_are_idempotent(empty_db):
    first = db.migrate()
    assert first >= 1

    # 第二次什麼都不該做
    assert db.migrate() == 0
    # 第三次也一樣（不是「第二次剛好」）
    assert db.migrate() == 0
    assert db.schema_version() == first


def test_migrations_do_not_lose_data_when_re_run(empty_db):
    db.migrate()
    user_id = db.create_user("keeper", "hash", "Keeper")
    assert user_id is not None

    db.migrate()

    assert db.user_by_id(user_id)["username"] == "keeper"


def test_wal_is_on(empty_db):
    db.migrate()
    with closing(db.connect()) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_the_data_directory_is_not_readable_by_other_accounts(empty_db):
    """SECRET_KEY 與密碼雜湊住在這裡，而同一個容器裡跑著不可信的 session 帳號。"""
    import os
    import stat

    if os.name != "posix":
        pytest.skip("POSIX permission semantics only")

    db.ensure_data_dir()
    mode = stat.S_IMODE(os.stat(empty_db).st_mode)
    assert mode & 0o077 == 0, f"data dir is {mode:04o}, must be 0700"


def test_the_secret_key_is_persistent_and_private(empty_db):
    import os
    import stat

    first = db.get_or_create_secret_key()
    assert len(first) >= 32

    # 再讀一次拿到**同一把**——這就是「重啟後不會把所有人登出」的機制。
    assert db.get_or_create_secret_key() == first

    if os.name == "posix":
        mode = stat.S_IMODE(os.stat(db.secret_key_path()).st_mode)
        assert mode & 0o077 == 0, f"secret key file is {mode:04o}, must be 0600"


def test_a_truncated_secret_key_file_is_refused(empty_db):
    """壞掉的金鑰檔要炸掉，不能靜靜地拿一個弱金鑰去簽 session。"""
    db.ensure_data_dir()
    db.secret_key_path().write_text("short")
    with pytest.raises(db.DatabaseError):
        db.get_or_create_secret_key()


# ---------------------------------------------------------------------------
# 2. 密碼雜湊
# ---------------------------------------------------------------------------


def test_the_same_password_hashes_differently_every_time():
    """有 salt。兩次相同結果就代表沒有 salt，彩虹表直接對得上。"""
    a = generate_password_hash(TEST_PASSWORD)
    b = generate_password_hash(TEST_PASSWORD)
    assert a != b


def test_hashes_verify_the_right_password_and_only_that_one():
    stored = generate_password_hash(TEST_PASSWORD)
    assert check_password_hash(stored, TEST_PASSWORD)
    assert not check_password_hash(stored, TEST_PASSWORD + "x")
    assert not check_password_hash(stored, "")


def test_the_plaintext_password_is_never_stored(flask_app):
    user = register_user(flask_app)
    row = db.user_by_username(user.username)
    assert row is not None
    assert TEST_PASSWORD not in row["password_hash"]
    assert check_password_hash(row["password_hash"], TEST_PASSWORD)


def test_a_broken_stored_hash_is_a_failed_login_not_a_crash():
    assert auth._check_password("not-a-real-hash", "anything") is False


# ---------------------------------------------------------------------------
# 3. 註冊
# ---------------------------------------------------------------------------


def test_duplicate_usernames_are_rejected(flask_app):
    user = register_user(flask_app)

    client = flask_app.test_client()
    client.get("/register")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    response = client.post(
        "/register",
        data={
            "csrf_token": csrf,
            "username": user.username,
            "display_name": "Impostor",
            "password": "another-password",
        },
    )

    assert response.status_code == 400
    assert auth.USERNAME_TAKEN_MESSAGE in response.data.decode()
    # 而且沒有登入成任何人
    with client.session_transaction() as sess:
        assert "user_id" not in sess


def test_duplicate_usernames_are_rejected_at_the_database_too(empty_db):
    """UNIQUE 約束才是仲裁者，不是應用層的「先查再寫」。"""
    db.migrate()
    assert db.create_user("taken", "hash", "First") is not None
    assert db.create_user("taken", "other-hash", "Second") is None

    with closing(db.connect()) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE username = ?", ("taken",)
        ).fetchone()[0]
    assert count == 1


@pytest.mark.parametrize(
    "username",
    [
        "ab",                       # 太短
        "a" * 33,                   # 太長
        "has space",
        "has/slash",                # 會改變 /u/<username> 的路徑意義
        "has.dot",
        "-leading",
        "trailing-",
        "../etc",
        "",
    ],
)
def test_invalid_usernames_are_rejected(flask_app, username):
    client = flask_app.test_client()
    client.get("/register")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    response = client.post(
        "/register",
        data={
            "csrf_token": csrf,
            "username": username,
            "display_name": "Someone",
            "password": TEST_PASSWORD,
        },
    )
    assert response.status_code == 400, username
    with client.session_transaction() as sess:
        assert "user_id" not in sess


def test_usernames_are_case_folded_so_lookalikes_cannot_coexist(flask_app):
    """`Alice` 與 `alice` 必須是同一個帳號。

    兩個只差大小寫的帳號並存，等於一個可以冒充另一個——而 username 同時是
    個人檔案的網址，看到 /u/Alice 的人沒有理由懷疑那不是 alice。
    """
    mixed_case = unique_username("Mixed")   # 含大寫
    user = register_user(flask_app, username=mixed_case)
    assert user.username == mixed_case      # 送進去的原字串
    assert db.user_by_username(mixed_case.lower()) is not None
    assert db.user_by_username(mixed_case) is None, "the stored username is not folded"

    client = flask_app.test_client()
    client.get("/register")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    response = client.post(
        "/register",
        data={
            "csrf_token": csrf,
            "username": mixed_case.lower(),
            "display_name": "Impostor",
            "password": TEST_PASSWORD,
        },
    )
    assert response.status_code == 400
    assert auth.USERNAME_TAKEN_MESSAGE in response.data.decode()


def test_short_passwords_are_rejected(flask_app):
    client = flask_app.test_client()
    client.get("/register")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    response = client.post(
        "/register",
        data={
            "csrf_token": csrf,
            "username": unique_username(),
            "display_name": "Someone",
            "password": "short",
        },
    )
    assert response.status_code == 400
    assert auth.PASSWORD_TOO_SHORT_MESSAGE in response.data.decode()


def test_registration_is_open_to_anyone(flask_app):
    """公開註冊是設計決定（首次部署不需要 bootstrap 流程）。"""
    before = db.user_count()
    register_user(flask_app)
    register_user(flask_app)
    assert db.user_count() == before + 2


# ---------------------------------------------------------------------------
# 4. 登入失敗必須同形
# ---------------------------------------------------------------------------


def test_both_login_failure_paths_are_identical(flask_app):
    """「沒有這個帳號」與「密碼錯了」不可以有任何可觀察的差別。

    公開註冊 + 個人檔案網址就是 /u/<username>，所以一個能分辨「帳號存不存在」
    的登入頁等於一台帳號列舉機。

    兩次嘗試刻意用**同一個瀏覽器**：不同的 client 有不同的 csrf token，那個
    token 會被渲染進表單裡，兩份 HTML 就一定不一樣，比對就變成空的。
    """
    user = register_user(flask_app)

    client = flask_app.test_client()
    assert client.get("/login").status_code == 200
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    def attempt(username, password):
        return client.post(
            "/login",
            data={"csrf_token": csrf, "username": username, "password": password},
        )

    no_such_user = attempt(unique_username("ghost"), TEST_PASSWORD)
    wrong_password = attempt(user.username, "not-the-password")

    assert no_such_user.status_code == wrong_password.status_code == 401
    assert no_such_user.data == wrong_password.data
    assert auth.LOGIN_FAILED_MESSAGE in no_such_user.data.decode()
    # 送上去的帳號名不可以被回音進頁面裡（那也是一種可觀察的差別）
    assert user.username not in wrong_password.data.decode()


def test_a_failed_login_does_not_create_a_session(flask_app):
    user = register_user(flask_app)
    client = flask_app.test_client()
    client.get("/login")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    client.post(
        "/login",
        data={"csrf_token": csrf, "username": user.username, "password": "wrong"},
    )
    with client.session_transaction() as sess:
        assert "user_id" not in sess


def test_a_correct_login_works(flask_app):
    """反向對照：上面那些不是靠「登入永遠失敗」通過的。"""
    user = register_user(flask_app)
    second_browser = login_user(flask_app, user.username)
    assert second_browser.user_id == user.user_id
    assert second_browser.http.get("/").status_code == 200


def test_logging_in_replaces_the_whole_session(flask_app):
    """換人登入時，前一個人留在 session 裡的路徑必須消失。

    session 裡有 uploaded_binary / real_src_path，指向**前一位**使用者的 scratch
    目錄。/read_file 會把 virtual_src_path 翻成 real_src_path 然後以 root 讀出來，
    所以不清掉 session 就是一條跨使用者的讀取路徑（同一台公用電腦換人登入）。
    """
    alice = register_user(flask_app)
    bob_username = unique_username("bob")
    register_user(flask_app, username=bob_username)

    client = alice.http
    with client.session_transaction() as sess:
        sess["uploaded_binary"] = "/srv/gdbgui-scratch/alice/secret.a"
        sess["real_src_path"] = "/srv/gdbgui-scratch/alice/secret.cpp"
        sess["virtual_src_path"] = "/workspace/main.cpp"

    client.get("/login")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    response = client.post(
        "/login",
        data={"csrf_token": csrf, "username": bob_username, "password": TEST_PASSWORD},
    )
    assert response.status_code == 302

    with client.session_transaction() as sess:
        assert "uploaded_binary" not in sess
        assert "real_src_path" not in sess
        assert "virtual_src_path" not in sess


def test_logging_out_clears_the_session(flask_app):
    user = register_user(flask_app)

    response = user.http.post("/logout", data={"csrf_token": user.csrf})
    assert response.status_code == 302

    with user.http.session_transaction() as sess:
        assert "user_id" not in sess
    # 而且真的回到被擋在門外的狀態
    assert user.http.get("/").status_code == 302


def test_logout_does_nothing_on_GET(flask_app):
    """登出是狀態變更，只有 POST 做事（GET 只渲染一顆按鈕）。"""
    user = register_user(flask_app)
    assert user.http.get("/logout").status_code == 200
    with user.http.session_transaction() as sess:
        assert "user_id" in sess


# ---------------------------------------------------------------------------
# 5. owner_key —— 這一整個切片的接縫
# ---------------------------------------------------------------------------


def test_owner_key_follows_the_logged_in_user(flask_app):
    user = register_user(flask_app)
    assert user.owner_key == f"{user.user_id:016x}"


def test_owner_key_is_none_when_logged_out(flask_app):
    """Fail closed。「沒有身分」絕不能等於「符合某個沒有擁有者的 session」
    ——那是 93e829d 已經確立的不變式。"""
    from flask import session as flask_session

    with flask_app.test_request_context():
        assert owner_key() is None
        assert current_user_id() is None

    # 壞掉／被竄改成別的型別的 session 一樣是「沒有身分」，不是一個怪 key
    for bad in ("7", 0, -1, True, None, [7], {"id": 7}):
        with flask_app.test_request_context():
            flask_session["user_id"] = bad
            assert owner_key() is None, bad


def test_owner_key_is_the_same_for_two_browsers_of_one_user(flask_app):
    """副作用（與設計一致）：同一個人用兩個瀏覽器登入拿到同一個 jail
    與同一個 debug session。以 cookie 為鍵時它們是分開的。"""
    first = register_user(flask_app)
    second = login_user(flask_app, first.username)
    assert first.owner_key == second.owner_key


def test_owner_key_differs_between_users(flask_app):
    a = register_user(flask_app)
    b = register_user(flask_app)
    assert a.owner_key != b.owner_key


def test_owner_key_is_a_valid_jail_session_key(flask_app):
    """jail_manager 會把它放進 useradd 的 argv，所以形狀必須通過它的驗證。

    這是兩個模組之間的契約：owner_key() 改成回傳別的形狀（例如 int 的
    str()、或含連字號的 uuid）時，除錯 session 會在起 GDB 的那一刻才爆掉。
    """
    from gdbgui.server.sandbox import jail_manager

    user = register_user(flask_app)
    assert jail_manager._SESSION_KEY_RE.fullmatch(user.owner_key), user.owner_key
    # 不會拋 JailError（真的建立 jail 需要 root，那在別的測試檔）
    assert jail_manager._validate_session_key(user.owner_key) == user.owner_key


# ---------------------------------------------------------------------------
# 6. 個人檔案
# ---------------------------------------------------------------------------


def _insert_lesson(user_id: int, title: str) -> None:
    """這一輪沒有寫入 lessons 的路徑（那是下一個切片），所以測試自己寫。"""
    with closing(db.connect()) as conn:
        conn.execute(
            "INSERT INTO lessons (user_id, title, bundle_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, title, "{}", "2026-07-29", "2026-07-29"),
        )
        conn.commit()


def test_a_profile_shows_the_display_name(flask_app):
    user = register_user(flask_app, display_name="王小明")
    body = user.http.get(f"/u/{user.username}").data.decode()
    assert "王小明" in body
    assert user.username in body


def test_a_profile_lists_only_its_owners_lessons(flask_app):
    alice = register_user(flask_app)
    bob = register_user(flask_app)

    _insert_lesson(alice.user_id, "ALICE-LESSON-a1b2")
    _insert_lesson(bob.user_id, "BOB-LESSON-c3d4")

    alice_page = alice.http.get(f"/u/{alice.username}").data.decode()
    assert "ALICE-LESSON-a1b2" in alice_page
    assert "BOB-LESSON-c3d4" not in alice_page

    # 看別人的個人檔案時，看到的也只有那個人的教案
    bob_page_seen_by_alice = alice.http.get(f"/u/{bob.username}").data.decode()
    assert "BOB-LESSON-c3d4" in bob_page_seen_by_alice
    assert "ALICE-LESSON-a1b2" not in bob_page_seen_by_alice


def test_a_profile_never_leaks_the_password_hash(flask_app):
    user = register_user(flask_app)
    row = db.user_by_username(user.username)
    body = user.http.get(f"/u/{user.username}").data.decode()
    assert row["password_hash"] not in body
    assert "scrypt" not in body


def test_an_unknown_profile_is_404(logged_in):
    assert logged_in.http.get("/u/nobodyhere").status_code == 404


def test_a_display_name_cannot_inject_html(flask_app):
    """display_name 是使用者輸入，會被渲染在別人看得到的頁面上。"""
    user = register_user(flask_app, display_name="<script>alert(1)</script>")
    body = user.http.get(f"/u/{user.username}").data.decode()
    assert "<script>alert(1)</script>" not in body
    assert "&lt;script&gt;" in body


def test_lesson_titles_are_parameterised_not_concatenated(flask_app):
    """SQL injection 的直接證據：一個含引號與 `--` 的標題只是一個標題。"""
    user = register_user(flask_app)
    nasty = "'); DROP TABLE users; --"
    _insert_lesson(user.user_id, nasty)

    lessons = db.lessons_for_user(user.user_id)
    assert [row["title"] for row in lessons] == [nasty]
    # users 還在
    assert db.user_by_id(user.user_id) is not None


def test_a_username_lookup_cannot_be_injected(flask_app):
    register_user(flask_app)
    assert db.user_by_username("' OR 1=1 --") is None


# ---------------------------------------------------------------------------
# 8. WebSocket
# ---------------------------------------------------------------------------


@pytest.fixture
def gdbgui_socketio(flask_app):
    from gdbgui.server.app import manager, socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=flask_app, socketio=socketio)
    try:
        yield socketio
    finally:
        for debug_session in list(manager.debug_session_to_client_ids):
            manager.remove_debug_session(debug_session)


def test_an_unauthenticated_websocket_is_refused_even_with_a_valid_csrf_token(
    flask_app, gdbgui_socketio
):
    """HTTP 擋住而 websocket 沒擋等於沒擋——驅動 GDB 的就是這條連線。

    CSRF token 是任何訪客 GET 一次登入頁就拿得到的東西：它證明「這個請求來自
    這個瀏覽器的 session」，不證明「這個 session 是誰」。所以這條測試刻意帶著
    一個**有效**的 token，證明擋下來的是身分檢查而不是 CSRF 檢查。
    """
    http = flask_app.test_client()
    assert http.get("/login").status_code == 200
    with http.session_transaction() as sess:
        csrf = sess["csrf_token"]

    ws = gdbgui_socketio.test_client(
        flask_app,
        namespace="/gdb_listener",
        query_string=f"csrf_token={csrf}",
        flask_test_client=http,
    )

    assert not ws.is_connected("/gdb_listener"), (
        "an anonymous websocket stayed connected -- it can start gdb and run code"
    )


def test_an_unauthenticated_websocket_starts_no_debug_session(
    flask_app, gdbgui_socketio
):
    from gdbgui.server.app import manager

    before = len(manager.debug_session_to_client_ids)

    http = flask_app.test_client()
    http.get("/login")
    with http.session_transaction() as sess:
        csrf = sess["csrf_token"]

    gdbgui_socketio.test_client(
        flask_app,
        namespace="/gdb_listener",
        query_string=f"csrf_token={csrf}",
        flask_test_client=http,
    )

    assert len(manager.debug_session_to_client_ids) == before
