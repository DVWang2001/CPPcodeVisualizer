"""HTTP security boundary for teacher and anonymous live-quiz clients."""

import json
from contextlib import closing
from hashlib import sha256
from time import sleep
from urllib.parse import urlsplit

import pytest

from gdbgui.server import db, live_quiz
from gdbgui.server.http_util import CSRF_EXEMPT_ENDPOINTS, PUBLIC_ENDPOINTS
from .conftest import register_user
from .test_live_quiz_db import valid_bundle


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


def _guest_join(app, token, nickname="小明"):
    guest = app.test_client()
    response = guest.post(
        "/api/live-quiz/guest/join",
        json={"token": token, "nickname": nickname},
        headers={"Origin": "http://localhost"},
    )
    return guest, response


def test_teacher_routes_require_owner_and_csrf(api_context):
    _, author, other, lesson_id = api_context
    created = _create(author, lesson_id)
    assert created.status_code == 201
    session_id = created.get_json()["id"]
    assert other.http.get(f"/api/live-quiz/sessions/{session_id}").status_code == 404
    assert author.http.post(f"/api/live-quiz/sessions/{session_id}/end").status_code == 403


def test_public_and_csrf_exempt_endpoint_lists_are_exact():
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
    _, author, _, lesson_id = api_context
    created = _create(author, lesson_id).get_json()
    session_path = f"/api/live-quiz/sessions/{created['id']}"
    first_qr = author.http.get(urlsplit(created["qr_url"]).path).data
    sleep(1.1)
    second = author.http.get(session_path).get_json()
    second_qr = author.http.get(urlsplit(second["qr_url"]).path).data

    assert second["join_url"] == created["join_url"]
    assert second_qr == first_qr


def test_guest_join_sets_http_only_cookie_and_database_keeps_only_its_hash(api_context):
    app, author, _, lesson_id = api_context
    created = _create(author, lesson_id)
    session_id = created.get_json()["id"]
    token = _join_token(created)
    guest, joined = _guest_join(app, token)
    assert joined.status_code == 200
    cookie = guest.get_cookie("gdbgui_quiz_guest")
    assert cookie is not None
    assert cookie.http_only is True
    assert cookie.same_site == "Lax"
    assert "Max-Age=28800" in joined.headers["Set-Cookie"]
    with closing(db.connect()) as conn:
        stored = conn.execute(
            "SELECT credential_hash FROM live_quiz_participants WHERE session_id=?",
            (session_id,),
        ).fetchone()[0]
    assert stored == sha256(cookie.value.encode("utf-8")).hexdigest()
    assert stored != cookie.value


def test_guest_posts_still_reject_cross_origin_and_unknown_identity_fields(api_context):
    app, author, _, lesson_id = api_context
    token = _join_token(_create(author, lesson_id))
    guest = app.test_client()
    crossed = guest.post(
        "/api/live-quiz/guest/join",
        json={"token": token, "nickname": "小明"},
        headers={"Origin": "http://evil.example"},
    )
    assert crossed.status_code == 403
    injected = guest.post(
        "/api/live-quiz/guest/join",
        json={"token": token, "nickname": "小明", "participant_id": 1},
        headers={"Origin": "http://localhost"},
    )
    assert injected.status_code == 400


def test_answer_hides_result_until_teacher_closes_question(api_context):
    app, author, _, lesson_id = api_context
    created = _create(author, lesson_id)
    session_id = created.get_json()["id"]
    token = _join_token(created)
    guest, joined = _guest_join(app, token)
    assert joined.status_code == 200
    triggered = author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/trigger",
        json={"source_file": "main.cpp", "line": 3},
        headers={"x-csrftoken": author.csrf},
    )
    assert triggered.status_code == 200
    answered = guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "option_id": "b"},
        headers={"Origin": "http://localhost"},
    )
    assert answered.status_code == 200
    open_json = json.dumps(answered.get_json(), ensure_ascii=False)
    assert "correct_option_id" not in open_json
    assert "explanation" not in open_json
    assert "is_correct" not in open_json

    closed = author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/close",
        headers={"x-csrftoken": author.csrf},
    )
    assert closed.status_code == 200
    state = guest.get("/api/live-quiz/guest/state")
    assert state.status_code == 200
    assert state.get_json()["active_question"]["result"] == {
        "is_correct": True,
        "correct_option_id": "b",
        "explanation": "i++ 會遞增。",
    }


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
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_sessions SET created_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (created["id"],),
        )
        conn.commit()

    assert app.test_client().get(f"/join/{token}").status_code == 404


@pytest.mark.parametrize("token", [123, {}, []])
def test_guest_join_rejects_non_string_tokens_without_a_server_error(api_context, token):
    app, _, _, _ = api_context
    _, joined = _guest_join(app, token)
    assert joined.status_code == 404


def test_export_captures_responses_that_ending_the_session_destroys(api_context):
    """匯出是研究資料唯一的出口：結束課堂會把逐筆作答刪光。"""
    app, author, other, lesson_id = api_context
    created = _create(author, lesson_id)
    session_id = created.get_json()["id"]
    token = _join_token(created)
    guest, joined = _guest_join(app, token, nickname="3081")
    assert joined.status_code == 200
    assert author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/trigger",
        json={"source_file": "main.cpp", "line": 3},
        headers={"x-csrftoken": author.csrf},
    ).status_code == 200
    assert guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "option_id": "b"},
        headers={"Origin": "http://localhost"},
    ).status_code == 200

    # 別人的課堂拿不到，訪客更不行。
    assert other.http.get(f"/api/live-quiz/sessions/{session_id}/export").status_code == 404
    assert guest.get(f"/api/live-quiz/sessions/{session_id}/export").status_code in (302, 401, 403)

    exported = author.http.get(f"/api/live-quiz/sessions/{session_id}/export")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["Content-Disposition"]
    payload = exported.get_json()
    assert [p["nickname"] for p in payload["participants"]] == ["3081"]
    assert len(payload["responses"]) == 1
    answer = payload["responses"][0]
    assert answer["question_key"] == "q1"
    assert answer["nickname"] == "3081"
    assert answer["selected_option_id"] == "b"
    assert answer["is_correct"] == 1

    assert author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/close",
        headers={"x-csrftoken": author.csrf},
    ).status_code == 200
    assert author.http.post(
        f"/api/live-quiz/sessions/{session_id}/end",
        headers={"x-csrftoken": author.csrf},
    ).status_code == 200

    after = author.http.get(f"/api/live-quiz/sessions/{session_id}/export").get_json()
    assert after["responses"] == []
    assert after["participants"] == []
    # 題目與匿名統計摘要照留，這正是結束課堂該保住的東西。
    assert [q["question_key"] for q in after["questions"]] == ["q1"]
    assert after["questions"][0]["answer_count"] == 1
