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
    assert "8" in response.get_json()["message"]


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
