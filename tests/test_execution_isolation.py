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
