"""執行隔離的回歸測試（子專案 E 驗證項目 2 / 3 / 4 / 7）。

設計文件：docs/superpowers/specs/2026-07-29-execution-isolation-design.md

這些是**正向測試**：它們實際建立兩個 session、實際編譯並執行 C++、實際去讀
另一個 session 的檔案，然後主張那必須失敗。如果哪天隔離退化了，測試會大聲
壞掉，而不是安靜地通過。

必須在容器內、以 root 執行（`docker compose exec gdbgui python -m pytest ...`）。
在沒有隔離能力的環境（本機非 Docker）會 skip —— 但 CI/部署驗證要看到它們真的
跑過，skip 不算數。
"""

import os
import subprocess
import textwrap
import time

import pytest

from gdbgui.server.sandbox import jail_manager


pytestmark = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="per-session execution isolation needs root + setpriv/unshare/useradd",
)


SESSION_A = "a" * 32
SESSION_B = "b" * 32


@pytest.fixture
def two_sessions():
    """兩個並行的 session，測試結束一定清掉。"""
    jail_manager.ensure_scratch_root()
    for key in (SESSION_A, SESSION_B):
        jail_manager.release(key)
    jail_a = jail_manager.acquire(SESSION_A)
    jail_b = jail_manager.acquire(SESSION_B)
    assert jail_a is not None and jail_b is not None
    try:
        yield jail_a, jail_b
    finally:
        jail_manager.release(SESSION_A)
        jail_manager.release(SESSION_B)


def _write_for(jail, name, content):
    path = jail.dir / name
    path.write_text(content)
    jail_manager.chown_to_session(path, jail, 0o600)
    return path


def _compile_and_run(jail, source_name, source, timeout=60):
    src = _write_for(jail, source_name, textwrap.dedent(source))
    binary = jail.dir / (source_name.rsplit(".", 1)[0])
    compiled = subprocess.run(
        jail_manager.confine(jail, ["g++", "-O0", "-o", str(binary), str(src)]),
        capture_output=True, text=True, timeout=timeout,
    )
    assert compiled.returncode == 0, f"compile failed: {compiled.stderr}"
    return subprocess.run(
        jail_manager.confine(jail, [str(binary)]),
        capture_output=True, text=True, timeout=timeout,
    )


# ---------------------------------------------------------------------------
# 驗證 2：unshare / setpriv / useradd 在最終 compose 設定下真的可用
# ---------------------------------------------------------------------------

def test_each_session_gets_its_own_uid_and_private_dir(two_sessions):
    jail_a, jail_b = two_sessions

    assert jail_a.uid != jail_b.uid, "sessions must not share an OS account"
    assert jail_a.dir != jail_b.dir

    for jail in (jail_a, jail_b):
        st = os.stat(jail.dir)
        assert st.st_uid == jail.uid, "scratch dir must be owned by the session account"
        assert st.st_mode & 0o777 == 0o700, "scratch dir must be 0700"


def test_program_runs_as_the_session_account_not_root(two_sessions):
    jail_a, _ = two_sessions
    result = _compile_and_run(jail_a, "whoami.cpp", """
        #include <cstdio>
        #include <unistd.h>
        int main() { printf("uid=%d\\n", (int)getuid()); return 0; }
    """)
    assert result.stdout.strip() == f"uid={jail_a.uid}", result.stdout
    assert "uid=0" not in result.stdout, "user program must never run as root"


# ---------------------------------------------------------------------------
# 驗證 3（頭條主張）：session A 的程式讀不到 session B 的 scratch
# ---------------------------------------------------------------------------

def test_session_cannot_read_another_sessions_scratch(two_sessions):
    """在此之前，session 之間只靠亂數**檔名**分隔，而且所有程式都以同一個 OS
    使用者執行 —— 任何一支使用者 C++ 都能 open() 別人的原始碼與 binary。
    這個測試就是那個資料外洩已被修掉的證據。"""
    jail_a, jail_b = two_sessions

    secret = "SECRET-BELONGING-TO-SESSION-B-b7f3a1"
    secret_path = _write_for(jail_b, "private_lesson.cpp", secret)
    _write_for(jail_b, "other.txt", secret)

    result = _compile_and_run(jail_a, "snoop.cpp", f"""
        #include <cstdio>
        #include <cerrno>
        #include <dirent.h>
        int main() {{
            FILE* f = fopen("{secret_path}", "r");
            if (f) {{
                char buf[256] = {{0}};
                fread(buf, 1, 255, f);
                fclose(f);
                printf("READ_OK:%s\\n", buf);
            }} else {{
                printf("READ_DENIED:errno=%d\\n", errno);
            }}
            DIR* d = opendir("{jail_b.dir}");
            if (d) {{ printf("LIST_OK\\n"); closedir(d); }}
            else   {{ printf("LIST_DENIED:errno=%d\\n", errno); }}
            return 0;
        }}
    """)

    assert result.returncode == 0, result.stderr
    # EACCES == 13
    assert "READ_DENIED:errno=13" in result.stdout, result.stdout
    assert "LIST_DENIED:errno=13" in result.stdout, result.stdout
    assert "READ_OK" not in result.stdout
    assert secret not in result.stdout, "session B's data leaked into session A"


