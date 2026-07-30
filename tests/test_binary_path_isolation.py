"""跨使用者路徑外洩的回歸測試：網頁編譯不得寫入 process 全域設定。

背景
----
`app.config["initial_binary_and_args"]` 是 **process 全域** 的一格。它原本只有
一個合法來源：部署者在命令列啟動 gdbgui 時帶的 binary（見 cli.py），那是部署
設定，對所有人都一樣。

但 `/upload` 與 `/create_and_upload` 這兩條網頁路徑，在每次成功編譯之後也會把
**該使用者的 scratch 路徑** 寫進同一格。那個路徑裡含著他的 session prefix（也就是
他的身分／jail key）。之後任何一個陌生訪客載入首頁，render 出來的 `initial_data`
就會帶著上一個編譯者的路徑——而且前端 BinaryLoader 會把它當成自己的 binary 直接
載入。對一個開放註冊的部署來說，這是跨使用者的資訊揭露。

修法不是在 render 那端多做一層挑選，而是**移除那四個寫入**：每個寫入點旁邊本來
就有等價的 `session["uploaded_binary"]`，全域那份純屬冗餘。全域那格因此回到單一
來源＝CLI，render 的 fallback 也就只會回到部署設定，不會回到別人的資料。

下面的測試同時鎖住兩個方向：
  * 別人的路徑不會外流（負向）；
  * 自己的路徑仍然拿得回來、CLI 帶的 binary 仍然送得到前端（正向）。
只有負向那半條會讓「把全域寫回去」這個退化通過，所以兩邊都要有。

真的編譯的那幾條需要容器內的執行隔離（root + setpriv/unshare/useradd）；
純渲染契約的那兩條在哪裡都跑得動。
"""

import json
import re

import pytest

from gdbgui.server.sandbox import jail_manager

from .conftest import LoggedInUser, register_user


needs_isolation = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="compiling through the web routes needs root + setpriv/unshare/useradd",
)


HELLO = "int main(){return 0;}\n"


@pytest.fixture
def gdbgui_app():
    """真的 app，但每個測試都把全域那格還原，避免測試之間互相汙染。"""
    from gdbgui.server.app import app, socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=app, socketio=socketio)
    saved = app.config.get("initial_binary_and_args")
    try:
        yield app
    finally:
        app.config["initial_binary_and_args"] = saved


class Visitor(LoggedInUser):
    """一個使用者：自己的帳號、cookie jar、csrf token、jail。

    全站要求登入之後「一個訪客」就是「一個註冊過的使用者」——身分的單位從
    cookie 換成了帳號（http_util.owner_key），所以 `prefix`（＝jail 的 key）
    現在來自登入的 user id，而不是 session 裡憑空生的 uuid。
    """

    def __init__(self, app):
        user = register_user(app)
        super().__init__(app, user.http, user.user_id, user.username, user.csrf)
        assert self.http.get("/edit").status_code == 200

    def compile(self, code=HELLO):
        """走使用者真正走的那條路：POST /create_and_upload，拿回自己的 binary 路徑。"""
        resp = self.http.post(
            "/create_and_upload",
            data={"csrf_token": self.csrf, "code": code},
            headers={"Accept": "application/json", "x-csrftoken": self.csrf},
        )
        assert resp.status_code == 200, resp.data
        body = resp.get_json()
        assert body["status"] == "success", body
        return body["binary_path"]

    def initial_data(self):
        """/edit render 給這個 session 看的 initial_data（前端讀的就是這一份）。

        以前這是首頁；主頁換成教案瀏覽之後除錯器搬到 /edit。
        """
        resp = self.http.get("/edit")
        assert resp.status_code == 200
        return _parse_initial_data(resp.data.decode()), resp.data.decode()

    def close(self):
        jail_manager.release(self.prefix)


def _parse_initial_data(html):
    """templates/gdbgui.html 是 `initial_data = {{ initial_data | tojson }}`（單行）。"""
    match = re.search(r"^\s*initial_data = (\{.*\})\s*$", html, re.MULTILINE)
    assert match, "could not find initial_data in the rendered page"
    return json.loads(match.group(1))


# ---------------------------------------------------------------------------
# 負向：別人的東西不能出現在我的頁面上
# ---------------------------------------------------------------------------


