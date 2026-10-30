"""HTTP security boundary for teacher and anonymous live-quiz clients."""

import json
from contextlib import closing
from time import sleep
from urllib.parse import urlsplit

import pytest

from gdbgui.server import db, live_quiz
from gdbgui.server.http_util import CSRF_EXEMPT_ENDPOINTS, PUBLIC_ENDPOINTS
from .conftest import register_user
from .test_live_quiz_db import credential_hash, seed_legacy_participant, valid_bundle


@pytest.fixture
def api_context(flask_app):
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="API Author")
    other = register_user(flask_app, display_name="API Other")
    lesson_id = db.create_lesson(
        author.user_id, "即時課堂", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    return flask_app, author, other, lesson_id


def _create(author, lesson_id):
    return author.http.post(
        "/api/live-quiz/sessions",
        json={"lesson_id": lesson_id},
        headers={"x-csrftoken": author.csrf},
    )


def _join_token(created):
    return urlsplit(created.get_json()["join_url"]).path.rsplit("/", 1)[-1]


def test_teacher_routes_require_owner_and_csrf(api_context):
    _, author, other, lesson_id = api_context
    created = _create(author, lesson_id)
    assert created.status_code == 201
    session_id = created.get_json()["id"]
    end_path = f"/api/live-quiz/sessions/{session_id}/end"
    assert other.http.post(end_path, headers={"x-csrftoken": other.csrf}).status_code == 404
    assert author.http.post(end_path).status_code == 403
    assert live_quiz._invitation_row(session_id)["state"] == "lobby"


def test_cross_origin_teacher_posts_are_rejected_even_with_a_valid_token(api_context):
    """取代已刪除的訪客 POST 跨來源測試：全域同源檢查對留下來的課堂寫入路由照樣生效。"""
    _, author, _, lesson_id = api_context
    evil = {"x-csrftoken": author.csrf, "Origin": "http://evil.example"}
    with closing(db.connect()) as conn:
        before = conn.execute("SELECT COUNT(*) FROM live_quiz_sessions").fetchone()[0]
    crossed = author.http.post("/api/live-quiz/sessions", json={"lesson_id": lesson_id}, headers=evil)
    assert crossed.status_code == 403
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM live_quiz_sessions").fetchone()[0] == before

    session_id = _create(author, lesson_id).get_json()["id"]
    end_path = f"/api/live-quiz/sessions/{session_id}/end"
    assert author.http.post(end_path, headers=evil).status_code == 403
    assert live_quiz._invitation_row(session_id)["state"] == "lobby"


def test_public_and_csrf_exempt_endpoint_lists_are_exact():
    assert PUBLIC_ENDPOINTS == frozenset(
        {
            "auth.login",
            "auth.register",
            "auth.logout",
            "static",
            "live_quiz.join_page",
        }
    )
    assert CSRF_EXEMPT_ENDPOINTS == frozenset()


REMOVED_ENDPOINTS = frozenset(
    {
        "live_quiz.teacher_state",
        "live_quiz.trigger_question_route",
        "live_quiz.close_question_route",
        "live_quiz.question_responses_route",
        "live_quiz.export_session_route",
        "live_quiz.guest_join",
        "live_quiz.guest_state_route",
        "live_quiz.guest_answer",
    }
)


def test_removed_guest_routes_return_404(api_context):
    """D5：舊的伺服器端計分與訪客 HTTP API 整組移除，不與中繼並存。

    已登入且帶 CSRF token 的擁有者打這些路徑一律 404（路由不存在）；未登入的人
    落回全站預設拒絕（GET 401、POST 403），不再有任何公開或免 CSRF 的課堂 API。
    """
    app, author, _, lesson_id = api_context
    created = _create(author, lesson_id)
    assert created.status_code == 201
    session_id = created.get_json()["id"]
    token = _join_token(created)
    csrf = {"x-csrftoken": author.csrf}

    removed = [
        ("POST", "/api/live-quiz/guest/join", {"token": token, "nickname": "小明"}),
        ("GET", "/api/live-quiz/guest/state", None),
        ("POST", "/api/live-quiz/guest/answers", {"question_id": "q1", "option_id": "b"}),
        ("GET", f"/api/live-quiz/sessions/{session_id}", None),
        ("GET", f"/api/live-quiz/sessions/{session_id}/export", None),
        (
            "POST",
            f"/api/live-quiz/sessions/{session_id}/questions/q1/trigger",
            {"source_file": "main.cpp", "line": 3},
        ),
        ("POST", f"/api/live-quiz/sessions/{session_id}/questions/q1/close", None),
        ("GET", f"/api/live-quiz/sessions/{session_id}/questions/q1/responses", None),
    ]
    anonymous = app.test_client()
    for method, path, body in removed:
        response = author.http.open(path, method=method, json=body, headers=csrf)
        assert response.status_code == 404, (method, path, response.status_code)
        denied = anonymous.open(
            path, method=method, json=body, headers={"Origin": "http://localhost"}
        )
        assert denied.status_code == (401 if method == "GET" else 403), (method, path)

    registered = {rule.endpoint for rule in app.url_map.iter_rules()}
    assert not registered & REMOVED_ENDPOINTS
    assert not {name for name in CSRF_EXEMPT_ENDPOINTS if name.startswith("live_quiz.guest_")}
    assert not {name for name in PUBLIC_ENDPOINTS if name.startswith("live_quiz.guest_")}
    # 沒有任何人 join 過：舊路徑不可能在被拒絕前寫進參與者。
    with closing(db.connect()) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?", (session_id,)
        ).fetchone()[0] == 0


