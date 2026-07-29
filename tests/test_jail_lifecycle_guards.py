"""兩件事都是「什麼時候可以動用／銷毀 jail 資源」的不變式。

1. 頁面渲染不可以配置 jail。
   GET / 以前無條件 jail_manager.acquire()，於是單純開一個分頁就吃掉一個
   GDBGUI_MAX_SESSIONS 名額，而且要 3600 秒閒置回收才會還。不必登入、不必
   跑任何程式，開 24 個分頁就把所有人擋在門外——pre-auth DoS。

2. reap_orphans() 不可以在別人服務中的時候動手。
   它會刪掉主機上所有 gdbs_* 帳號與 scratch 目錄，等於把當下每個正在除錯的
   使用者踢下線。而 tests/test_backend.py 在 module import 時就呼叫
   run_server()，所以 `docker compose exec gdbgui pytest tests/` 打在正在服務
   的容器上就會發生這件事（實測會）。守門處放在 jail_manager 裡，不是放在測試
   裡——放在測試裡的話下一個測試檔一樣會踩到。
"""

import os
import subprocess
import sys

import pytest

from gdbgui.server.sandbox import jail_manager


# ---------------------------------------------------------------------------
# 1. 頁面渲染不配置 jail
# ---------------------------------------------------------------------------


@pytest.fixture
def flask_app():
    from gdbgui.server.app import app

    app.config["gdb_command"] = "gdb"
    return app


def test_page_loads_do_not_create_jails(flask_app):
    """N 個全新的瀏覽器各載入一次首頁，jail 數量必須完全不動。"""
    before = jail_manager.active_session_count()

    owners = []
    for _ in range(5):
        client = flask_app.test_client()
        assert client.get("/").status_code == 200
        with client.session_transaction() as flask_session:
            # 頁面仍然要建立身分（websocket 那端要用），只是不配置 OS 資源
            owners.append(flask_session["uploaded_prefix"])

    assert len(set(owners)) == 5, "each browser must get its own identity"
    for owner in owners:
        assert jail_manager.get(owner) is None, "a page load created a jail"

    assert jail_manager.active_session_count() == before, (
        f"page loads consumed concurrency slots: {before} -> "
        f"{jail_manager.active_session_count()}"
    )


def test_repeated_page_loads_by_one_browser_do_not_create_jails(flask_app):
    before = jail_manager.active_session_count()
    client = flask_app.test_client()
    for _ in range(10):
        assert client.get("/").status_code == 200
    assert jail_manager.active_session_count() == before


@pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="needs root + setpriv/unshare/useradd to start a confined gdb",
)
def test_starting_a_real_debug_session_still_creates_exactly_one_jail(flask_app):
    """對照組：真的要用的時候還是要拿得到，而且只拿一個。"""
    from gdbgui.server.app import manager, socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=flask_app, socketio=socketio)

    http = flask_app.test_client()
    assert http.get("/").status_code == 200
    with http.session_transaction() as flask_session:
        csrf = flask_session["csrf_token"]
        owner = flask_session["uploaded_prefix"]

    assert jail_manager.get(owner) is None
    before = jail_manager.active_session_count()

    ws = socketio.test_client(
        flask_app,
        namespace="/gdb_listener",
        query_string=f"csrf_token={csrf}",
        flask_test_client=http,
    )
    try:
        event = next(
            m["args"][0]
            for m in ws.get_received("/gdb_listener")
            if m["name"] == "debug_session_connection_event"
        )
        assert event["ok"], event
        assert jail_manager.get(owner) is not None, "starting gdb did not create a jail"
        assert jail_manager.active_session_count() == before + 1
    finally:
        try:
            ws.disconnect(namespace="/gdb_listener")
        except Exception:
            pass
        for debug_session in list(manager.debug_session_to_client_ids):
            manager.remove_debug_session(debug_session)
        jail_manager.release(owner)


# ---------------------------------------------------------------------------
# 2. reap_orphans() 的守門
# ---------------------------------------------------------------------------


