"""Authenticated live-quiz rooms and complete snapshot reconnects."""

import json
from urllib.parse import urlsplit

import pytest

from gdbgui.server import db
from .conftest import register_user
from .test_live_quiz_api import _create, _guest_join
from .test_live_quiz_db import valid_bundle


@pytest.fixture
def quiz_socketio(flask_app):
    from gdbgui.server.app import socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=flask_app, socketio=socketio)
    return socketio


@pytest.fixture
def socket_context(flask_app, quiz_socketio):
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="Socket Author")
    other = register_user(flask_app, display_name="Socket Other")
    lesson_id = db.create_lesson(
        author.user_id, "Socket 課堂", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    created = _create(author, lesson_id)
    assert created.status_code == 201
    return flask_app, quiz_socketio, author, other, created.get_json()


def _events(client):
    return client.get_received("/lesson_quiz")


def _join_token(created):
    return urlsplit(created["join_url"]).path.rsplit("/", 1)[-1]


def _event(client, name):
    return [packet["args"][0] for packet in _events(client) if packet["name"] == name]


def test_teacher_socket_requires_session_owner_and_sends_complete_state(socket_context):
    app, socketio, author, other, created = socket_context
    auth = {"role": "teacher", "session_id": created["id"]}
    owner_socket = socketio.test_client(
        app, namespace="/lesson_quiz", flask_test_client=author.http, auth=auth
    )
    denied_socket = socketio.test_client(
        app, namespace="/lesson_quiz", flask_test_client=other.http, auth=auth
    )

    assert owner_socket.is_connected("/lesson_quiz")
    assert not denied_socket.is_connected("/lesson_quiz")
    states = _event(owner_socket, "quiz:teacher-state")
    assert states[-1]["id"] == created["id"]
    assert states[-1]["title"] == "Socket 課堂"

    owner_socket.disconnect(namespace="/lesson_quiz")


def test_student_socket_ignores_client_identity_and_reconnects_to_closed_result(
    socket_context,
):
    app, socketio, author, _, created = socket_context
    guest, joined = _guest_join(app, _join_token(created))
    assert joined.status_code == 200
    session_id = created["id"]
    author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/trigger",
        json={"source_file": "main.cpp", "line": 3},
        headers={"x-csrftoken": author.csrf},
    )
    guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "option_id": "b"},
        headers={"Origin": "http://localhost"},
    )
    author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/close",
        headers={"x-csrftoken": author.csrf},
    )

    student = socketio.test_client(
        app,
        namespace="/lesson_quiz",
        flask_test_client=guest,
        auth={"role": "student", "session_id": 999999, "participant_id": 999999},
    )
    assert student.is_connected("/lesson_quiz")
    state = _event(student, "quiz:student-state")[-1]
    assert state["session_id"] == session_id
    assert state["active_question"]["result"] == {
        "is_correct": True,
        "correct_option_id": "b",
        "explanation": "i++ 會遞增。",
    }
    student.disconnect(namespace="/lesson_quiz")


def test_committed_mutations_push_stats_without_leaking_open_answer(socket_context):
    app, socketio, author, _, created = socket_context
    guest, joined = _guest_join(app, _join_token(created))
    assert joined.status_code == 200
    session_id = created["id"]
    teacher = socketio.test_client(
        app,
        namespace="/lesson_quiz",
        flask_test_client=author.http,
        auth={"role": "teacher", "session_id": session_id},
    )
    student = socketio.test_client(
        app, namespace="/lesson_quiz", flask_test_client=guest, auth={"role": "student"}
    )
    _events(teacher)
    _events(student)

    triggered = author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/trigger",
        json={"source_file": "main.cpp", "line": 3},
        headers={"x-csrftoken": author.csrf},
    )
    assert triggered.status_code == 200
    open_state = _event(student, "quiz:student-state")[-1]
    serialized = json.dumps(open_state, ensure_ascii=False)
    assert "correct_option_id" not in serialized
    assert "explanation" not in serialized
    assert "is_correct" not in serialized

    answered = guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "option_id": "b"},
        headers={"Origin": "http://localhost"},
    )
    assert answered.status_code == 200
    stats = _event(teacher, "quiz:stats")[-1]
    assert stats["question_id"] == "q1"
    assert stats["answer_count"] == 1

    closed = author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/close",
        headers={"x-csrftoken": author.csrf},
    )
    assert closed.status_code == 200
    closed_state = _event(student, "quiz:student-state")[-1]
    assert closed_state["active_question"]["result"]["is_correct"] is True

    teacher.disconnect(namespace="/lesson_quiz")
    student.disconnect(namespace="/lesson_quiz")


def test_ending_session_pushes_ended_state_and_denies_reconnect(socket_context):
    app, socketio, author, _, created = socket_context
    guest, joined = _guest_join(app, _join_token(created))
    assert joined.status_code == 200
    student = socketio.test_client(
        app, namespace="/lesson_quiz", flask_test_client=guest, auth={"role": "student"}
    )
    _events(student)

    ended = author.http.post(
        f"/api/live-quiz/sessions/{created['id']}/end",
        headers={"x-csrftoken": author.csrf},
    )
    assert ended.status_code == 200
    assert _event(student, "quiz:student-state")[-1] == {"state": "ended"}
    student.disconnect(namespace="/lesson_quiz")

    reconnect = socketio.test_client(
        app, namespace="/lesson_quiz", flask_test_client=guest, auth={"role": "student"}
    )
    assert not reconnect.is_connected("/lesson_quiz")