def test_session_cannot_write_into_another_sessions_scratch(two_sessions):
    jail_a, jail_b = two_sessions
    result = _compile_and_run(jail_a, "planter.cpp", f"""
        #include <cstdio>
        #include <cerrno>
        int main() {{
            FILE* f = fopen("{jail_b.dir}/planted.txt", "w");
            if (f) {{ fclose(f); printf("WRITE_OK\\n"); }}
            else   {{ printf("WRITE_DENIED:errno=%d\\n", errno); }}
            return 0;
        }}
    """)
    assert "WRITE_DENIED:errno=13" in result.stdout, result.stdout
    assert not (jail_b.dir / "planted.txt").exists()


def test_session_cannot_write_into_the_application_directory(two_sessions):
    jail_a, _ = two_sessions
    result = _compile_and_run(jail_a, "clobber.cpp", """
        #include <cstdio>
        #include <cerrno>
        int main() {
            FILE* f = fopen("/app/gdbgui/server/http_routes.py", "a");
            if (f) { fclose(f); printf("WRITE_OK\\n"); }
            else   { printf("WRITE_DENIED:errno=%d\\n", errno); }
            return 0;
        }
    """)
    assert "WRITE_OK" not in result.stdout, "user program could modify application code"


# ---------------------------------------------------------------------------
# 驗證 4：使用者程式的對外連線必須失敗
# ---------------------------------------------------------------------------

def test_user_program_has_no_network(two_sessions):
    jail_a, _ = two_sessions
    result = _compile_and_run(jail_a, "phone_home.cpp", """
        #include <cstdio>
        #include <cerrno>
        #include <sys/socket.h>
        #include <netinet/in.h>
        #include <arpa/inet.h>
        #include <unistd.h>
        int main() {
            int s = socket(AF_INET, SOCK_STREAM, 0);
            if (s < 0) { printf("SOCKET_DENIED:errno=%d\\n", errno); return 0; }
            sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_port = htons(80);
            inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
            if (connect(s, (sockaddr*)&a, sizeof a) < 0)
                printf("CONNECT_DENIED:errno=%d\\n", errno);
            else
                printf("CONNECT_OK\\n");
            close(s);
            return 0;
        }
    """)
    assert "CONNECT_OK" not in result.stdout, "user program reached the network"
    assert "DENIED" in result.stdout, result.stdout


def test_only_loopback_exists_in_the_session_namespace(two_sessions):
    jail_a, _ = two_sessions
    result = subprocess.run(
        jail_manager.confine(jail_a, ["cat", "/proc/net/dev"]),
        capture_output=True, text=True, timeout=30,
    )
    assert "lo:" in result.stdout
    assert "eth0" not in result.stdout, "container network is visible inside the session"


# ---------------------------------------------------------------------------
# 驗證 7：session 結束後帳號與 scratch 目錄確實消失
# ---------------------------------------------------------------------------

def test_release_removes_account_and_scratch_dir():
    import pwd

    key = "c" * 32
    jail_manager.release(key)
    jail = jail_manager.acquire(key)
    assert jail is not None
    assert jail.dir.is_dir()
    assert pwd.getpwnam(jail.name)

    jail_manager.release(key)

    assert not jail.dir.exists(), "scratch dir survived session teardown"
    with pytest.raises(KeyError):
        pwd.getpwnam(jail.name)


# ---------------------------------------------------------------------------
# 驗證 6：併發上限回明確錯誤，不是崩潰
# ---------------------------------------------------------------------------

def test_concurrency_limit_raises_a_specific_error(monkeypatch):
    keys = ["d" * 32, "e" * 32]
    for key in keys:
        jail_manager.release(key)

    # 用「目前數量 + 1」而不是寫死 1：這個測試不該因為同一輪測試裡別的測試
    # 剛好還留著 session 就變成假紅燈。
    monkeypatch.setattr(
        jail_manager, "MAX_SESSIONS", jail_manager.active_session_count() + 1
    )
    try:
        assert jail_manager.acquire(keys[0]) is not None
        with pytest.raises(jail_manager.TooManySessions):
            jail_manager.acquire(keys[1])
        # 拒絕之後不可以留下半成品
        assert not (jail_manager.SCRATCH_ROOT / jail_manager._account_name(keys[1])).exists()
    finally:
        for key in keys:
            jail_manager.release(key)