# 一個「另一個活著的伺服器」：拿到鎖之後回報一聲，然後等到 stdin 關掉才退出。
# 刻意用 LOCK_NB：拿不到就回報 busy 然後退出，絕不阻塞（會的話測試就掛死，
# 而「拿不到」本身正是這個機制在運作的證據，不是失敗）。
_LOCK_HOLDER = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.stdout.write("busy\\n"); sys.stdout.flush(); raise SystemExit(1)
sys.stdout.write("locked\\n")
sys.stdout.flush()
sys.stdin.read()
"""


@pytest.fixture
def foreign_owner():
    """保證進入測試時：本行程**沒有**擁有權，而且有另一個活著的行程持有它。

    在正在服務的容器裡跑測試時，那個「另一個行程」就是 gdbgui 伺服器本身，
    什麼都不用做——那正是我們要重現的情境（yield None）。在乾淨的容器／CI 裡
    沒有伺服器，就自己起一個持鎖的行程來扮演它。
    """
    if jail_manager.fcntl is None:
        pytest.skip("no fcntl on this platform")
    jail_manager.ensure_scratch_root()

    held_at_entry = jail_manager.owns_scratch_root()
    if not (held_at_entry or jail_manager.claim_scratch_root()):
        # 已經有別人持有（線上伺服器）。就是要測的狀態。
        yield None
        return

    jail_manager.release_scratch_root()
    holder = subprocess.Popen(
        [sys.executable, "-c", _LOCK_HOLDER, str(jail_manager._owner_lock_path())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    line = holder.stdout.readline().strip()
    if line != b"locked":
        holder.kill()
        holder.wait()
        if held_at_entry:
            jail_manager.claim_scratch_root()
        pytest.fail(f"could not stage a foreign lock holder: {line!r}")
    try:
        yield holder
    finally:
        try:
            holder.stdin.close()
        except Exception:
            pass
        holder.wait(timeout=10)
        # 精確還原：測試前沒持有就不要持有著離開（否則後面的測試若呼叫
        # reap_orphans 會突然變成「有權限動手」）。
        jail_manager.release_scratch_root()
        if held_at_entry:
            assert jail_manager.claim_scratch_root()


@pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="reap_orphans is a no-op without root + useradd anyway",
)
def test_reap_orphans_refuses_while_another_process_owns_the_scratch_root(foreign_owner):
    """頭條主張：線上伺服器還活著的時候，測試跑起來不會把使用者的 jail 刪光。"""
    import pwd

    key = "1" * 32
    jail_manager.release(key)
    jail = jail_manager.acquire(key)
    assert jail is not None and jail.dir.is_dir()
    try:
        # 從 _jails 拿掉，模擬「這個 jail 屬於另一個行程（線上伺服器）的簿記」——
        # 否則會被 reap_orphans 的「本行程還有活著的 session」那道檢查擋掉，
        # 測不到我們要測的那一道。
        with jail_manager._lock:
            jail_manager._jails.pop(key, None)

        assert jail_manager.reap_orphans() == 0

        assert jail.dir.is_dir(), "reap_orphans deleted a live session's scratch dir"
        assert pwd.getpwnam(jail.name), "reap_orphans deleted a live session's account"
    finally:
        with jail_manager._lock:
            jail_manager._jails[key] = jail
        jail_manager.release(key)


def test_reap_orphans_refuses_when_it_cannot_claim_ownership(monkeypatch):
    """守門在 reap_orphans 自己身上，不在呼叫端——任何呼叫者都被擋住。"""
    if jail_manager._missing_prerequisites():
        pytest.skip("reap_orphans short-circuits before the guard on this platform")

    monkeypatch.setattr(jail_manager, "claim_scratch_root", lambda: False)

    deleted = []
    monkeypatch.setattr(
        jail_manager, "_delete_account",
        lambda *args, **kwargs: deleted.append(args),
    )

    assert jail_manager.reap_orphans() == 0
    assert deleted == [], "reap_orphans deleted accounts without owning the root"


def test_reap_orphans_refuses_while_this_process_has_live_sessions(monkeypatch):
    """run_server() 被重複呼叫（tests/test_backend.py 的 test_same_port 就是）
    不可以把自己剛開的 session 清掉。"""
    if jail_manager._missing_prerequisites():
        pytest.skip("reap_orphans short-circuits before the guard on this platform")

    monkeypatch.setattr(jail_manager, "claim_scratch_root", lambda: True)
    monkeypatch.setattr(
        jail_manager, "_jails",
        {"2" * 32: jail_manager.Jail("2" * 32, "gdbs_fake", 12345, 12345,
                                     jail_manager.SCRATCH_ROOT / "gdbs_fake")},
    )

    deleted = []
    monkeypatch.setattr(
        jail_manager, "_delete_account",
        lambda *args, **kwargs: deleted.append(args),
    )

    assert jail_manager.reap_orphans() == 0
    assert deleted == []


@pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="claiming the scratch root needs to be able to create it",
)
def test_the_scratch_root_lock_is_exclusive_across_processes(foreign_owner):
    """正向對照：鎖真的是互斥的，不是一個永遠回 False 的空殼。

    要能收掉那個持鎖的行程才做得了「放開之後就拿得到」這一半，所以只在
    我們自己起了 holder 的情況下跑（線上伺服器我們當然不會去關掉它）。
    """
    if foreign_owner is None:
        pytest.skip("the live server owns the lock; not going to shut it down to test")

    assert not jail_manager.owns_scratch_root()
    assert jail_manager.claim_scratch_root() is False

    foreign_owner.stdin.close()
    foreign_owner.wait(timeout=10)

    assert jail_manager.claim_scratch_root() is True
    assert jail_manager.owns_scratch_root()
