"""全站登入閘門：**每一條**非豁免路由都必須拒絕未登入的請求。

這條測試刻意**列舉 app 自己的 url_map**，而不是手寫一份路徑清單。手寫的清單
會爛掉：有人加了一條路由卻忘了想登入這件事，手寫清單不會知道，測試繼續全綠，
而那條路由是公開的。從 url_map 生成的話，新路由自動被納入，忘記處理就會紅。

閘門本身在 `http_util.require_login`（註冊為 before_request），預設拒絕，
白名單是 `http_util.PUBLIC_ENDPOINTS`。
"""

import re

import pytest

from gdbgui.server.http_util import CSRF_EXEMPT_ENDPOINTS, PUBLIC_ENDPOINTS


#: 這些方法瀏覽器/werkzeug 會自動補上，不代表一條真正的入口。
_IGNORED_METHODS = {"HEAD", "OPTIONS"}

#: `<int:foo>` / `<path:bar>` / `<baz>` → 一個具體的值，才組得出真的 URL。
_RULE_PARAM_RE = re.compile(r"<(?:([a-zA-Z_]+):)?([a-zA-Z_][a-zA-Z0-9_]*)>")


def _concrete_url(rule) -> str:
    def substitute(match):
        converter = match.group(1)
        if converter == "int":
            return "1"
        if converter == "float":
            return "1.0"
        if converter == "path":
            return "probe/probe"
        return "probe"

    return _RULE_PARAM_RE.sub(substitute, rule.rule)


def _gated_requests(app):
    """(endpoint, method, url) —— 每一條非豁免路由的每一個真正的方法。"""
    for rule in app.url_map.iter_rules():
        if rule.endpoint in PUBLIC_ENDPOINTS:
            continue
        for method in sorted(set(rule.methods) - _IGNORED_METHODS):
            yield rule.endpoint, method, _concrete_url(rule)


def _anonymous_client_with_csrf(app):
    """未登入、但拿著**有效** CSRF token 的瀏覽器。

    CSRF token 拿得到這件事本身就是重點：它是任何訪客 GET 一次登入頁就有的
    東西。若不帶它，POST 路由會被 CSRF 那道檢查擋掉（403），測試就變成在測
    CSRF 而不是在測登入閘門——「拿掉登入閘門」這個退化會照樣通過。
    """
    client = app.test_client()
    assert client.get("/login").status_code == 200
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    assert csrf
    return client, csrf


def _refused(response) -> bool:
    if response.status_code == 401:
        return True
    if response.status_code in (302, 303) and "/login" in response.headers.get(
        "Location", ""
    ):
        return True
    return False


# ---------------------------------------------------------------------------
# 頭條主張
# ---------------------------------------------------------------------------


def test_every_registered_route_is_gated(flask_app):
    """未登入 + 有效 CSRF token → 每一條非豁免路由都被拒。"""
    client, csrf = _anonymous_client_with_csrf(flask_app)

    checked = []
    leaked = []
    for endpoint, method, url in _gated_requests(flask_app):
        response = client.open(
            url,
            method=method,
            data={"csrf_token": csrf},
            headers={"x-csrftoken": csrf},
        )
        checked.append((endpoint, method))
        if not _refused(response):
            leaked.append((endpoint, method, url, response.status_code))

    assert checked, "no gated routes were found -- the enumeration itself is broken"
    assert not leaked, (
        "these routes answered an unauthenticated request:\n"
        + "\n".join(f"  {e} {m} {u} -> {s}" for e, m, u, s in leaked)
    )


def test_the_enumeration_actually_covers_the_real_routes(flask_app):
    """守住上面那條測試的前提。

    `_gated_requests` 要是哪天因為 url_map 的形狀變了而回傳空的、或漏掉主要
    路由，上面那條會變成一條永遠通過的空測試。這裡釘住幾個一定要在裡面的
    endpoint —— 它們是最敏感的那幾條（起 GDB、編譯、送訊號）。
    """
    covered = {endpoint for endpoint, _, _ in _gated_requests(flask_app)}
    for endpoint in (
        "http_routes.gdbgui",
        "http_routes.create_and_upload",
        "http_routes.send_signal",
        "http_routes.read_file",
        "http_routes.prerun_calltree",
        "http_routes.dashboard_data",
        "http_routes.kill_session",
        "auth.profile",
    ):
        assert endpoint in covered, f"{endpoint} is missing from the gated enumeration"


def test_unknown_paths_are_refused_too(flask_app):
    """預設拒絕不對「沒有對應到路由」的請求破例。

    對未登入者來說「這條路徑存不存在」不該可觀察；而一個對未知路徑破例的
    「預設拒絕」本來就不是預設拒絕。
    """
    client, _ = _anonymous_client_with_csrf(flask_app)
    assert _refused(client.get("/definitely-not-a-route"))


# ---------------------------------------------------------------------------
# 豁免清單本身
# ---------------------------------------------------------------------------


def test_the_exempt_list_is_exactly_the_login_and_live_quiz_guest_flow(flask_app):
    """白名單改動必須是有意識的。

    這是一條刻意的「變更偵測」測試：PUBLIC_ENDPOINTS 是全站唯一的豁免清單，
    往裡面加東西＝把一條路由公開出去，那件事應該要讓一條測試變紅、需要有人
    看過並改掉，而不是靜靜地生效。
    """
    assert PUBLIC_ENDPOINTS == frozenset(
        {
            "auth.login",
            "auth.register",
            "auth.logout",
            "static",
            "live_quiz.join_page",
            "live_quiz.guest_join",
            "live_quiz.guest_state_route",
            "live_quiz.guest_answer",
        }
    )
    assert CSRF_EXEMPT_ENDPOINTS == frozenset(
        {"live_quiz.guest_join", "live_quiz.guest_answer"}
    )


@pytest.mark.parametrize("path", ["/login", "/register", "/logout"])
def test_the_login_flow_itself_is_reachable_without_logging_in(flask_app, path):
    """反向：閘門不可以連登入頁都擋住（那樣沒有人進得來）。"""
    client = flask_app.test_client()
    response = client.get(path)
    assert response.status_code == 200, path


def test_static_assets_are_reachable_without_logging_in(flask_app):
    client = flask_app.test_client()
    response = client.get("/static/favicon.ico")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# 正向：登入之後這些路由真的打得開
# ---------------------------------------------------------------------------


def test_logging_in_opens_the_gate(logged_in):
    """否則上面那些全部可以用「所有東西都回 401」來作弊通過。"""
    assert logged_in.http.get("/").status_code == 200
    assert logged_in.http.get(f"/u/{logged_in.username}").status_code == 200
    # 404 而不是 401/302：閘門已經放行，只是這條路徑不存在。
    assert logged_in.http.get("/definitely-not-a-route").status_code == 404
