"""/send_signal 的授權測試。

背景：這個端點以前叫 /send_signal_to_pid，從 form 讀一個 pid 然後以容器內的
root 執行 os.kill()。沒有 @authenticate，沒有擁有者檢查。任何拿得到 CSRF token
的使用者都能對 PID 1（tini）、gdbgui 伺服器自己、或別人的 GDB 與別人正在跑的
程式送任意訊號。

修法不是「驗證使用者送來的 pid」，而是**不讓呼叫端送 pid**：請求只指名目標的
種類（gdb / inferior），pid 由伺服器從呼叫者擁有的 debug session 解析。
下面的測試就是那個契約的證據——包含一條刻意把 form 裡的 pid 欄位塞滿的測試，
證明它真的完全不被看。

需要在容器內以 root 執行才會實際跑（要 setpriv/unshare/useradd 才起得了 GDB）。
"""

import os
import subprocess
import time

import pytest

from gdbgui.server.sandbox import jail_manager

from .conftest import register_user


pytestmark = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="needs root + setpriv/unshare/useradd to start a confined gdb",
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _process_is_alive(pid: int) -> bool:
    """真的還在跑（zombie 不算）。os.kill(pid, 0) 對 zombie 會回成功。"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            fields = f.read().rsplit(b")", 1)[1].split()
    except OSError:
        return False
    return fields[0] != b"Z"


def _pid_uid(pid: int):
    try:
        return os.stat(f"/proc/{pid}").st_uid
    except OSError:
        return None


_SIGINT_BIT = 1 << (2 - 1)  # SIGINT == 2；SigCgt 是從 0 開始編號的位元遮罩


def _has_execed_gdb(pid: int) -> bool:
    """這個 pid 現在真的是**我們啟動的那個 GDB** 了嗎？

    `-iex new-ui …` 是 sessionmanager 加上去的參數，只有我們起的 GDB 有；
    比對它比比對 argv[0] 可靠（setpriv/unshare/env 都不會有這個參數）。
    """
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
    except OSError:
        return False
    return any(arg.startswith(b"new-ui ") for arg in argv)


def _wait_until_gdb_is_up(pid: int) -> None:
    """等到 GDB 真的起來、而且裝好自己的 SIGINT handler 為止。

    setpriv -> unshare -> env -> gdb 是同一個 pid 一路接力 exec，前三棒對 SIGINT
    的處置是預設的「終止」。在那之前送 SIGINT 會直接殺掉行程——那是測試起跑得比
    GDB 快，不是端點的行為（真人按 pause 鍵不可能快到這個程度）。

    ★ 光看 SigCgt 不夠 ★

    GDB 是用 `pty.fork()` 起的，所以在 exec 之前那一小段時間裡，這個 pid 還是
    **forked 出來的 Python 直譯器**——而 Python（與 eventlet）自己就裝了一堆
    signal handler，包含 SIGINT。於是 SigCgt 在 exec 發生**之前**就已經有 SIGINT
    的位元了，這個等待會在 0.3 毫秒內就「成功」返回，然後測試對一個還沒 exec 成
    GDB 的行程送 SIGINT，把它殺掉。

    量測（容器內）：先確認已經 exec 成 GDB 再看 SigCgt，等待時間約 40 ms；
    只看 SigCgt 的話返回時 /proc/<pid>/cmdline 還是空的（正在 exec）。

    fork 與 exec 之間的窗口有多寬，取決於當下父行程有多大（fork 要複製頁表），
    所以這個洞是否會發作跟「這個測試前面剛好做了什麼」有關——正是一個間歇性
    失敗該有的樣子。這裡改成同時要求兩件事，讓它跟時序無關：
      1. 這個 pid 已經 exec 成我們的 GDB（cmdline 有 `-iex new-ui …`）
      2. 它自己裝好了 SIGINT handler（SigCgt）
    """
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if _has_execed_gdb(pid):
            try:
                with open(f"/proc/{pid}/status") as f:
                    caught = next(
                        int(line.split()[1], 16)
                        for line in f
                        if line.startswith("SigCgt:")
                    )
            except (OSError, StopIteration):
                caught = 0
            if caught & _SIGINT_BIT:
                return
        time.sleep(0.02)
    raise AssertionError(f"gdb pid {pid} never came up with a SIGINT handler")


def _spawn_victim_process(jail):
    """在 jail 帳號底下起一支活生生的行程，當作訊號的犧牲品。

    setpriv -> unshare -> env -> sleep 是同一個 pid 接力 exec，所以剛 Popen 完
    的瞬間它還是 root。等到 /proc 的擁有者變成 session uid 才算就位。
    """
    proc = subprocess.Popen(
        jail_manager.confine(jail, ["sleep", "60"]),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if _pid_uid(proc.pid) == jail.uid:
            return proc
        time.sleep(0.02)
    proc.kill()
    proc.wait()
    raise AssertionError("victim process never dropped to the session account")


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


class Session:
    """一個使用者：帳號 + HTTP client + websocket + 這個使用者的 jail/debug session。

    擁有者身分（self.owner）＝ http_util.owner_key()，也就是登入的 user id；
    「兩個獨立的 session」現在是「兩個獨立的帳號」。
    """

    def __init__(self, app, socketio, manager, *, with_gdb=True):
        self.app = app
        self.manager = manager
        user = register_user(app)
        self.http = user.http
        assert self.http.get("/").status_code == 200
        self.csrf = user.csrf
        self.owner = user.owner_key
        self.ws = None
        if with_gdb:
            self.ws = socketio.test_client(
                app,
                namespace="/gdb_listener",
                query_string=f"csrf_token={self.csrf}",
                flask_test_client=self.http,
            )
            event = next(
                m["args"][0]
                for m in self.ws.get_received("/gdb_listener")
                if m["name"] == "debug_session_connection_event"
            )
            assert event["ok"], event

    @property
    def debug_session(self):
        return self.manager.debug_session_from_owner(self.owner)

    @property
    def jail(self):
        return jail_manager.get(self.owner)

    def signal(self, signal_name, target, **extra_form_fields):
        return self.http.post(
            "/send_signal",
            data={
                "csrf_token": self.csrf,
                "signal_name": signal_name,
                "target": target,
                **extra_form_fields,
            },
        )

    def close(self):
        if self.ws is not None:
            try:
                self.ws.disconnect(namespace="/gdb_listener")
            except Exception:
                pass
        jail_manager.release(self.owner)


@pytest.fixture
def session(gdbgui_app):
    app, manager, socketio = gdbgui_app
    s = Session(app, socketio, manager)
    try:
        yield s
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 正向：自己的東西還是送得到（這就是 pause 按鈕會壞掉的那條路）
# ---------------------------------------------------------------------------


def test_a_session_can_signal_its_own_gdb(session):
    """UI 的 pause 按鈕（ControlButtons）走的就是這條：SIGINT → target=gdb。"""
    gdb_pid = session.debug_session.pid
    _wait_until_gdb_is_up(gdb_pid)
    assert _process_is_alive(gdb_pid)

    response = session.signal("SIGINT", "gdb")

    assert response.status_code == 200, response.data
    body = response.get_json()
    assert "gdb" in body["message"]
    # 回應不可以把 pid 回音出去
    assert str(gdb_pid) not in body["message"]
    assert _process_is_alive(gdb_pid), "SIGINT killed gdb instead of interrupting it"


def test_a_session_can_signal_its_own_inferior(session):
    """inferior 的 pid 是伺服器從 GDB 的 MI 串流記下來的，不是使用者送的。"""
    victim = _spawn_victim_process(session.jail)
    try:
        session.debug_session.inferior_pid = victim.pid

        response = session.signal("SIGKILL", "inferior")

        assert response.status_code == 200, response.data
        victim.wait(timeout=5)
        assert not _process_is_alive(victim.pid)
    finally:
        if victim.poll() is None:
            victim.kill()
            victim.wait()


# ---------------------------------------------------------------------------
# 頭條主張：呼叫端不能挑 pid
# ---------------------------------------------------------------------------


def test_a_pid_in_the_request_is_ignored_entirely(session):
    """把 pid 欄位塞好塞滿也沒用——伺服器只看 target。

    兩個一模一樣、都屬於本 session 的行程：一個掛在 inferior_pid 上（伺服器認得
    的那個），另一個只出現在 form 的 pid 欄位裡。只有前者可以死。
    """
    resolved = _spawn_victim_process(session.jail)
    requested = _spawn_victim_process(session.jail)
    try:
        session.debug_session.inferior_pid = resolved.pid

        response = session.signal(
            "SIGKILL", "inferior", pid=str(requested.pid), gdbpid=str(requested.pid)
        )

        assert response.status_code == 200, response.data
        resolved.wait(timeout=5)
        assert not _process_is_alive(resolved.pid)
        assert _process_is_alive(requested.pid), (
            "the pid field in the request body was honoured"
        )
    finally:
        for proc in (resolved, requested):
            if proc.poll() is None:
                proc.kill()
            proc.wait()


def test_a_root_owned_process_outside_the_jail_cannot_be_signalled(session):
    """同樣模擬「GDB 回報了一個不是這個 session 的 pid」，但目標是一支犧牲用的
    root 行程，而不是 PID 1 或伺服器自己。

    刻意分成一條獨立的測試：這條可以在「把 uid 那道檢查拿掉」的反向對照下安全
    地跑（頂多死一支 sleep），下面那兩條真實世界的斷言則不行——真的送出去就是
    容器或伺服器當場掛掉。
    """
    outsider = subprocess.Popen(
        ["sleep", "60"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        assert _pid_uid(outsider.pid) == 0, "the sacrificial process must be root's"
        assert _pid_uid(outsider.pid) != session.jail.uid
        session.debug_session.inferior_pid = outsider.pid

        response = session.signal("SIGKILL", "inferior")

        assert response.status_code == 400
        assert _process_is_alive(outsider.pid), (
            "a process outside this session's account was signalled"
        )
    finally:
        if outsider.poll() is None:
            outsider.kill()
        outsider.wait()


def test_pid_1_cannot_be_signalled_even_if_gdb_claims_it(session):
    """模擬「GDB 回報了一個不屬於這個 session 的 pid」。

    使用者可以在 GDB console 打任意指令，所以 MI 串流的內容不能當成完全可信；
    最後一道關卡是「這個 pid 現在真的屬於本 session 的 OS 帳號嗎」。
    PID 1 是 tini（root），永遠過不了。
    """
    assert _process_is_alive(1)
    session.debug_session.inferior_pid = 1

    response = session.signal("SIGKILL", "inferior")

    assert response.status_code == 400
    assert _process_is_alive(1), "PID 1 (tini) was signalled"


def test_the_server_process_cannot_be_signalled(session):
    """伺服器自己（root）同樣過不了 uid 那一關。"""
    server_pid = os.getpid()
    session.debug_session.inferior_pid = server_pid

    response = session.signal("SIGKILL", "inferior")

    assert response.status_code == 400
    assert _process_is_alive(server_pid), "the gdbgui server signalled itself"


def test_a_session_cannot_signal_another_sessions_processes(gdbgui_app):
    """兩個獨立的 Flask session（＝兩個瀏覽器）。"""
    app, manager, socketio = gdbgui_app
    victim = Session(app, socketio, manager)
    # attacker 只是開了頁面，沒有自己的 debug session
    attacker = Session(app, socketio, manager, with_gdb=False)
    victim_inferior = None
    try:
        assert victim.owner != attacker.owner
        victim_gdb_pid = victim.debug_session.pid
        _wait_until_gdb_is_up(victim_gdb_pid)
        victim_inferior = _spawn_victim_process(victim.jail)
        victim.debug_session.inferior_pid = victim_inferior.pid

        for target in ("gdb", "inferior"):
            response = attacker.signal("SIGKILL", target)
            assert response.status_code == 400, (target, response.data)

        assert _process_is_alive(victim_gdb_pid), "another session's gdb was killed"
        assert _process_is_alive(victim_inferior.pid), (
            "another session's inferior was killed"
        )
        assert victim.debug_session is not None
    finally:
        if victim_inferior is not None:
            if victim_inferior.poll() is None:
                victim_inferior.kill()
            victim_inferior.wait()
        attacker.close()
        victim.close()


def test_a_caller_with_no_debug_session_is_refused(gdbgui_app):
    app, manager, socketio = gdbgui_app
    caller = Session(app, socketio, manager, with_gdb=False)
    try:
        assert caller.debug_session is None
        for target in ("gdb", "inferior"):
            assert caller.signal("SIGINT", target).status_code == 400
    finally:
        caller.close()


# ---------------------------------------------------------------------------
# 拒絕必須同形（同 93e829d 的 attach 拒絕）
# ---------------------------------------------------------------------------


def test_every_refusal_is_indistinguishable(gdbgui_app):
    """「你沒有 session」「目標還沒起來」「那個 pid 不是你的」「參數壞掉」——
    全部同一個狀態碼、同一句話。差一個字就能被拿來探測。"""
    app, manager, socketio = gdbgui_app
    caller = Session(app, socketio, manager)
    try:
        caller.debug_session.inferior_pid = None
        refusals = [
            caller.signal("SIGKILL", "inferior"),          # 目標還沒起來
            caller.signal("SIGKILL", "nonsense"),          # 目標名稱不在白名單
            caller.signal("NOT_A_SIGNAL", "gdb"),          # 訊號名稱無效
            caller.signal("SIGKILL", ""),                  # 缺 target
        ]
        caller.debug_session.inferior_pid = 1
        refusals.append(caller.signal("SIGKILL", "inferior"))   # 存在但不是你的
        caller.debug_session.inferior_pid = 999_999_999
        refusals.append(caller.signal("SIGKILL", "inferior"))   # 根本不存在

        statuses = {r.status_code for r in refusals}
        bodies = {r.get_data(as_text=True) for r in refusals}
        assert statuses == {400}, statuses
        assert len(bodies) == 1, bodies
    finally:
        caller.close()


def test_the_old_pid_taking_endpoint_no_longer_exists(gdbgui_app):
    """/send_signal_to_pid 被刪掉，不是被修好——舊路徑必須 404，
    這樣任何還在用它的東西（含攻擊腳本）都會立刻壞掉而不是靜靜地半動。"""
    app, manager, socketio = gdbgui_app
    caller = Session(app, socketio, manager, with_gdb=False)
    try:
        response = caller.http.post(
            "/send_signal_to_pid",
            data={"csrf_token": caller.csrf, "signal_name": "SIGKILL", "pid": "1"},
        )
        assert response.status_code == 404
    finally:
        caller.close()

# inferior pid 是**怎麼**被記下來的（單元層級，不需要真的起 GDB）：
# 見 tests/test_sessionmanager.py 的 observe_gdb_response 測試。