@needs_isolation
def test_web_compile_does_not_touch_the_process_global(gdbgui_app):
    """核心不變式：網頁編譯只寫 session，不寫 app.config。

    這是整個修法的支點。全域那格只要還會被網頁編譯寫，之後任何一個 render 的
    fallback 都是潛在的外洩點；不寫它，就沒有東西可洩。
    """
    gdbgui_app.config["initial_binary_and_args"] = []
    visitor = Visitor(gdbgui_app)
    try:
        binary = visitor.compile()
        assert binary  # 確實編出東西來了，不是因為沒編所以沒寫
        assert gdbgui_app.config["initial_binary_and_args"] == [], (
            "web compile wrote the caller's scratch path into process-global config"
        )
    finally:
        visitor.close()


@needs_isolation
def test_a_second_visitor_never_sees_the_first_users_path(gdbgui_app):
    """A 編譯，B 載入頁面：B 的 initial_data 不能有 A 的任何東西。

    比對的不只是 initial_binary_and_args 那個欄位，而是**整份 HTML**：
    A 的 scratch 路徑裡含著 A 的 session prefix，它若從任何其他欄位漏出去
    （未來新增的欄位、除錯訊息、模板某處），這條測試一樣要壞掉。
    """
    gdbgui_app.config["initial_binary_and_args"] = []
    alice = Visitor(gdbgui_app)
    bob = Visitor(gdbgui_app)
    try:
        alice_binary = alice.compile()

        bob_data, bob_html = bob.initial_data()
        assert bob_data["initial_binary_and_args"] == [], bob_data[
            "initial_binary_and_args"
        ]
        assert alice_binary not in bob_html
        assert alice.prefix not in bob_html
    finally:
        bob.close()
        alice.close()


@needs_isolation
def test_the_upload_gate_is_not_opened_by_someone_elses_compile(gdbgui_app):
    """順帶鎖住的授權面：/dashboard 的前置條件是「**我**有 binary」。

    require_uploaded_binary() 會 fallback 到全域那格，所以在修法之前，只要有人
    編譯過，任何沒編譯過的訪客都能通過這道門。這不是資訊揭露而是門檻被別人的
    行為打開，一併鎖住。
    """
    gdbgui_app.config["initial_binary_and_args"] = []
    alice = Visitor(gdbgui_app)
    bob = Visitor(gdbgui_app)
    try:
        alice.compile()
        resp = bob.http.get("/dashboard")
        assert resp.status_code == 302
        assert "/upload" in resp.headers["Location"]
    finally:
        bob.close()
        alice.close()


# ---------------------------------------------------------------------------
# 正向：該拿得到的東西還是拿得到（否則上面那些全部可以用「一律回空」作弊通過）
# ---------------------------------------------------------------------------


@needs_isolation
def test_the_compiling_session_still_gets_its_own_binary_back(gdbgui_app):
    gdbgui_app.config["initial_binary_and_args"] = []
    alice = Visitor(gdbgui_app)
    try:
        alice_binary = alice.compile()
        data, _ = alice.initial_data()
        assert data["initial_binary_and_args"] == [alice_binary]
    finally:
        alice.close()


def test_cli_supplied_binary_still_reaches_the_frontend(gdbgui_app):
    """CLI 帶進來的 binary 是部署設定，不是使用者資料，繼續照舊送給所有人。

    這一格如果哪天也要收起來，那是一個獨立的產品決定（單人本機模式會因此
    退化），不該是移除網頁寫入的順帶副作用——所以在這裡明文釘住現狀。
    """
    gdbgui_app.config["initial_binary_and_args"] = ["/usr/bin/true", "--flag"]
    visitor = Visitor(gdbgui_app)
    try:
        data, _ = visitor.initial_data()
        assert data["initial_binary_and_args"] == ["/usr/bin/true", "--flag"]
    finally:
        visitor.close()


def test_cli_supplied_binary_also_satisfies_the_upload_gate(gdbgui_app):
    """CLI 模式下沒有人「上傳」過，/dashboard 仍要能開。"""
    gdbgui_app.config["initial_binary_and_args"] = ["/usr/bin/true"]
    visitor = Visitor(gdbgui_app)
    try:
        assert visitor.http.get("/dashboard").status_code == 200
    finally:
        visitor.close()
