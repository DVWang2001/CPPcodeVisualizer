"""隔離跟著**使用者**走，不是跟著瀏覽器 cookie 走。

這是 `owner_key()` 換綁之後最需要驗證的性質。子專案 E 建立的執行隔離
（per-session OS 帳號 + 0700 scratch + user/net namespace）全部以 `owner_key()`
為鍵；把那個函式的來源從「Flask cookie 裡的 uploaded_prefix」換成「登入的
user id」之後，E 的隔離必須**自動**跟著使用者，那些程式碼一行都不用改。

兩條主張互為對照，缺一條就測不出東西：

  * 兩個帳號 → **不同**的 OS 帳號與 scratch 目錄
    （少了這條，「所有人共用一個 jail」會通過）
  * 同一個帳號的兩個瀏覽器 → **同一個** OS 帳號與 scratch 目錄
    （少了這條，「悄悄退回 per-cookie」會通過——per-cookie 也滿足第一條）

必須在容器內、以 root 執行。
"""

import os
import stat

import pytest

from gdbgui.server.sandbox import jail_manager

from .conftest import login_user, register_user


pytestmark = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="per-session execution isolation needs root + setpriv/unshare/useradd",
)


@pytest.fixture
def gdbgui_app():
    from gdbgui.server.app import app, manager, socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=app, socketio=socketio)
    app.config["gdb_command"] = "gdb"
    try:
        yield app, manager, socketio
    finally:
        for debug_session in list(manager.debug_session_to_client_ids):
            manager.remove_debug_session(debug_session)


def _open_debug_session(app, socketio, user):
    """開一個 websocket 並確認 GDB 真的起來了（＝jail 真的被配置了）。"""
    ws = socketio.test_client(
        app,
        namespace="/gdb_listener",
        query_string=f"csrf_token={user.csrf}",
        flask_test_client=user.http,
    )
    event = next(
        message["args"][0]
        for message in ws.get_received("/gdb_listener")
        if message["name"] == "debug_session_connection_event"
    )
    assert event["ok"], event
    return ws, event


# ---------------------------------------------------------------------------
# 頭條主張：兩個帳號 → 兩個 OS 帳號、兩個 scratch 目錄
# ---------------------------------------------------------------------------


def test_two_accounts_get_different_os_accounts_and_scratch_dirs(gdbgui_app):
    app, manager, socketio = gdbgui_app

    alice = register_user(app)
    bob = register_user(app)
    assert alice.owner_key != bob.owner_key

    alice_ws = bob_ws = None
    try:
        alice_ws, alice_event = _open_debug_session(app, socketio, alice)
        bob_ws, bob_event = _open_debug_session(app, socketio, bob)

        alice_jail = jail_manager.get(alice.owner_key)
        bob_jail = jail_manager.get(bob.owner_key)
        assert alice_jail is not None, "alice's debug session did not get a jail"
        assert bob_jail is not None, "bob's debug session did not get a jail"

        # 不同的作業系統帳號
        assert alice_jail.uid != bob_jail.uid
        assert alice_jail.name != bob_jail.name
        assert alice_jail.uid > 0 and bob_jail.uid > 0, "a session ran as root"

        # 不同的 scratch 目錄，而且各自 0700、屬於各自的帳號
        assert alice_jail.dir != bob_jail.dir
        for jail in (alice_jail, bob_jail):
            info = os.stat(jail.dir)
            assert info.st_uid == jail.uid
            assert stat.S_IMODE(info.st_mode) == 0o700

        # 不同的 GDB 行程，而且各自只認自己的擁有者
        assert alice_event["pid"] != bob_event["pid"]
        alice_sessions = manager.debug_sessions_owned_by(alice.owner_key)
        bob_sessions = manager.debug_sessions_owned_by(bob.owner_key)
        assert len(alice_sessions) == 1 and len(bob_sessions) == 1
        assert alice_sessions[0] is not bob_sessions[0]
        assert not alice_sessions[0].is_owned_by(bob.owner_key)
        assert not bob_sessions[0].is_owned_by(alice.owner_key)
    finally:
        for ws in (alice_ws, bob_ws):
            if ws is not None:
                try:
                    ws.disconnect(namespace="/gdb_listener")
                except Exception:
                    pass
        for user in (alice, bob):
            jail_manager.release(user.owner_key)


