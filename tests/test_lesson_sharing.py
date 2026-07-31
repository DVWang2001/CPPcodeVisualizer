"""教案分享（子專案 C）：授權、分頁、大小上限、XSS。

設計文件：docs/superpowers/specs/2026-07-30-lesson-sharing-design.md

這個切片的整個授權面是一條規則：**user_id 永遠取自 session，絕不從請求讀取**。
所以底下最重要的幾條測試是「明確夾帶別人的 user_id」那幾條——不是「沒帶」，
是帶了而且帶的是真的存在的另一個人的 id。

「更新別人的教案 → 得到自己名下的副本」也在這裡：那是刻意的行為而不是漏洞，
但它的正確性條件是「原件一個位元組都沒變」，所以每一條 fork 測試都會回頭把
原件重新讀出來比對。
"""

import json
from contextlib import closing

import pytest

from gdbgui.server import db
from .conftest import register_user


# ---------------------------------------------------------------------------
# 輔助
# ---------------------------------------------------------------------------


def _bundle(source: str = "int main() { return 0; }"):
    return {
        "version": "2.0",
        "fullname_to_render": "main.cpp",
        "source_code": source,
        "breakpoints": [],
        "program_input": "",
    }


def _post_lesson(user, title="我的教案", bundle=None, extra=None):
    body = {"title": title, "bundle": bundle if bundle is not None else _bundle()}
    if extra:
        body.update(extra)
    return user.http.post(
        "/api/lessons",
        data=json.dumps(body),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )


def _put_lesson(user, lesson_id, title="改過的標題", bundle=None, extra=None):
    body = {"title": title, "bundle": bundle if bundle is not None else _bundle("// edited")}
    if extra:
        body.update(extra)
    return user.http.put(
        f"/api/lessons/{lesson_id}",
        data=json.dumps(body),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )


def _delete_lesson(user, lesson_id):
    return user.http.delete(
        f"/api/lessons/{lesson_id}", headers={"x-csrftoken": user.csrf}
    )


def _create(user, title="教案", bundle=None):
    response = _post_lesson(user, title=title, bundle=bundle)
    assert response.status_code == 201, response.data
    return response.get_json()["id"]


@pytest.fixture
def alice(flask_app):
    return register_user(flask_app, display_name="Alice")


@pytest.fixture
def bob(flask_app):
    return register_user(flask_app, display_name="Bob")


# ---------------------------------------------------------------------------
# 1. user_id 只來自 session
# ---------------------------------------------------------------------------


def test_create_ignores_a_user_id_in_the_body(alice, bob):
    """建立時夾帶別人的 user_id：教案仍然記在**送出請求的人**名下。

    不是「沒帶所以沒事」——這裡帶的是 bob 真實存在的 id。
    """
    response = _post_lesson(alice, title="不是 bob 的", extra={"user_id": bob.user_id})
    assert response.status_code == 201, response.data
    lesson_id = response.get_json()["id"]

    row = db.lesson_by_id(lesson_id)
    assert int(row["user_id"]) == alice.user_id
    assert int(row["user_id"]) != bob.user_id
    # 而且它確實出現在 alice 的個人檔案、沒有出現在 bob 的。
    assert lesson_id in {int(r["id"]) for r in db.lessons_for_user(alice.user_id)}
    assert lesson_id not in {int(r["id"]) for r in db.lessons_for_user(bob.user_id)}


def test_update_ignores_a_user_id_in_the_body(alice, bob):
    """更新自己的教案時夾帶別人的 user_id：擁有者不會被改掉。"""
    lesson_id = _create(alice, title="原本是 alice 的")

    response = _put_lesson(alice, lesson_id, extra={"user_id": bob.user_id})
    assert response.status_code == 200, response.data
    assert response.get_json()["forked"] is False

    row = db.lesson_by_id(lesson_id)
    assert int(row["user_id"]) == alice.user_id


def test_delete_ignores_a_user_id_in_the_body(alice, bob):
    """刪除時夾帶擁有者的 user_id，也刪不掉別人的教案。"""
    lesson_id = _create(bob, title="bob 的")

    response = alice.http.delete(
        f"/api/lessons/{lesson_id}",
        data=json.dumps({"user_id": bob.user_id}),
        content_type="application/json",
        headers={"x-csrftoken": alice.csrf},
    )
    assert response.status_code == 404
    assert db.lesson_by_id(lesson_id) is not None


# ---------------------------------------------------------------------------
# 2. 更新別人的教案 → 自己名下的副本，原件不變
# ---------------------------------------------------------------------------


