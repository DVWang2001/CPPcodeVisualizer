"""/read_file 與 /get_last_modified_unix_sec 只能碰到呼叫者自己碰得到的檔案。

背景
----
這兩條路由的 `path` 直接來自 `request.args`，而伺服器以 **root** 執行：
`/read_file` 做 `os.path.isfile` + `open().read()`，`/get_last_modified_unix_sec`
做 `os.path.isfile` + `os.path.getmtime`。039c08b 把它們關進登入之後（嚴格變好），
但註冊是開放的，而同一個 commit 才剛把 `/var/lib/gdbgui/secret_key` 與密碼雜湊
資料庫放上磁碟。讀到 SECRET_KEY 就能簽出任何人的 session cookie，也就是任何人的
`owner_key()`、任何人的 jail。

修法不是路徑白名單，而是**以呼叫者自己的 session OS 帳號**做每一次檔案系統接觸
（sandbox/read_helper.py）。檔案權限本來就已經編碼了正確的政策。

這個檔案裡的測試分成互相對照的兩半，缺一半就測不出東西：

  * 拿不到的東西真的拿不到（祕密、別人的 scratch），而且**兩條路由都是**
    ——`/get_last_modified_unix_sec` 本身就是一個完整的 oracle，只修 `/read_file`
    等於沒修。
  * 拿得到的東西還是拿得到（系統標頭、自己的原始碼、虛擬路徑翻譯）
    ——少了這半，「一律拒絕」會通過。

必須在容器內、以 root 執行。
"""

import json
import os

import pytest

from gdbgui.server.sandbox import jail_manager

from .conftest import register_user


pytestmark = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="confined file reads need root + setpriv/unshare/useradd",
)


ROUTES = ("/read_file", "/get_last_modified_unix_sec")

#: 這台機器上，session 帳號**不該**碰得到的東西。
SECRETS = (
    "/var/lib/gdbgui/secret_key",
    "/var/lib/gdbgui/gdbgui.sqlite3",
    "/etc/shadow",
)


@pytest.fixture
def flask_app():
    from gdbgui.server.app import app

    app.config["gdb_command"] = "gdb"
    return app


class Visitor:
    """一個已登入、而且**有 live jail** 的使用者。

    刻意在測試裡明確 acquire：路由自己不會 acquire（4c54fc1 才剛把「便宜的請求
    會建立 OS 帳號」拿掉），所以「有沒有 jail」是這些測試的前提，不是副作用。
    """

    def __init__(self, app):
        self.user = register_user(app)
        self.jail = jail_manager.acquire(self.user.owner_key)
        assert self.jail is not None

    def get(self, route, path, start_line=1, end_line=50):
        args = {"path": path}
        if route == "/read_file":
            args.update(start_line=start_line, end_line=end_line, highlight="false")
        return self.user.http.get(
            route, query_string=args, headers={"x-csrftoken": self.user.csrf}
        )

    def source(self, path, start_line=1, end_line=50):
        """/read_file 的行內容（未經 highlight，所以就是純文字）。"""
        response = self.get("/read_file", path, start_line, end_line)
        assert response.status_code == 200, response.data
        return json.loads(response.data)

    def release(self):
        jail_manager.release(self.user.owner_key)


@pytest.fixture
def visitor(flask_app):
    v = Visitor(flask_app)
    try:
        yield v
    finally:
        v.release()


@pytest.fixture
def victim(flask_app):
    """另一個使用者，scratch 裡有一個只有他自己讀得到的檔案。"""
    v = Visitor(flask_app)
    v.secret_path = str(v.jail.dir / "victim_secret.cpp")
    jail_manager.write_session_file(
        v.secret_path, "// VICTIM-ONLY-CONTENT\n", v.jail, 0o600
    )
    try:
        yield v
    finally:
        v.release()


# ---------------------------------------------------------------------------
# 頭條主張：拿不到的東西真的拿不到——兩條路由都是
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("secret", SECRETS)
def test_server_secrets_are_unreachable(visitor, route, secret):
    """SECRET_KEY／使用者資料庫／/etc/shadow：連 mtime 都不給。

    /etc/shadow 特別值得留意：`/etc` 人人可 traverse，所以單純 `os.stat` 是會成功
    的（實測 STAT-OK / READ-ERR）。helper 要求「打得開」才回 mtime，兩條路由的
    可及範圍才會完全一樣。
    """
    assert os.path.exists(secret), f"測試前提：{secret} 在這台機器上必須存在"
    response = visitor.get(route, secret)
    assert response.status_code == 400, response.data
    assert json.loads(response.data) == {"message": "File not found or not accessible"}