def test_one_account_in_two_browsers_shares_one_os_account(gdbgui_app):
    """對照組：這一條會擋下「悄悄退回 per-cookie 身分」。

    per-cookie 的實作一樣會讓兩個帳號拿到不同的 jail（上面那條照樣過），
    差別在這裡：兩個瀏覽器同一個帳號時，per-cookie 會給兩個 jail，
    per-user 只給一個。
    """
    app, manager, socketio = gdbgui_app

    first = register_user(app)
    second = login_user(app, first.username)   # 另一個 cookie jar，同一個帳號
    assert first.owner_key == second.owner_key

    ws1 = ws2 = None
    try:
        slots_before = jail_manager.active_session_count()
        ws1, event1 = _open_debug_session(app, socketio, first)
        ws2, event2 = _open_debug_session(app, socketio, second)

        assert event1["started_new_gdb_process"] is True
        assert event2["started_new_gdb_process"] is False, (
            "the second browser started its own gdb -- identity fell back to the cookie"
        )
        assert event2["pid"] == event1["pid"]

        # 只多了一個併發名額，不是兩個
        assert jail_manager.active_session_count() == slots_before + 1

        jail = jail_manager.get(first.owner_key)
        assert jail is not None
        assert jail_manager.get(second.owner_key) is jail

        owned = manager.debug_sessions_owned_by(first.owner_key)
        assert len(owned) == 1
        assert len(owned[0].client_ids) == 2
    finally:
        for ws in (ws1, ws2):
            if ws is not None:
                try:
                    ws.disconnect(namespace="/gdb_listener")
                except Exception:
                    pass
        jail_manager.release(first.owner_key)


def test_one_account_cannot_attach_to_another_accounts_gdb(gdbgui_app):
    """授權那一半：知道對方的 gdbpid 也接不上去。

    gdbpid 是可列舉的小整數，而 attach 上去等於取得那個 GDB 的完整控制權
    （讀對方記憶體、在對方的 jail 裡執行程式）。
    """
    app, manager, socketio = gdbgui_app

    victim = register_user(app)
    attacker = register_user(app)

    victim_ws = attacker_ws = None
    try:
        victim_ws, victim_event = _open_debug_session(app, socketio, victim)
        victim_pid = victim_event["pid"]

        attacker_ws = socketio.test_client(
            app,
            namespace="/gdb_listener",
            query_string=f"csrf_token={attacker.csrf}&gdbpid={victim_pid}",
            flask_test_client=attacker.http,
        )
        attacker_event = next(
            message["args"][0]
            for message in attacker_ws.get_received("/gdb_listener")
            if message["name"] == "debug_session_connection_event"
        )

        assert attacker_event["ok"] is False, "attached to another account's gdb"
        assert str(victim_pid) not in attacker_event["message"]

        victim_sessions = manager.debug_sessions_owned_by(victim.owner_key)
        assert len(victim_sessions) == 1
        assert len(victim_sessions[0].client_ids) == 1
    finally:
        for ws in (victim_ws, attacker_ws):
            if ws is not None:
                try:
                    ws.disconnect(namespace="/gdb_listener")
                except Exception:
                    pass
        for user in (victim, attacker):
            jail_manager.release(user.owner_key)


def test_one_accounts_program_cannot_read_another_accounts_scratch(gdbgui_app):
    """端對端：真的編譯、真的執行、真的去讀對方的檔案，然後主張那必須失敗。

    tests/test_execution_isolation.py 測的是同一件事但用手工造的 session key；
    這裡走的是完整路徑——註冊、登入、POST /create_and_upload——所以它同時證明
    「編譯出來的東西落在**這個使用者**的 jail 裡」。
    """
    app, _manager, _socketio = gdbgui_app

    alice = register_user(app)
    bob = register_user(app)

    try:
        secret = "SECRET-BELONGING-TO-ALICE-9f3c1e"
        alice_binary = _compile(alice, f'#include <cstdio>\nint main(){{ printf("{secret}"); }}\n')
        alice_jail = jail_manager.get(alice.owner_key)
        assert alice_jail is not None
        alice_source = alice_binary.rsplit(".", 1)[0] + ".cpp"

        result = _compile_and_capture(
            bob,
            f"""
            #include <cstdio>
            #include <cerrno>
            int main() {{
                FILE* f = fopen("{alice_source}", "r");
                if (f) {{ printf("READ_OK\\n"); fclose(f); }}
                else   {{ printf("READ_DENIED:errno=%d\\n", errno); }}
                return 0;
            }}
            """,
        )
        assert "READ_DENIED:errno=13" in result, result   # EACCES
        assert "READ_OK" not in result
    finally:
        for user in (alice, bob):
            jail_manager.release(user.owner_key)


def _compile(user, code: str) -> str:
    response = user.http.post(
        "/create_and_upload",
        data={"csrf_token": user.csrf, "code": code},
        headers={"Accept": "application/json", "x-csrftoken": user.csrf},
    )
    assert response.status_code == 200, response.data
    body = response.get_json()
    assert body["status"] == "success", body
    return body["binary_path"]


def _compile_and_capture(user, code: str) -> str:
    """編譯並在該使用者自己的 jail 內執行，回傳 stdout。"""
    import subprocess

    binary = _compile(user, code)
    jail = jail_manager.get(user.owner_key)
    assert jail is not None
    completed = subprocess.run(
        jail_manager.confine(jail, [binary]),
        capture_output=True,
        text=True,
        timeout=60,
    )
    return completed.stdout
