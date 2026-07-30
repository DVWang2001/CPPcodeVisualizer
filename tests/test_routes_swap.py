"""主頁換成瀏覽頁、除錯器搬到 /edit，以及兩條保住舊書籤的轉址。"""

from gdbgui.server import db

from .conftest import register_user


def test_the_root_is_no_longer_the_debugger(flask_app):
    """這個任務只換路由，模板是 Task 6 的事。所以這裡驗的是「根路徑不再是
    除錯器」——用 initial_data 判斷，那是除錯器頁面才有的東西，不依賴任何
    還沒建立的 data-testid。"""
    user = register_user(flask_app, display_name="rt_a")
    response = user.http.get("/")
    assert response.status_code == 200
    assert b"initial_data" not in response.data


def test_edit_serves_the_debugger(flask_app):
    user = register_user(flask_app, display_name="rt_b")
    response = user.http.get("/edit")
    assert response.status_code == 200
    assert b"initial_data" in response.data


def test_the_old_lessons_url_redirects_to_the_root(flask_app):
    user = register_user(flask_app, display_name="rt_c")
    response = user.http.get("/lessons")
    assert response.status_code == 302
    assert response.headers["Location"].endswith("/")


def test_the_old_lesson_deeplink_redirects_to_edit(flask_app):
    """/?lesson=42 是既有的教案連結，必須繼續有用。"""
    user = register_user(flask_app, display_name="rt_d")
    response = user.http.get("/?lesson=42")
    assert response.status_code == 302
    assert "/edit?lesson=42" in response.headers["Location"]


def test_the_root_still_requires_login(flask_app):
    """首頁換成瀏覽頁不代表它變公開。"""
    anon = flask_app.test_client()
    response = anon.get("/")
    assert response.status_code == 302
    assert "/login" in response.headers["Location"]


def test_edit_also_requires_login(flask_app):
    anon = flask_app.test_client()
    assert anon.get("/edit").status_code == 302


def test_an_out_of_range_page_is_clamped_not_an_error(flask_app):
    """status 200 本身不足以證明有夾——sqlite 的 OFFSET 超界也只是回空結果，
    照樣 200。真正要釘住的是「顯示的 page 被夾回 last_page」，否則
    ?page=99999999999 進到 db.search_lessons 的 offset 完全沒被擋。"""
    user = register_user(flask_app, display_name="rt_f")
    last_page = max(1, -(-db.search_count() // db.LESSONS_PER_PAGE))
    response = user.http.get("/?page=99999999999")
    assert response.status_code == 200
    body = response.data.decode("utf-8")
    assert f"{last_page} / {last_page}" in body, body


def test_the_old_gdbpid_deeplink_redirects_to_edit(flask_app):
    """dashboard 的「Connect to Session／Copy Sharable URL」以前產生的是
    /?gdbpid=N。主頁換了用途之後，這種已經被貼出去的舊網址也得繼續有用，
    否則使用者打開它只會看到一份教案清單，完全看不出附掛失敗了。"""
    user = register_user(flask_app, display_name="rt_g")
    response = user.http.get("/?gdbpid=4242")
    assert response.status_code == 302
    location = response.headers["Location"]
    assert location.startswith("/edit")
    assert "gdbpid=4242" in location


def test_the_lesson_deeplink_redirect_keeps_every_other_query_param(flask_app):
    """轉址不能只挑 lesson 出來、把其他參數（例如 gdb_command）丟在地上——
    那樣使用者拿到的是一個「看起來成功、行為卻不同」的頁面。"""
    user = register_user(flask_app, display_name="rt_h")
    response = user.http.get("/?lesson=42&gdb_command=xyz")
    assert response.status_code == 302
    location = response.headers["Location"]
    assert "lesson=42" in location
    assert "gdb_command=xyz" in location


def test_the_legacy_lessons_redirect_keeps_repeated_tag_params(flask_app):
    """request.args.to_dict(flat=True) 對重複參數只留第一個；/lessons 若被當
    長期入口，這樣會悄悄吃掉多選標籤。轉址必須保留兩個 tag。"""
    user = register_user(flask_app, display_name="rt_i")
    response = user.http.get("/lessons?tag=a&tag=b")
    assert response.status_code == 302
    location = response.headers["Location"]
    assert "tag=a" in location
    assert "tag=b" in location