def test_updating_someone_elses_lesson_forks_it(alice, bob):
    original_bundle = _bundle("// bob 寫的原文")
    lesson_id = _create(bob, title="bob 的教案", bundle=original_bundle)
    before = db.lesson_by_id(lesson_id)

    response = _put_lesson(
        alice, lesson_id, title="alice 的版本", bundle=_bundle("// alice 改的")
    )
    assert response.status_code == 201, response.data
    payload = response.get_json()
    assert payload["forked"] is True
    assert payload["id"] != lesson_id

    # 副本屬於 alice。
    copy = db.lesson_by_id(payload["id"])
    assert int(copy["user_id"]) == alice.user_id
    assert copy["title"] == "alice 的版本"
    assert json.loads(copy["bundle_json"])["source_code"] == "// alice 改的"

    # 原件一個位元組都沒動——包含 updated_at。
    after = db.lesson_by_id(lesson_id)
    assert int(after["user_id"]) == bob.user_id
    assert after["title"] == before["title"]
    assert after["bundle_json"] == before["bundle_json"]
    assert after["updated_at"] == before["updated_at"]
    assert json.loads(after["bundle_json"])["source_code"] == "// bob 寫的原文"


def test_the_where_clause_is_the_real_check_not_the_route_branch(alice, bob):
    """資料層直接測：非擁有者的 UPDATE 改到 0 列。

    路由那一層會先分支去 fork，所以上面那條測試碰不到這個 WHERE。這條測的是
    「萬一那個分支哪天寫錯」時的最後一道網。
    """
    lesson_id = _create(bob, title="bob 的")
    before = db.lesson_by_id(lesson_id)

    assert db.update_lesson_owned_by(lesson_id, alice.user_id, "偷改", "{}") is None

    after = db.lesson_by_id(lesson_id)
    assert after["title"] == before["title"]
    assert after["bundle_json"] == before["bundle_json"]


# ---------------------------------------------------------------------------
# 2a. 資料層版本歷史
# ---------------------------------------------------------------------------


def _versions_for(lesson_id):
    with closing(db.connect()) as conn:
        return list(
            conn.execute(
                "SELECT v.version, parent.version AS parent_version, v.title, v.bundle_json "
                "FROM lesson_versions v "
                "LEFT JOIN lesson_versions parent ON parent.id = v.parent_version_id "
                "WHERE v.lesson_id = ? ORDER BY v.version",
                (lesson_id,),
            )
        )


def test_a_created_lesson_starts_with_a_v1_snapshot(alice):
    """少了初始快照，任何教案都不能成為可還原的歷史根節點。"""
    assert hasattr(db, "create_lesson_with_version")
    result = db.create_lesson_with_version(alice.user_id, "v1", "{\"source_code\":\"one\"}")

    assert (result.version, result.changed) == (1, True)
    assert [tuple(row) for row in _versions_for(result.lesson_id)] == [
        (1, None, "v1", '{"source_code":"one"}')
    ]
    assert db.lesson_by_id(result.lesson_id)["current_version"] == 1


def test_owner_update_creates_a_child_snapshot_and_old_parent_can_branch(alice):
    """還原後再存必須指回指定舊版，不能改寫既有 v2。"""
    assert hasattr(db, "create_lesson_with_version")
    created = db.create_lesson_with_version(alice.user_id, "v1", "{\"source_code\":\"one\"}")
    second = db.update_lesson_owned_by(
        created.lesson_id, alice.user_id, "v2", '{"source_code":"two"}'
    )
    third = db.update_lesson_owned_by(
        created.lesson_id, alice.user_id, "從 v1 分支", '{"source_code":"three"}', parent_version=1
    )

    assert (second.version, second.changed) == (2, True)
    assert (third.version, third.changed) == (3, True)
    assert [tuple(row) for row in _versions_for(created.lesson_id)] == [
        (1, None, "v1", '{"source_code":"one"}'),
        (2, 1, "v2", '{"source_code":"two"}'),
        (3, 1, "從 v1 分支", '{"source_code":"three"}'),
    ]
    assert db.lesson_by_id(created.lesson_id)["current_version"] == 3


@pytest.mark.parametrize("parent_version", [True, 0, -1, 99])
def test_invalid_parent_version_is_rejected(alice, parent_version):
    """bool、非正數與不存在版本都不可變成歷史父節點。"""
    assert hasattr(db, "create_lesson_with_version")
    created = db.create_lesson_with_version(alice.user_id, "v1", "{}")

    with pytest.raises(db.LessonRejected):
        db.update_lesson_owned_by(
            created.lesson_id, alice.user_id, "壞父節點", "{\"source_code\":\"x\"}", parent_version
        )


