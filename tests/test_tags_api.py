"""標籤 API 的授權與驗證。

一句話說完這個端點的規則：只有作者能改，別人一律 404。
"""

import json

from gdbgui.server import db, tags
from .conftest import register_user


def _post_tags(user, lesson_id, raw):
    # LoggedInUser 的 test client 是 .http，csrf token 是 .csrf（見 conftest）。
    return user.http.post(
        f"/api/lessons/{lesson_id}/tags",
        data=json.dumps({"tags": raw}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )


def _lesson(user_id):
    return db.create_lesson(user_id, "題目", '{"version":"2.0","source_code":"int main(){}"}')


def test_the_author_can_set_tags(flask_app):
    author = register_user(flask_app, display_name="api_a")
    lid = _lesson(author.user_id)
    response = _post_tags(author, lid, "BST, STL")
    assert response.status_code == 200
    assert response.get_json()["tags"] == ["bst", "stl"]


def test_a_non_author_gets_404_and_changes_nothing(flask_app):
    """404 而不是 403：403 等於確認「這篇存在但不是你的」。"""
    author = register_user(flask_app, display_name="api_b1")
    other = register_user(flask_app, display_name="api_b2")
    lid = _lesson(author.user_id)
    tags.set_lesson_tags(lid, author.user_id, "原本的")

    assert _post_tags(other, lid, "被改掉").status_code == 404
    assert tags.tags_for_lessons([lid]) == {lid: ["原本的"]}


def test_a_missing_lesson_gets_404(flask_app):
    user = register_user(flask_app, display_name="api_c")
    assert _post_tags(user, 999_999_999, "x").status_code == 404


def test_too_many_tags_gets_400_with_a_message(flask_app):
    user = register_user(flask_app, display_name="api_d")
    lid = _lesson(user.user_id)
    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON + 1))
    response = _post_tags(user, lid, raw)
    assert response.status_code == 400
    # 用常數而不是字面的 "8"：上限改成 10 的那天，硬寫的 "8" 會讓這條測試假紅，
    # 而它真正要主張的是「訊息說得出上限是多少」。
    assert str(tags.MAX_TAGS_PER_LESSON) in response.get_json()["message"]


def test_an_over_long_tag_gets_400(flask_app):
    user = register_user(flask_app, display_name="api_e")
    lid = _lesson(user.user_id)
    assert _post_tags(user, lid, "x" * (tags.MAX_TAG_LENGTH + 1)).status_code == 400


def test_clearing_tags_with_an_empty_string_works(flask_app):
    user = register_user(flask_app, display_name="api_f")
    lid = _lesson(user.user_id)
    _post_tags(user, lid, "a, b")
    response = _post_tags(user, lid, "")
    assert response.status_code == 200
    assert response.get_json()["tags"] == []


