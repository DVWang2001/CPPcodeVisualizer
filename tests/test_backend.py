from flask_socketio import send, SocketIO  # type: ignore
import pytest  # type: ignore

from gdbgui.server.server import run_server
from gdbgui.server.app import app, socketio

run_server(testing=True, app=app, socketio=socketio)


def test_connect():
    test_ws = SocketIO()

    @test_ws.on("connect")
    def on_connect():
        send({"connected": "foo"}, json=True)

    test_ws.init_app(app, cookie="foo")
    client = test_ws.test_client(app)
    received = client.get_received()
    assert len(received) == 1
    assert received[0]["args"] == {"connected": "foo"}


@pytest.fixture
def test_client(logged_in):
    """全站要求登入之後，「一個瀏覽器」的意思就是「一個已登入的瀏覽器」。

    這幾條測的是頁面本身，不是閘門（閘門在 tests/test_route_gate.py）。
    """
    return logged_in.http


def test_load_main_page(test_client):
    response = test_client.get("/")
    assert response.status_code == 200
    assert "<!DOCTYPE html>" in response.data.decode()


def test_the_main_page_needs_a_login():
    """對照組：沒登入就看不到它。"""
    anonymous = app.test_client()
    response = anonymous.get("/")
    assert response.status_code == 302
    assert "/login" in response.headers["Location"]


def test_cant_load_bad_url(test_client):
    response = test_client.get("/asdf")
    assert response.status_code == 404
    assert "404 Not Found" in response.data.decode()


def test_same_port():
    run_server(testing=True, app=app, socketio=socketio)


def test_edit_ignores_a_stale_uploaded_binary_in_an_old_cookie(test_client):
    """舊 cookie 裡可能還留著伺服器 GDB 時代的 session["uploaded_binary"]。
    /edit 必須照常渲染，而且不再把那個路徑回音進頁面（initial_binary_and_args 恆為空）。

    用一個**真的存在**的路徑：舊的 /edit 只在檔案不存在時才清掉它，存在就原樣
    塞進 initial_binary_and_args。"""
    with test_client.session_transaction() as flask_session:
        flask_session["uploaded_binary"] = "/bin/sh"

    response = test_client.get("/edit")
    assert response.status_code == 200
    body = response.data.decode()
    assert '"/bin/sh"' not in body
    assert '"initial_binary_and_args": []' in body
