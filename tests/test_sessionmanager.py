import time

import pytest

from gdbgui.server import sessionmanager
from gdbgui.server.sandbox import jail_manager


def _shutdown(manager):
    for debug_session in list(manager.debug_session_to_client_ids):
        manager.remove_debug_session(debug_session)


def test_SessionManager(monkeypatch):
    # 這個測試不帶 session_key，所以會走「沒有隔離」的路徑。明確把
    # REQUIRE_ISOLATION 關掉，測的才是 SessionManager 的簿記邏輯本身，
    # 而不是碰巧繼承了容器的環境變數。
    monkeypatch.setattr(jail_manager, "REQUIRE_ISOLATION", False)

    manager = sessionmanager.SessionManager()
    try:
        db_session = manager.add_new_debug_session(
            gdb_command="gdb", mi_version="mi3", client_id="test"
        )
        pid = manager.get_pid_from_debug_session(db_session)
        assert pid
        dashboard_data = manager.get_dashboard_data()
        assert len(dashboard_data) == 1
    finally:
        _shutdown(manager)


def test_gdb_is_refused_when_isolation_is_required_but_absent(monkeypatch):
    """Fail closed。

    沒有 jail 就代表 GDB 與使用者程式會以 root、在沒有 network namespace 的
    情況下執行——那正是子專案 E 要消滅的狀態。部署設定
    （GDBGUI_REQUIRE_ISOLATION=1）下它必須是硬錯誤，不是一行 warning。
    """
    monkeypatch.setattr(jail_manager, "REQUIRE_ISOLATION", True)

    manager = sessionmanager.SessionManager()
    try:
        with pytest.raises(RuntimeError, match="without per-session isolation"):
            manager.add_new_debug_session(
                gdb_command="gdb", mi_version="mi3", client_id="test"
            )
    finally:
        _shutdown(manager)


@pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="needs root + setpriv/unshare/useradd",
)
def test_gdb_runs_as_the_session_account(monkeypatch):
    """GDB 行程本身必須跑在 session 帳號底下，不是只有被除錯的程式。

    跨 uid / 跨 user namespace 的 ptrace 就算給 CAP_SYS_PTRACE 也不會動，
    所以邊界一定要包住 GDB；這個測試守住那個設計決定。
    """
    monkeypatch.setattr(jail_manager, "REQUIRE_ISOLATION", True)
    key = "f" * 32
    jail_manager.release(key)
    jail = jail_manager.acquire(key)
    assert jail is not None

    manager = sessionmanager.SessionManager()
    try:
        debug_session = manager.add_new_debug_session(
            gdb_command="gdb", mi_version="mi3", client_id="test", session_key=key
        )
        pid = debug_session.pid

        def read_uid():
            with open(f"/proc/{pid}/status") as f:
                return int(next(l for l in f if l.startswith("Uid:")).split()[1])

        # setpriv -> unshare -> env -> gdb 全部在同一個 pid 上接力 exec，所以剛
        # fork 完的瞬間還是 root。輪詢等它降權完成，不要用固定 sleep。
        real_uid = read_uid()
        for _ in range(100):
            if real_uid != 0:
                break
            time.sleep(0.05)
            real_uid = read_uid()

        assert real_uid == jail.uid, f"gdb runs as uid {real_uid}, expected {jail.uid}"

        # uid_map 不是 init user namespace 的那條，代表確實在自己的 user namespace 內
        with open(f"/proc/{pid}/uid_map") as f:
            uid_map = f.read().split()
        assert uid_map != ["0", "0", "4294967295"], "gdb is not in its own user namespace"
    finally:
        _shutdown(manager)
        jail_manager.release(key)