@pytest.mark.parametrize("route", ROUTES)
def test_another_sessions_scratch_file_is_unreachable(visitor, victim, route):
    """別人的 scratch 是 0700。攻擊者知道完整路徑也一樣讀不到。"""
    assert os.path.isfile(victim.secret_path), "測試前提：受害者的檔案要真的存在"
    response = visitor.get(route, victim.secret_path)
    assert response.status_code == 400, response.data
    assert b"VICTIM-ONLY-CONTENT" not in response.data


def test_the_victim_can_still_read_his_own_file(victim):
    """對照組：上一條測到的是**權限**，不是「這個路徑一律讀不到」。"""
    body = victim.source(victim.secret_path)
    assert "// VICTIM-ONLY-CONTENT" in "\n".join(body["source_code_array"])


# ---------------------------------------------------------------------------
# 失敗必須無法分辨
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES)
def test_missing_and_forbidden_look_identical(visitor, route):
    """「沒有這個檔」與「有這個檔但你沒權限」不可以分辨。

    否則那個以 root 探測任意路徑的 oracle 只是換個形狀活下來。原本的實作除了
    區分這兩者，還把使用者送來的 path 直接插進錯誤訊息裡回去。
    """
    missing = visitor.get(route, "/var/lib/gdbgui/no-such-file-here")
    forbidden = visitor.get(route, "/var/lib/gdbgui/secret_key")
    assert missing.status_code == forbidden.status_code == 400
    assert missing.data == forbidden.data


@pytest.mark.parametrize("route", ROUTES)
def test_the_refusal_never_echoes_the_path(visitor, route):
    """路徑不可以出現在拒絕訊息裡——那本身就是在確認呼叫者猜的是什麼。"""
    probe = "/var/lib/gdbgui/UNIQUE-PROBE-STRING"
    response = visitor.get(route, probe)
    assert response.status_code == 400
    assert b"UNIQUE-PROBE-STRING" not in response.data


# ---------------------------------------------------------------------------
# 對照的另一半：該讀得到的還是讀得到
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "header", ("/usr/include/stdio.h", "/usr/include/c++/14/vector")
)
def test_system_headers_are_still_readable(visitor, header):
    """單步進系統標頭時要顯示原始碼。這是路由層的那一半；

    走完整 app（GDB 真的停在標頭裡）的那一半在 e2e／手動驗證。
    """
    if not os.path.isfile(header):
        pytest.skip(f"{header} 不在這個 image 裡")
    body = visitor.source(header, 1, 5)
    assert body["num_lines_in_file"] > 10
    assert len(body["source_code_array"]) == 5


def test_a_users_own_source_is_readable(visitor):
    src = str(visitor.jail.dir / "main.cpp")
    jail_manager.write_session_file(src, "int main() {\n  return 0;\n}\n", visitor.jail, 0o600)
    body = visitor.source(src, 1, 3)
    assert body["source_code_array"] == ["int main() {", "  return 0;", "}"]
    assert body["last_modified_unix_sec"] > 0


def test_get_last_modified_works_for_your_own_file(visitor):
    src = str(visitor.jail.dir / "own.bin")
    jail_manager.write_session_file(src, "x", visitor.jail, 0o600)
    response = visitor.get("/get_last_modified_unix_sec", src)
    assert response.status_code == 200, response.data
    body = json.loads(response.data)
    # 前端拿 path 跟 inferior_binary_path 比對，所以回的必須是呼叫端送來的字串。
    assert body["path"] == src
    assert body["last_modified_unix_sec"] > 0


# ---------------------------------------------------------------------------
# 虛擬路徑翻譯
# ---------------------------------------------------------------------------


def test_the_virtual_workspace_path_still_resolves(visitor):
    """/workspace/main.cpp → 自己 scratch 裡的真實檔案。"""
    src = str(visitor.jail.dir / "translated.cpp")
    jail_manager.write_session_file(src, "// TRANSLATED\n", visitor.jail, 0o600)
    with visitor.user.http.session_transaction() as sess:
        sess["virtual_src_path"] = "/workspace/main.cpp"
        sess["real_src_path"] = src

    body = visitor.source("/workspace/main.cpp", 1, 1)
    assert body["source_code_array"] == ["// TRANSLATED"]
    # 回的是虛擬路徑，不是 scratch 的真實路徑（那裡面含著身分）。
    assert body["path"] == "/workspace/main.cpp"


def test_a_stale_translation_cannot_reach_another_users_file(visitor, victim):
    """翻譯來源（session 裡的 real_src_path）曾經是一條跨使用者的讀取路徑。

    auth.py 靠「登入時清 session」擋它。這裡驗的是**就算那道防線壞了**——
    直接把受害者的路徑塞進攻擊者的 session——實際的 open 仍然以攻擊者自己的
    帳號執行，一樣被 0700 擋下。翻譯不再是權限判斷的一部分。
    """
    with visitor.user.http.session_transaction() as sess:
        sess["virtual_src_path"] = "/workspace/main.cpp"
        sess["real_src_path"] = victim.secret_path

    response = visitor.get("/read_file", "/workspace/main.cpp")
    assert response.status_code == 400, response.data
    assert b"VICTIM-ONLY-CONTENT" not in response.data