def test_parent_version_from_another_lesson_is_rejected(alice):
    """別篇教案的 v2 不能拿來當這篇只有 v1 的父節點。"""
    assert hasattr(db, "create_lesson_with_version")
    target = db.create_lesson_with_version(alice.user_id, "目標 v1", "{}")
    other = db.create_lesson_with_version(alice.user_id, "別篇 v1", "{}")
    db.update_lesson_owned_by(other.lesson_id, alice.user_id, "別篇 v2", '{"source_code":"two"}')

    with pytest.raises(db.LessonRejected):
        db.update_lesson_owned_by(
            target.lesson_id, alice.user_id, "錯誤跨篇", '{"source_code":"x"}', parent_version=2
        )


def test_same_content_owner_save_returns_unchanged_without_a_new_snapshot(alice):
    """無內容變更還新增版本會浪費額度，也會製造假歷史。"""
    assert hasattr(db, "create_lesson_with_version")
    created = db.create_lesson_with_version(alice.user_id, "不變", '{"source_code":"same"}')

    result = db.update_lesson_owned_by(
        created.lesson_id, alice.user_id, "不變", '{"source_code":"same"}'
    )

    assert (result.version, result.changed) == (1, False)
    assert len(_versions_for(created.lesson_id)) == 1


def test_version_read_helpers_expose_history_only_to_the_owner(alice, bob):
    """history API 若只靠路由過濾，日後新增入口就可能把別人的版本洩出來。"""
    assert hasattr(db, "lesson_versions_owned_by")
    created = db.create_lesson_with_version(alice.user_id, "v1", '{"source_code":"one"}')
    db.update_lesson_owned_by(created.lesson_id, alice.user_id, "v2", '{"source_code":"two"}')

    rows = db.lesson_versions_owned_by(created.lesson_id, alice.user_id)
    snapshot = db.lesson_version_owned_by(created.lesson_id, alice.user_id, 2)
    diff = db.lesson_version_diff_owned_by(created.lesson_id, alice.user_id, 2)

    assert [(row["version"], row["parent_version"]) for row in rows] == [(2, 1), (1, None)]
    assert (snapshot["version"], snapshot["title"]) == (2, "v2")
    assert (diff[0]["version"], diff[1]["version"]) == (2, 1)
    assert db.lesson_versions_owned_by(created.lesson_id, bob.user_id) == []
    assert db.lesson_version_owned_by(created.lesson_id, bob.user_id, 2) is None
    assert db.lesson_version_diff_owned_by(created.lesson_id, bob.user_id, 2) is None


# ---------------------------------------------------------------------------
# 3. 刪除
# ---------------------------------------------------------------------------


def test_owner_can_delete_and_it_disappears_from_both_lists(alice):
    lesson_id = _create(alice, title="要刪掉的教案")

    assert "要刪掉的教案" in alice.http.get("/").data.decode("utf-8")
    assert lesson_id in {int(r["id"]) for r in db.lessons_for_user(alice.user_id)}

    assert _delete_lesson(alice, lesson_id).status_code == 200

    assert db.lesson_by_id(lesson_id) is None
    assert lesson_id not in {int(r["id"]) for r in db.lessons_for_user(alice.user_id)}
    library = alice.http.get("/").data.decode("utf-8")
    assert "要刪掉的教案" not in library
    profile = alice.http.get(f"/u/{alice.username}").data.decode("utf-8")
    assert "要刪掉的教案" not in profile


def test_a_non_owner_cannot_delete(alice, bob):
    lesson_id = _create(bob, title="bob 的教案")

    response = _delete_lesson(alice, lesson_id)
    assert response.status_code == 404
    assert db.lesson_by_id(lesson_id) is not None
    assert db.delete_lesson_owned_by(lesson_id, alice.user_id) is False
    assert db.lesson_by_id(lesson_id) is not None


def test_deleting_a_missing_lesson_looks_the_same_as_deleting_someone_elses(alice, bob):
    """兩者同形，否則這條路由就是一台「哪些 id 有主人」的探測機。"""
    lesson_id = _create(bob)
    theirs = _delete_lesson(alice, lesson_id)
    missing = _delete_lesson(alice, 99999999)
    assert theirs.status_code == missing.status_code == 404
    assert theirs.get_json() == missing.get_json()


# ---------------------------------------------------------------------------
# 4. 讀取：任何登入者
# ---------------------------------------------------------------------------


