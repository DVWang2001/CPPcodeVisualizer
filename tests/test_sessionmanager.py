import time

import pytest

from gdbgui.server import sessionmanager
from gdbgui.server.sandbox import jail_manager


# 兩個「Flask session 的 uploaded_prefix」。形狀跟 uuid4().hex 一樣（32 hex），
# 因為那就是正式環境用的東西。
OWNER_A = "a" * 32
OWNER_B = "b" * 32


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
            gdb_command="gdb", mi_version="mi3", client_id="test",
            session_key=OWNER_A,
        )
        pid = manager.get_pid_from_debug_session(db_session)
        assert pid
        dashboard_data = manager.get_dashboard_data(owner_key=OWNER_A)
        assert len(dashboard_data) == 1
        # dashboard 只列自己的：別人看不到這個 session
        assert manager.get_dashboard_data(owner_key=OWNER_B) == []
        assert manager.get_dashboard_data(owner_key=None) == []
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


# ---------------------------------------------------------------------------
# debug session 的擁有權
#
# 在此之前 connect_client_to_debug_session() 只是「把 desired_gdbpid 查出來然後
# 接上去」，完全沒有擁有者檢查，而 desired_gdbpid 直接來自 request.args。
# pid 是可列舉的小整數，所以在多人部署上等於：任何人都能取得任何人 GDB 的完整
# 控制權 —— 讀對方記憶體、下任意 GDB 指令、在對方的 jail 帳號裡執行程式。
# ---------------------------------------------------------------------------


@pytest.fixture
def manager(monkeypatch):
    """不帶 jail 的 SessionManager。

    擁有權必須在**沒有隔離**的環境下也成立，所以這些測試刻意關掉
    REQUIRE_ISOLATION：測的是授權邏輯本身，不是 jail。
    """
    monkeypatch.setattr(jail_manager, "REQUIRE_ISOLATION", False)
    mgr = sessionmanager.SessionManager()
    try:
        yield mgr
    finally:
        _shutdown(mgr)


def _start(manager, owner, client_id):
    return manager.add_new_debug_session(
        gdb_command="gdb", mi_version="mi3", client_id=client_id, session_key=owner
    )


def test_attaching_to_another_users_gdbpid_is_refused(manager):
    """頭條主張：別人的 gdbpid 接不上去。"""
    victim = _start(manager, OWNER_A, "victim_tab")

    with pytest.raises(ValueError):
        manager.connect_client_to_debug_session(
            desired_gdbpid=victim.pid, client_id="attacker_tab", owner_key=OWNER_B
        )

    # 被拒絕就是被拒絕：不可以留下任何殘留的連結
    assert victim.client_ids == {"victim_tab"}
    assert "attacker_tab" not in manager.debug_session_to_client_ids[victim]
    assert manager.debug_session_from_client_id("attacker_tab") is None


def test_attaching_without_any_identity_is_refused(manager):
    """Fail closed：沒有身分（owner_key 為 None／空字串）不等於符合任何東西。"""
    victim = _start(manager, OWNER_A, "victim_tab")

    for no_identity in (None, ""):
        with pytest.raises(ValueError):
            manager.connect_client_to_debug_session(
                desired_gdbpid=victim.pid, client_id="anon", owner_key=no_identity
            )
    assert victim.client_ids == {"victim_tab"}


def test_a_session_with_no_owner_belongs_to_nobody(manager):
    """沒有記錄擁有者的 session（本機 CLI／單元測試路徑）誰都接不上去。

    否則「沒有身分」會變成一把萬用鑰匙。
    """
    ownerless = _start(manager, None, "local_tab")
    assert ownerless.owner_key is None

    for key in (OWNER_A, None, ""):
        with pytest.raises(ValueError):
            manager.connect_client_to_debug_session(
                desired_gdbpid=ownerless.pid, client_id="someone", owner_key=key
            )