def test_kept_live_quiz_endpoints_are_exactly_the_relay_flow(flask_app):
    """刪除之後，live_quiz blueprint 只剩建立、收場、匯出總覽、QR 與加入頁。"""
    registered = {
        rule.endpoint
        for rule in flask_app.url_map.iter_rules()
        if rule.endpoint.startswith("live_quiz.")
    }
    assert registered == {
        "live_quiz.create_session_route",
        "live_quiz.end_session_route",
        "live_quiz.export_summary_route",
        "live_quiz.qr_image",
        "live_quiz.join_page",
    }


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "localhost:5000",
        "http://localhost:5000",
        "http://127.0.0.1:5000",
        "http://0.0.0.0:5000",
        "http://[::1]:5000",
        "http://10.0.0.2:notaport",
        "ftp://10.0.0.2/x",
        "http://10.0.0.2:5000/base",
        "http://10.0.0.2/x?q=1",
        "http://user:pass@10.0.0.2:5000",
    ],
)
def test_mobile_base_url_rejects_unreachable_or_unsafe_values(bad):
    with pytest.raises(live_quiz.QuizRejected):
        live_quiz.validated_mobile_base_url(bad)


def test_invalid_mobile_url_does_not_create_a_session(api_context):
    app, author, _, lesson_id = api_context
    with closing(db.connect()) as conn:
        before = conn.execute("SELECT COUNT(*) FROM live_quiz_sessions").fetchone()[0]
    app.config["MOBILE_JOIN_BASE_URL"] = "http://localhost:5000"
    assert _create(author, lesson_id).status_code == 400
    with closing(db.connect()) as conn:
        after = conn.execute("SELECT COUNT(*) FROM live_quiz_sessions").fetchone()[0]
    assert after == before


def test_qr_is_owner_only_no_store_svg_and_join_page_contains_no_question(api_context):
    app, author, other, lesson_id = api_context
    created = _create(author, lesson_id)
    payload = created.get_json()
    qr_path = urlsplit(payload["qr_url"]).path
    qr = author.http.get(qr_path)
    assert qr.status_code == 200
    assert qr.mimetype == "image/svg+xml"
    assert qr.headers["Cache-Control"] == "no-store"
    assert b"<path" in qr.data
    assert other.http.get(qr_path).status_code == 404

    anonymous = app.test_client()
    page = anonymous.get(urlsplit(payload["join_url"]).path)
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "即時課堂" in html
    assert "i 是多少" not in html
    assert "correct_option_id" not in html
    assert "source_code" not in html


def test_join_url_and_qr_stay_stable_for_the_session(api_context):
    app, author, _, lesson_id = api_context
    created = _create(author, lesson_id).get_json()
    qr_path = urlsplit(created["qr_url"]).path
    first_qr = author.http.get(qr_path).data
    sleep(1.1)
    second_qr = author.http.get(qr_path).data
    with app.test_request_context():
        reissued = live_quiz.make_join_token(live_quiz._invitation_row(created["id"]))

    assert second_qr == first_qr
    assert urlsplit(created["join_url"]).path.rsplit("/", 1)[-1] == reissued


def test_tampered_nonce_and_ended_session_tokens_fail_closed(api_context):
    app, author, _, lesson_id = api_context
    created = _create(author, lesson_id)
    session_id = created.get_json()["id"]
    token = _join_token(created)
    anonymous = app.test_client()
    assert anonymous.get(f"/join/{token}x").status_code == 404

    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_sessions SET join_nonce='changed' WHERE id=?", (session_id,)
        )
        conn.commit()
    assert anonymous.get(f"/join/{token}").status_code == 404

    newer = _create(author, lesson_id)
    newer_id = newer.get_json()["id"]
    newer_token = _join_token(newer)
    ended = author.http.post(
        f"/api/live-quiz/sessions/{newer_id}/end",
        headers={"x-csrftoken": author.csrf},
    )
    assert ended.status_code == 200
    assert anonymous.get(f"/join/{newer_token}").status_code == 404


def test_join_token_expires_from_the_session_creation_time(api_context):
    app, author, _, lesson_id = api_context
    response = _create(author, lesson_id)
    created = response.get_json()
    token = _join_token(response)
    assert live_quiz.JOIN_TOKEN_MAX_AGE == 8 * 60 * 60
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_sessions SET created_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (created["id"],),
        )
        conn.commit()

    assert app.test_client().get(f"/join/{token}").status_code == 404


def test_export_summary_is_anonymous_and_owner_scoped(api_context):
    """總覽只給擁有者、只含開過題的課堂，且不含暱稱與逐筆作答。

    舊場次（D5 之前）在 lobby 期間資料庫裡可能同時有聚合與暱稱；總覽完全不讀
    participants／responses，所以即使那些列還在，也不會出現在輸出裡。
    """
    _, author, other, lesson_id = api_context
    created = _create(author, lesson_id)
    session_id = created.get_json()["id"]
    _create(author, lesson_id)  # 只建立、沒出題：不該出現
    seed_legacy_participant(session_id, "3081", credential_hash("summary-3081"), "q1")
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_questions SET state='open', opened_at=?, answer_count=1, "
            "correct_count=1, option_counts_json='{\"a\":0,\"b\":1}' "
            "WHERE session_id=? AND question_key='q1'",
            (db._now(), session_id),
        )
        conn.commit()

    body = author.http.get("/api/live-quiz/export")
    assert body.status_code == 200
    assert "attachment" in body.headers["Content-Disposition"]
    data = body.get_json()
    assert [s["session_id"] for s in data["sessions"]] == [session_id]
    assert data["sessions"][0]["questions"][0]["answer_count"] == 1
    assert data["sessions"][0]["questions"][0]["option_counts"] == {"a": 0, "b": 1}
    assert "3081" not in body.get_data(as_text=True)
    assert other.http.get("/api/live-quiz/export").get_json()["sessions"] == []