def test_any_logged_in_user_can_read_any_lesson(alice, bob):
    lesson_id = _create(bob, title="bob 的教案", bundle=_bundle("// bob"))

    response = alice.http.get(f"/api/lessons/{lesson_id}")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["title"] == "bob 的教案"
    assert payload["bundle"]["source_code"] == "// bob"
    assert payload["author_username"] == bob.username
    assert payload["is_mine"] is False

    assert bob.http.get(f"/api/lessons/{lesson_id}").get_json()["is_mine"] is True


def test_saving_makes_a_lesson_appear_on_the_profile_and_in_the_library(alice):
    _create(alice, title="出現在兩邊的教案")

    profile = alice.http.get(f"/u/{alice.username}").data.decode("utf-8")
    assert "出現在兩邊的教案" in profile

    library = alice.http.get("/").data.decode("utf-8")
    assert "出現在兩邊的教案" in library
    assert alice.username in library  # 作者連結 /u/<username>


# ---------------------------------------------------------------------------
# 5. 分頁邊界（25 篇）
# ---------------------------------------------------------------------------


def _library_ids(client, page):
    """從教案庫頁抓出這一頁的 lesson id。"""
    import re

    html = client.get(f"/?page={page}").data.decode("utf-8")
    return [int(m) for m in re.findall(r"\?lesson=(\d+)", html)]


def test_pagination_has_no_overlap_and_no_gap_across_25_lessons(alice):
    created = [_create(alice, title=f"分頁測試 {i:02d}") for i in range(25)]

    page1 = _library_ids(alice.http, 1)
    page2 = _library_ids(alice.http, 2)
    page3 = _library_ids(alice.http, 3)

    assert len(page1) == db.LESSONS_PER_PAGE
    assert len(page2) == db.LESSONS_PER_PAGE
    # 沒有重疊
    assert not (set(page1) & set(page2))
    assert not (set(page2) & set(page3))
    assert not (set(page1) & set(page3))
    # 沒有遺漏：這 25 篇全部出現在前三頁（其他測試可能也留了教案在庫裡，
    # 所以檢查的是「這 25 篇是不是被涵蓋」而不是總數相等）
    seen = set(page1) | set(page2) | set(page3)
    assert set(created) <= seen, sorted(set(created) - seen)


def test_pages_are_ordered_newest_first(alice):
    first = _create(alice, title="先存的")
    second = _create(alice, title="後存的")
    ids = _library_ids(alice.http, 1)
    assert ids.index(second) < ids.index(first)


def test_an_absurd_page_number_is_clamped(alice):
    _create(alice)
    response = alice.http.get("/?page=99999999999")
    assert response.status_code == 200
    response = alice.http.get("/?page=-5")
    assert response.status_code == 200
    response = alice.http.get("/?page=not-a-number")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# 6. 大小上限
# ---------------------------------------------------------------------------


def test_an_oversized_bundle_is_refused_without_leaking_paths(alice):
    huge = _bundle("x" * (db.MAX_BUNDLE_BYTES + 1000))
    response = _post_lesson(alice, title="太大", bundle=huge)
    assert response.status_code == 413, response.status_code
    message = response.get_json()["message"]
    for leak in ("/var/lib", "/app", "Traceback", "sqlite", ".py"):
        assert leak not in message
    # 沒有半份被寫進去
    assert not any(r["title"] == "太大" for r in db.lessons_for_user(alice.user_id))


def test_an_oversized_title_is_refused(alice):
    response = _post_lesson(alice, title="標" * (db.MAX_TITLE_LENGTH + 1))
    assert response.status_code == 400
    assert not db.lessons_for_user(alice.user_id)


def test_an_empty_title_is_refused(alice):
    assert _post_lesson(alice, title="   ").status_code == 400


def test_the_storage_layer_refuses_oversized_input_on_its_own(alice):
    """路由層以外的呼叫端也擋得住——上限是儲存層的契約，不只是一段路由檢查。"""
    with pytest.raises(db.LessonRejected):
        db.create_lesson(alice.user_id, "t", "x" * (db.MAX_BUNDLE_BYTES + 1))
    with pytest.raises(db.LessonRejected):
        db.create_lesson(alice.user_id, "t" * (db.MAX_TITLE_LENGTH + 1), "{}")
    with pytest.raises(db.LessonRejected):
        db.create_lesson(0, "t", "{}")
    with pytest.raises(db.LessonRejected):
        db.create_lesson(True, "t", "{}")


