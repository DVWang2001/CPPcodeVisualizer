from flask_socketio import send, SocketIO  # type: ignore
import pytest  # type: ignore

from gdbgui.server.server import run_server
from gdbgui.server.app import app, socketio
from gdbgui import cli

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
def test_client():
    return app.test_client()


def test_load_main_page(test_client):
    response = test_client.get("/")
    assert response.status_code == 200
    assert "<!DOCTYPE html>" in response.data.decode()


def test_dashboard_needs_a_binary_in_this_session(test_client):
    """/dashboard 一直都有 require_uploaded_binary() 這個前置條件。"""
    response = test_client.get("/dashboard")
    assert response.status_code == 302
    assert "/upload" in response.headers["Location"]


def test_load_dashboard(test_client):
    # 前置條件要自己擺好。以前這個測試會過，是因為 test_load_main_page 順手把
    # 一支預設 hello world 編出來塞進**全域** app.config["initial_binary_and_args"]
    # ——而那正是「單純載入一個頁面就配置一個 jail」的來源（pre-auth DoS）。
    # 頁面渲染不再碰 jail_manager、不再編譯，所以那個跨測試的副作用沒有了。
    with test_client.session_transaction() as flask_session:
        flask_session["uploaded_binary"] = "/tmp/not-a-real-binary"

    response = test_client.get("/dashboard")
    assert response.status_code == 200
    assert "<!DOCTYPE html>" in response.data.decode()


def test_cant_load_bad_url(test_client):
    response = test_client.get("/asdf")
    assert response.status_code == 404
    assert "404 Not Found" in response.data.decode()


def test_same_port():
    run_server(testing=True, app=app, socketio=socketio)


def test_get_initial_binary_and_args():
    assert cli.get_initial_binary_and_args([], "./program --args") == [
        "./program",
        "--args",
    ]
    assert cli.get_initial_binary_and_args(["./program", "--args",], None) == [
        "./program",
        "--args",
    ]