def test_refusal_does_not_reveal_whether_the_pid_exists(manager):
    """拒絕訊息不可以變成「哪些 pid 是別人的 GDB」的 oracle。

    存在但不屬於你 / 根本不存在，兩者必須完全同形：同一個例外型別、
    同一句訊息。差一個字都足以讓人用可列舉的小整數把別人的 session 掃出來。
    """
    victim = _start(manager, OWNER_A, "victim_tab")

    unused_pid = victim.pid + 7919  # 這個 manager 裡絕不存在的 pid
    assert manager.debug_session_from_pid(unused_pid) is None

    with pytest.raises(ValueError) as exists_but_foreign:
        manager.connect_client_to_debug_session(
            desired_gdbpid=victim.pid, client_id="attacker", owner_key=OWNER_B
        )
    with pytest.raises(ValueError) as does_not_exist:
        manager.connect_client_to_debug_session(
            desired_gdbpid=unused_pid, client_id="attacker", owner_key=OWNER_B
        )

    assert type(exists_but_foreign.value) is type(does_not_exist.value)
    assert str(exists_but_foreign.value) == str(does_not_exist.value)
    # 訊息本身不可以帶 pid —— 帶了就等於把查詢回音回去
    message = str(exists_but_foreign.value)
    assert str(victim.pid) not in message
    assert str(unused_pid) not in message


def test_owner_can_attach_to_their_own_session(manager):
    """正向對照：同一個擁有者接得上去，而且多個 client 並存（重整／多分頁）。"""
    first = _start(manager, OWNER_A, "tab1")

    second = manager.connect_client_to_debug_session(
        desired_gdbpid=first.pid, client_id="tab2", owner_key=OWNER_A
    )

    assert second is first
    assert first.client_ids == {"tab1", "tab2"}
    assert len(manager.debug_session_to_client_ids) == 1


def test_second_connection_from_the_same_user_reuses_the_existing_gdb(manager):
    """一人一個 debug session：第二個分頁 attach，不再開第二個 GDB。

    這裡走的是 app.client_connected 在沒有 gdbpid 參數時的那條路徑：
    先問 debug_session_from_owner()，有就 attach。
    """
    first = _start(manager, OWNER_A, "tab1")

    existing = manager.debug_session_from_owner(OWNER_A)
    assert existing is first, "第二個分頁應該找得到同一個 session"

    second = manager.connect_client_to_debug_session(
        desired_gdbpid=existing.pid, client_id="tab2", owner_key=OWNER_A
    )

    assert second.pid == first.pid, "第二個分頁拿到不同的 gdbpid，代表又開了一個 GDB"
    assert len(manager.debug_session_to_client_ids) == 1
    assert first.client_ids == {"tab1", "tab2"}

    # 另一個使用者當然還是要拿到自己的 session
    assert manager.debug_session_from_owner(OWNER_B) is None


def test_disconnecting_one_of_two_clients_leaves_the_session_alive(manager):
    """兩個分頁時關掉其中一個，不可以把 GDB 一起帶走。"""
    debug_session = _start(manager, OWNER_A, "tab1")
    manager.connect_client_to_debug_session(
        desired_gdbpid=debug_session.pid, client_id="tab2", owner_key=OWNER_A
    )

    manager.disconnect_client("tab1")

    assert debug_session.client_ids == {"tab2"}
    assert debug_session in manager.debug_session_to_client_ids
    assert debug_session.pygdbmi_controller is not None, "GDB 被關掉了"
    assert manager.debug_session_from_owner(OWNER_A) is debug_session

    # 最後一個 client 走了才收掉
    manager.disconnect_client("tab2")
    assert debug_session not in manager.debug_session_to_client_ids
    assert manager.debug_session_from_owner(OWNER_A) is None


def test_a_terminated_session_is_not_reused_by_the_next_tab(manager):
    """已經 terminate 但還沒清掉簿記的 session 不算「還活著」。

    重用它會讓下一個分頁停在一個永遠不回應的 GDB 上。
    """
    debug_session = _start(manager, OWNER_A, "tab1")
    debug_session.terminate()

    assert manager.debug_session_from_owner(OWNER_A) is None


def test_kill_is_scoped_to_the_owner(manager):
    """/kill_session 的授權判斷（同一個 is_owned_by 原語）。"""
    victim = _start(manager, OWNER_A, "victim_tab")

    assert not victim.is_owned_by(OWNER_B)
    assert not victim.is_owned_by(None)
    assert victim.is_owned_by(OWNER_A)
    assert manager.debug_sessions_owned_by(OWNER_B) == []
    assert manager.debug_sessions_owned_by(OWNER_A) == [victim]