def test_a_body_without_content_length_is_refused(flask_app):
    """沒宣告長度就沒辦法在讀進來之前知道它多大，所以一律拒絕。

    直接測 _lesson_payload 的那條分支：werkzeug 的 test client 一定會補上
    CONTENT_LENGTH，用它送不出「沒有長度」的請求。
    """
    from flask import request

    from gdbgui.server import http_routes

    with flask_app.test_request_context(
        "/api/lessons",
        method="POST",
        data=json.dumps({"title": "x", "bundle": _bundle()}),
        content_type="application/json",
    ):
        # 這是 chunked 傳輸的形狀：body 有內容，但沒有宣告長度。
        request.environ.pop("CONTENT_LENGTH", None)
        assert request.content_length is None
        fields, error = http_routes._lesson_payload()

    assert fields is None
    assert error[1] == 413


def test_a_body_larger_than_the_request_cap_never_reaches_the_json_parser(alice):
    """超過請求上限的 body 在 json.loads 之前就被擋掉。"""
    oversized = _bundle("x" * (http_request_cap() + 1000))
    response = _post_lesson(alice, title="超大請求", bundle=oversized)
    assert response.status_code == 413
    assert not any(
        r["title"] == "超大請求" for r in db.lessons_for_user(alice.user_id)
    )


def http_request_cap() -> int:
    from gdbgui.server import http_routes

    return http_routes.MAX_LESSON_REQUEST_BYTES


# ---------------------------------------------------------------------------
# 7. XSS：標題與顯示名稱都會渲染進 HTML
# ---------------------------------------------------------------------------

_XSS = "<script>alert(1)</script>"


def test_a_script_tag_in_a_title_renders_as_text_on_both_pages(flask_app):
    user = register_user(flask_app, display_name=_XSS)
    _create(user, title=_XSS)

    for path in ("/", f"/u/{user.username}"):
        html = user.http.get(path).data.decode("utf-8")
        assert _XSS not in html, f"{path} rendered the title unescaped"
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html, path

    # 顯示名稱也走同一條路（教案庫頁的作者欄）
    library = user.http.get("/").data.decode("utf-8")
    assert library.count("&lt;script&gt;") >= 2


def test_a_title_with_control_characters_is_refused(alice):
    assert _post_lesson(alice, title="壞\x00標題").status_code == 400
    assert _post_lesson(alice, title="壞\n標題").status_code == 400


# ---------------------------------------------------------------------------
# 8. 未登入 / CSRF
# ---------------------------------------------------------------------------


def test_the_new_routes_are_covered_by_the_site_wide_login_gate(flask_app):
    """route-enumeration 那條測試（test_route_gate）是從 url_map 生成的，
    所以會自動涵蓋這幾條。這裡再明確釘一次，因為它們是這個切片的全部入口。"""
    from gdbgui.server.http_util import PUBLIC_ENDPOINTS

    endpoints = {
        rule.endpoint
        for rule in flask_app.url_map.iter_rules()
        if rule.rule.startswith("/api/lessons") or rule.rule in ("/", "/lessons")
    }
    assert endpoints >= {
        "http_routes.create_lesson",
        "http_routes.update_lesson",
        "http_routes.delete_lesson",
        "http_routes.get_lesson",
        "http_routes.lesson_library",
        "http_routes.lesson_library_legacy",
    }, endpoints
    assert not (endpoints & PUBLIC_ENDPOINTS)


def test_an_anonymous_visitor_is_refused_by_every_lesson_route(flask_app, alice):
    lesson_id = _create(alice)

    client = flask_app.test_client()
    assert client.get("/login").status_code == 200
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    calls = [
        ("POST", "/api/lessons"),
        ("PUT", f"/api/lessons/{lesson_id}"),
        ("DELETE", f"/api/lessons/{lesson_id}"),
        ("GET", f"/api/lessons/{lesson_id}"),
        ("GET", "/lessons"),
    ]
    for method, url in calls:
        response = client.open(
            url,
            method=method,
            data=json.dumps({"title": "x", "bundle": _bundle()}),
            content_type="application/json",
            headers={"x-csrftoken": csrf},
        )
        refused = response.status_code == 401 or (
            response.status_code in (302, 303)
            and "/login" in response.headers.get("Location", "")
        )
        assert refused, f"{method} {url} -> {response.status_code}"

    # 而且那些請求什麼都沒改到。
    assert db.lesson_by_id(lesson_id) is not None


def test_a_delete_without_a_csrf_token_is_refused(alice):
    """DELETE 也是狀態變更，必須走同一道 CSRF 檢查。"""
    lesson_id = _create(alice)
    response = alice.http.delete(f"/api/lessons/{lesson_id}")
    assert response.status_code == 403
    assert db.lesson_by_id(lesson_id) is not None


def test_a_post_without_a_csrf_token_is_refused(alice):
    response = alice.http.post(
        "/api/lessons",
        data=json.dumps({"title": "x", "bundle": _bundle()}),
        content_type="application/json",
    )
    assert response.status_code == 403