def test_session_key_must_be_hex():
    """session_key 會被放進 useradd 的 argv，非 hex 一律拒絕。"""
    for bad in ("../../etc/passwd", "root; rm -rf /", "abc", "", "ZZZZ" * 8):
        with pytest.raises(jail_manager.JailError):
            jail_manager.acquire(bad)


# ---------------------------------------------------------------------------
# 一個 Flask session 一個 GDB（端對端）
#
# 上面的 test_sessionmanager.py 測的是簿記；這裡走真正的 websocket handler
# （app.client_connected），而且是**數作業系統裡的 GDB 行程**，不是數字典的
# key。每個 GDB 約 21 MB 容器記憶體，兩個分頁開兩個 GDB 在 200 個帳號的部署
# 下會直接變成記憶體問題，而且兩個 GDB 還共用同一個 jail 帳號。
# ---------------------------------------------------------------------------


def _count_gdb_processes() -> int:
    """真的去 /proc 數 GDB 行程。

    刻意不用 `pgrep -f "gdb -iex"`：pgrep 自己的 command line 就含有那個樣式，
    所以它在真實數量是 0 的時候會回報 1。這裡逐一讀 /proc/<pid>/cmdline，
    比對只有我們啟動的 GDB 才有的 `-iex new-ui …` 參數。

    setpriv → unshare → env → gdb 是同一個 pid 接力 exec，所以不論走到哪一步
    都只算一個行程。
    """
    count = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                argv = f.read().split(b"\0")
        except OSError:
            continue  # 行程剛結束
        if any(arg.startswith(b"new-ui ") for arg in argv):
            count += 1
    return count


def _settled_gdb_count(settle: float = 0.4, timeout: float = 15.0) -> int:
    """等 GDB 行程數不再變動，回傳穩定後的數字。

    pty.fork() 一回到父行程，子行程可能還沒 exec 完 —— 那一瞬間它的
    /proc cmdline 還是 python 的，數不到；結束那一側同理。

    刻意**不是**「輪詢到等於期望值就回傳」：那樣的話多開了一個 GDB 但它出現
    得比較慢的情況會被誤判成通過。這裡等到數字自己穩定下來，再讓呼叫端去比對。
    """
    deadline = time.monotonic() + timeout
    count = _count_gdb_processes()
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        time.sleep(0.05)
        now = _count_gdb_processes()
        if now != count:
            count = now
            stable_since = time.monotonic()
        elif time.monotonic() - stable_since >= settle:
            return count
    return count


@pytest.fixture
def gdbgui_app():
    """初始化 socketio 並在測試後把所有 debug session 清乾淨。"""
    from gdbgui.server.app import app, manager, socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        # 只初始化一次。run_server() 會 reap_orphans()，重複呼叫會把還在用的
        # session 帳號清掉。
        run_server(testing=True, app=app, socketio=socketio)
    app.config["gdb_command"] = "gdb"
    try:
        yield app, manager, socketio
    finally:
        for debug_session in list(manager.debug_session_to_client_ids):
            manager.remove_debug_session(debug_session)


def _connect_tab(app, socketio, flask_client, csrf_token):
    """模擬一個新分頁：同一個 Flask session cookie，新的 websocket。"""
    return socketio.test_client(
        app,
        namespace="/gdb_listener",
        query_string=f"csrf_token={csrf_token}",
        flask_test_client=flask_client,
    )


def _connection_event(ws_client):
    for message in ws_client.get_received("/gdb_listener"):
        if message["name"] == "debug_session_connection_event":
            return message["args"][0]
    raise AssertionError("no debug_session_connection_event received")