# ---------------------------------------------------------------------------
# 沒有 jail 就不做事（絕不退回 root）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES)
def test_without_a_live_jail_the_route_refuses(flask_app, route):
    """沒有 jail 時 `confine(None, argv)` 會原樣執行 argv——那就是 root。

    所以「沒有 jail」必須是拒絕，不是降級。路由刻意不自己 acquire：
    4c54fc1 才剛把「便宜的請求會建立 OS 帳號」這件事拿掉。
    """
    user = register_user(flask_app)
    assert jail_manager.get(user.owner_key) is None
    response = user.http.get(
        route,
        query_string={"path": "/usr/include/stdio.h", "start_line": 1, "end_line": 3},
        headers={"x-csrftoken": user.csrf},
    )
    assert response.status_code == 400, response.data
    assert json.loads(response.data) == {"message": "File not found or not accessible"}


# ---------------------------------------------------------------------------
# 上限與奇怪的檔案
# ---------------------------------------------------------------------------


def test_a_huge_file_does_not_come_back_whole(visitor):
    """原本的實作是 `f.read().split("\\n")`：整個檔案先進記憶體。

    這裡放一個 12 MB 的檔案（超過 MAX_SCAN_BYTES），要求一段離譜的行數範圍。
    回應必須是有界的，而且不能是新的一種錯誤——截斷是成功的一種。
    """
    big = str(visitor.jail.dir / "big.cpp")
    line = "// " + "x" * 76 + "\n"
    jail_manager.write_session_file(big, line * 150000, visitor.jail, 0o600)

    response = visitor.get("/read_file", big, start_line=1, end_line=10**9)
    assert response.status_code == 200, response.data
    body = json.loads(response.data)
    assert len(body["source_code_array"]) <= 20000
    assert len(response.data) < 4 * 1024 * 1024


def test_one_absurdly_long_line_does_not_blow_up(visitor):
    """沒有換行的大檔不能把緩衝區撐爆。"""
    path = str(visitor.jail.dir / "oneline.cpp")
    jail_manager.write_session_file(path, "a" * (3 * 1024 * 1024), visitor.jail, 0o600)
    response = visitor.get("/read_file", path, start_line=1, end_line=2)
    assert response.status_code == 200, response.data
    assert len(response.data) < 4 * 1024 * 1024


def test_a_fifo_in_your_own_scratch_is_refused_not_hung(visitor):
    """scratch 由不可信的使用者持有，他可以在裡面放 FIFO。

    `open()` 一個沒有寫入端的 FIFO 會**永遠卡住**——在 eventlet 單執行緒上就是
    整台伺服器停擺。O_NONBLOCK + S_ISREG 讓它立刻變成一次普通的拒絕。
    """
    fifo = str(visitor.jail.dir / "trap.fifo")
    os.mkfifo(fifo, 0o600)
    os.chown(fifo, visitor.jail.uid, visitor.jail.gid)
    response = visitor.get("/read_file", fifo)
    assert response.status_code == 400, response.data


def test_a_directory_is_refused(visitor):
    """原本的 os.path.isfile 也只接受一般檔案。"""
    response = visitor.get("/read_file", str(visitor.jail.dir))
    assert response.status_code == 400, response.data


def test_line_counting_matches_the_old_split_semantics(visitor):
    """num_lines_in_file 沿用 `f.read().split("\\n")` 的語意。

    以 "\\n" 結尾的檔案最後會多一個空字串元素（"a\\nb\\n" → 3）。前端的捲動
    邊界照這個數字算，悄悄改掉它就是悄悄改掉 SourceCode 的行為。
    """
    path = str(visitor.jail.dir / "two.cpp")
    jail_manager.write_session_file(path, "a\nb\n", visitor.jail, 0o600)
    body = visitor.source(path, 1, 10)
    assert body["num_lines_in_file"] == 3
    assert body["end_line"] == 3
    assert body["source_code_array"] == ["a", "b", " "]  # 空行換成空白，行號才對得上


def test_missing_arguments_are_a_plain_refusal(visitor):
    """以前少一個 start_line 會是未捕捉的 TypeError（500）。"""
    response = visitor.user.http.get(
        "/read_file",
        query_string={"path": "/usr/include/stdio.h"},
        headers={"x-csrftoken": visitor.user.csrf},
    )
    assert response.status_code == 400, response.data