def test_a_body_without_the_tags_field_is_refused_and_changes_nothing(flask_app):
    """缺欄位不等於清空。

    `request.get_json(silent=True)` 在**任何**解析失敗時都回 None——Content-Type
    打錯、body 被截斷、送空 body——把那當成「清空」等於讓一個破壞性操作在請求
    根本沒讀懂的時候 fail open。清空必須是明確送出的 {"tags": ""}。
    """
    user = register_user(flask_app, display_name="api_h")
    lid = _lesson(user.user_id)
    tags.set_lesson_tags(lid, user.user_id, "留著")

    response = user.http.post(
        f"/api/lessons/{lid}/tags",
        data=json.dumps({}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )
    assert response.status_code == 400
    assert tags.tags_for_lessons([lid]) == {lid: ["留著"]}


def test_a_non_object_body_is_refused(flask_app):
    """body 是陣列／數字／字串時要回 400，不是 500（也不是靜默清空）。"""
    user = register_user(flask_app, display_name="api_i")
    lid = _lesson(user.user_id)
    tags.set_lesson_tags(lid, user.user_id, "留著")

    for body in ("[1,2,3]", "0", '"tags"', "null"):
        response = user.http.post(
            f"/api/lessons/{lid}/tags",
            data=body,
            content_type="application/json",
            headers={"x-csrftoken": user.csrf},
        )
        assert response.status_code == 400, body
    assert tags.tags_for_lessons([lid]) == {lid: ["留著"]}


def test_the_two_404s_are_indistinguishable(flask_app):
    """「不是你的」與「不存在」必須連 body 都一樣。

    只比狀態碼的話，`{"message": "這篇教案不是你的。"}` 這種 404 會通過——而那
    就是一台「哪些教案 id 有主人」的探測機，正是這個端點唯一的硬性安全要求。
    """
    author = register_user(flask_app, display_name="api_j1")
    other = register_user(flask_app, display_name="api_j2")
    lid = _lesson(author.user_id)

    someone_elses = _post_tags(other, lid, "x")
    does_not_exist = _post_tags(other, 999_999_998, "x")

    assert someone_elses.status_code == does_not_exist.status_code == 404
    assert someone_elses.get_json() == does_not_exist.get_json()

    # 上面兩行只保證這兩個回應「彼此一樣」——而它們現在來自同一個 return，所以
    # 一個把訊息換成「這篇教案不是你的。」的改動會讓它們一起變、兩行照樣綠。
    # 再釘一次：這個拒絕必須跟教案 API 其他地方的「找不到」長得一模一樣，
    # 刻意拿另一條路由的實際回應來比，而不是複製一份訊息常數到測試裡。
    canonical = other.http.get("/api/lessons/999999997")
    assert canonical.status_code == 404
    assert someone_elses.get_json() == canonical.get_json()


def test_the_route_never_looks_the_lesson_up_itself(flask_app, monkeypatch):
    """擁有權只能由 tags.set_lesson_tags 在它自己的交易裡判斷。

    路由層若自己先 db.lesson_by_id 查一次再決定，就多開了一個「查完到寫入之間
    擁有者已經變了」的空窗，而且會有兩個地方各自宣稱誰能寫。這裡把那個查詢
    直接引爆：路由只要偷查就會 500，回不到 404。
    """
    from gdbgui.server import http_routes

    author = register_user(flask_app, display_name="api_k1")
    other = register_user(flask_app, display_name="api_k2")
    lid = _lesson(author.user_id)
    tags.set_lesson_tags(lid, author.user_id, "原本的")

    def _boom(*args, **kwargs):
        raise AssertionError("路由層不可以自己查教案擁有者")

    monkeypatch.setattr(http_routes.db, "lesson_by_id", _boom)

    assert _post_tags(other, lid, "被改掉").status_code == 404
    assert tags.tags_for_lessons([lid]) == {lid: ["原本的"]}


def test_an_oversized_body_is_refused_before_it_is_parsed(flask_app, monkeypatch):
    """全域 MAX_CONTENT_LENGTH：超過上限的 body 回 413，不會被讀進記憶體。

    這條防線刻意是全域的（app.py），不是這條路由自己的——explain_error、
    generate_lesson、/upload 都靠它。這裡調小上限來測，而不是真的送 16 MB。
    """
    user = register_user(flask_app, display_name="api_l")
    lid = _lesson(user.user_id)
    monkeypatch.setitem(flask_app.config, "MAX_CONTENT_LENGTH", 1024)

    response = user.http.post(
        f"/api/lessons/{lid}/tags",
        data=json.dumps({"tags": "x" * 4096}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )
    assert response.status_code == 413
    assert tags.tags_for_lessons([lid]) == {lid: []}


def test_the_global_body_limit_is_actually_configured(flask_app):
    """上限本身要存在且是那個值——上一條調小之後仍然可能是 None 就沒防線。"""
    assert flask_app.config["MAX_CONTENT_LENGTH"] == 16 * 1024 * 1024


def test_a_request_without_the_csrf_header_is_refused(flask_app):
    """全域 before_request 擋所有 POST；漏帶 header 會 400/415 而不是靜默成功。"""
    user = register_user(flask_app, display_name="api_g")
    lid = _lesson(user.user_id)
    response = user.http.post(
        f"/api/lessons/{lid}/tags",
        data=json.dumps({"tags": "x"}),
        content_type="application/json",
    )
    assert response.status_code >= 400
    assert tags.tags_for_lessons([lid]) == {lid: []}