def test_two_tabs_in_one_flask_session_share_one_gdb_process(gdbgui_app):
    app, manager, socketio = gdbgui_app

    flask_client = app.test_client()
    # 首頁會建立 uploaded_prefix（＝擁有者身分）與 jail
    assert flask_client.get("/").status_code == 200
    with flask_client.session_transaction() as flask_session:
        csrf_token = flask_session["csrf_token"]
        owner = flask_session["uploaded_prefix"]

    baseline = _settled_gdb_count()

    tab1 = _connect_tab(app, socketio, flask_client, csrf_token)
    slots_after_first_tab = jail_manager.active_session_count()
    tab2 = _connect_tab(app, socketio, flask_client, csrf_token)
    try:
        event1 = _connection_event(tab1)
        event2 = _connection_event(tab2)

        # attach 不可以吃掉一個 GDBGUI_MAX_SESSIONS 名額
        assert jail_manager.active_session_count() == slots_after_first_tab, (
            "第二個分頁佔用了一個新的併發名額"
        )

        assert event1["ok"] and event2["ok"], (event1, event2)
        assert event1["started_new_gdb_process"] is True
        assert event2["started_new_gdb_process"] is False, "第二個分頁又開了一個 GDB"
        assert event2["pid"] == event1["pid"]

        # 這是頭條主張：作業系統裡只多了一個 GDB 行程，不是兩個
        after_two_tabs = _settled_gdb_count()
        assert after_two_tabs == baseline + 1, (
            f"expected exactly one new gdb process for two tabs, "
            f"baseline={baseline} after_two_tabs={after_two_tabs}"
        )

        # 簿記上也只有一個 debug session，而且掛著兩個 client
        owned = manager.debug_sessions_owned_by(owner)
        assert len(owned) == 1
        assert len(owned[0].client_ids) == 2

        # attach 不佔用新的併發額度：jail 還是同一個
        assert jail_manager.active_session_count() >= 1
        assert jail_manager.get(owner) is not None

        # 關掉一個分頁，另一個要活著（含 GDB 行程本身）
        tab1.disconnect(namespace="/gdb_listener")
        still_owned = manager.debug_sessions_owned_by(owner)
        assert still_owned, "剩一個分頁時 session 被收掉了"
        # client 真的被移掉了（證明 disconnect handler 有跑，不是斷線被吞掉）
        assert len(still_owned[0].client_ids) == 1
        assert still_owned[0].pygdbmi_controller is not None
        assert _settled_gdb_count() == baseline + 1, "剩一個分頁時 GDB 行程被殺掉了"

        # 最後一個分頁也走了，才可以歸零 —— 清理不能因為這次改動而退化
        tab2.disconnect(namespace="/gdb_listener")
        assert manager.debug_sessions_owned_by(owner) == []
        assert _settled_gdb_count() == baseline, "GDB 行程沒有被回收"
        # jail 也要跟著消失（scratch 目錄 + OS 帳號）
        assert jail_manager.get(owner) is None, "session 結束後 jail 還在"
    finally:
        for tab in (tab1, tab2):
            try:
                tab.disconnect(namespace="/gdb_listener")
            except Exception:
                pass
        jail_manager.release(owner)


def test_a_foreign_flask_session_cannot_attach_to_someone_elses_gdbpid(gdbgui_app):
    """端對端版本的授權測試：victim 與 attacker 是兩個獨立的 Flask session
    （兩個 cookie jar，等同兩個瀏覽器）。"""
    app, manager, socketio = gdbgui_app

    victim_http = app.test_client()
    assert victim_http.get("/").status_code == 200
    with victim_http.session_transaction() as flask_session:
        victim_csrf = flask_session["csrf_token"]
        victim_owner = flask_session["uploaded_prefix"]

    attacker_http = app.test_client()
    assert attacker_http.get("/").status_code == 200
    with attacker_http.session_transaction() as flask_session:
        attacker_csrf = flask_session["csrf_token"]
        attacker_owner = flask_session["uploaded_prefix"]

    assert victim_owner != attacker_owner

    victim_tab = _connect_tab(app, socketio, victim_http, victim_csrf)
    attacker_tab = None
    try:
        victim_event = _connection_event(victim_tab)
        assert victim_event["ok"]
        victim_pid = victim_event["pid"]

        # attacker 明確指定 victim 的 gdbpid
        attacker_tab = socketio.test_client(
            app,
            namespace="/gdb_listener",
            query_string=f"csrf_token={attacker_csrf}&gdbpid={victim_pid}",
            flask_test_client=attacker_http,
        )
        attacker_event = _connection_event(attacker_tab)

        assert attacker_event["ok"] is False, "attacker attached to another user's gdb"
        assert str(victim_pid) not in attacker_event["message"], (
            "拒絕訊息回音了 pid"
        )

        # victim 的 session 沒有被動到
        victim_sessions = manager.debug_sessions_owned_by(victim_owner)
        assert len(victim_sessions) == 1
        assert len(victim_sessions[0].client_ids) == 1

        # 不存在的 pid 必須得到**一模一樣**的回應，否則就是 pid oracle
        absent_tab = socketio.test_client(
            app,
            namespace="/gdb_listener",
            query_string=f"csrf_token={attacker_csrf}&gdbpid={victim_pid + 7919}",
            flask_test_client=attacker_http,
        )
        absent_event = _connection_event(absent_tab)
        absent_tab.disconnect(namespace="/gdb_listener")

        assert absent_event["ok"] is False
        assert absent_event["message"] == attacker_event["message"], (
            "「不存在」與「不是你的」回應不同，可用來列舉別人的 gdbpid"
        )
    finally:
        for tab in (victim_tab, attacker_tab):
            if tab is None:
                continue
            try:
                tab.disconnect(namespace="/gdb_listener")
            except Exception:
                pass
        for debug_session in list(manager.debug_session_to_client_ids):
            manager.remove_debug_session(debug_session)
        jail_manager.release(victim_owner)
        jail_manager.release(attacker_owner)
