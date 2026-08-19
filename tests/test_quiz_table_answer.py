"""逐格判定、熱區聚合，以及學生拿得到／拿不到什麼。"""

import json
from contextlib import closing

import pytest

from gdbgui.server import db, live_quiz
from gdbgui.server.live_quiz import QuizRejected
from .conftest import register_user
from .test_live_quiz_api import _guest_join
from .test_live_quiz_db import credential_hash, valid_bundle
from .test_live_quiz_socket import _event, quiz_socketio
from .test_quiz_table_trigger import SOURCE, _table_question


def test_grading_is_per_cell():
    correct = [["0", "1"], ["2", "3"]]
    answer = [["0", "9"], ["2", "3"]]
    assert live_quiz.grade_table(answer, correct) == (3, 4)


def test_blank_cell_counts_as_wrong():
    assert live_quiz.grade_table([["", "1"]], [["0", "1"]]) == (1, 2)


def test_whitespace_is_trimmed_before_comparing():
    assert live_quiz.grade_table([[" 42 "]], [["42"]]) == (1, 1)


def test_values_are_never_coerced_to_numbers():
    assert live_quiz.grade_table([["0042"]], [["42"]]) == (0, 1)


def test_cell_stats_accumulate_wrong_answers():
    correct = [["0", "1"], ["2", "3"]]
    stats = [0, 0, 0, 0]
    live_quiz.accumulate_cell_stats(stats, [["0", "9"], ["2", "3"]], correct)
    live_quiz.accumulate_cell_stats(stats, [["7", "9"], ["2", "3"]], correct)
    assert stats == [1, 2, 0, 0]


def _table_row(state="open"):
    return {
        "question_key": "t1",
        "kind": "table",
        "prompt": "p",
        "explanation": "e",
        "source_file": "a.cpp",
        "trigger_line": 3,
        "trigger_anchor_json": json.dumps({}),
        "position": 0,
        "state": state,
        "opened_at": "now",
        "closed_at": "later" if state == "closed" else None,
        "table_spec_json": json.dumps({"var_hint": "dp", "max_cells": 200}),
        "correct_table_json": json.dumps(
            {
                "rows": 1,
                "cols": 1,
                "row_labels": ["0"],
                "col_labels": ["0"],
                "values": [["42"]],
            }
        ),
        "cell_stats_json": json.dumps([1]),
        "options_json": None,
        "correct_option_id": None,
        "option_counts_json": None,
        "answer_count": 1,
        "correct_count": 0,
    }


def test_open_question_payload_hides_the_answer():
    payload = live_quiz.student_question_payload(_table_row())
    assert "42" not in json.dumps(payload, ensure_ascii=False)
    assert payload["rows"] == 1 and payload["cols"] == 1


def test_closed_question_payload_reveals_the_answer():
    payload = live_quiz.student_question_payload(_table_row("closed"))
    assert payload["correct_values"] == [["42"]]


def test_teacher_table_payload_includes_heatmap_dimensions_and_stats():
    payload = live_quiz._question_payload(_table_row())
    assert {
        "rows": 1,
        "cols": 1,
        "row_labels": ["0"],
        "col_labels": ["0"],
        "cell_stats": [1],
    }.items() <= payload.items()


@pytest.fixture
def table_session(flask_app):
    owner = register_user(flask_app, display_name="Table Answer Owner")
    bundle = {
        "version": "2.0",
        "fullname_to_render": "a.cpp",
        "source_code": SOURCE,
        "breakpoints": [],
        "program_input": "",
        "quiz": {"schema_version": 1, "questions": [_table_question()]},
    }
    lesson_id = db.create_lesson(
        owner.user_id, "填表題", json.dumps(bundle, ensure_ascii=False)
    )
    session = live_quiz.create_session(owner.user_id, lesson_id)
    correct = {
        "rows": 2,
        "cols": 2,
        "row_labels": ["0", "1"],
        "col_labels": ["0", "1"],
        "values": [["0", "1"], ["2", "3"]],
    }
    live_quiz.trigger_question(
        session["id"], owner.user_id, "t1", "a.cpp", 3, table=correct
    )
    return owner, session, correct


def test_two_table_answers_accumulate_retry_and_survive_end(table_session):
    owner, session, _ = table_session
    first_hash = credential_hash("table-first")
    second_hash = credential_hash("table-second")
    third_hash = credential_hash("table-invalid")
    for nickname, value in (
        ("小明", first_hash),
        ("小華", second_hash),
        ("小安", third_hash),
    ):
        live_quiz.join_session(session["id"], nickname, value)

    long_cell = "x" * 40
    first = live_quiz.answer_table_question(
        first_hash, "t1", [["0", long_cell], ["2", "3"]]
    )
    second = live_quiz.answer_table_question(
        second_hash, "t1", [["7", "9"], ["2", "3"]]
    )
    retry = live_quiz.answer_table_question(
        first_hash, "t1", [["9", "9"], ["9", "9"]]
    )

    assert (first["correct_cells"], second["correct_cells"]) == (3, 2)
    assert retry == {
        "inserted": False,
        "correct_cells": 3,
        "total_cells": 4,
        "stats": {
            "answer_count": 2,
            "correct_count": 0,
            "cell_stats": [1, 2, 0, 0],
        },
    }
    with pytest.raises(QuizRejected, match="維度"):
        live_quiz.answer_table_question(third_hash, "t1", [["0"]])
    with pytest.raises(QuizRejected, match="字串"):
        live_quiz.answer_table_question(third_hash, "t1", [[0, "1"], ["2", "3"]])
    with pytest.raises(QuizRejected, match="題型"):
        live_quiz.answer_question(third_hash, "t1", "a")

    with closing(db.connect()) as conn:
        stored = conn.execute(
            "SELECT answer_json FROM live_quiz_responses r "
            "JOIN live_quiz_participants p ON p.id=r.participant_id "
            "WHERE p.credential_hash=?",
            (first_hash,),
        ).fetchone()[0]
    assert json.loads(stored)[0][1] == "x" * live_quiz.MAX_CELL_LENGTH

    ended = live_quiz.end_session(session["id"], owner.user_id)
    question = ended["questions"][0]
    assert question["cell_stats"] == [1, 2, 0, 0]
    assert question["answer_count"] == 2
    with closing(db.connect()) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_responses r "
            "JOIN live_quiz_questions q ON q.id=r.question_id WHERE q.session_id=?",
            (session["id"],),
        ).fetchone()[0] == 0


def test_student_state_only_shows_own_table_answer_and_closed_correct_values(
    table_session,
):
    owner, session, correct = table_session
    first_hash = credential_hash("visible-first")
    second_hash = credential_hash("visible-second")
    live_quiz.join_session(session["id"], "小明", first_hash)
    live_quiz.join_session(session["id"], "小華", second_hash)
    own_answer = [["mine", "1"], ["2", "3"]]
    live_quiz.answer_table_question(first_hash, "t1", own_answer)

    first_open = live_quiz.guest_state(first_hash)["active_question"]
    second_open = live_quiz.guest_state(second_hash)["active_question"]
    assert first_open["answer"] == own_answer
    assert "correct_values" not in first_open
    assert second_open["answer"] is None
    assert "mine" not in json.dumps(second_open, ensure_ascii=False)

    live_quiz.close_question(session["id"], owner.user_id, "t1")
    first_closed = live_quiz.guest_state(first_hash)["active_question"]
    second_closed = live_quiz.guest_state(second_hash)["active_question"]
    assert first_closed["correct_values"] == correct["values"]
    assert first_closed["answer"] == own_answer
    assert first_closed["result"] == {
        "correct_cells": 3,
        "total_cells": 4,
        "explanation": "",
    }
    assert second_closed["answer"] is None
    assert "mine" not in json.dumps(second_closed, ensure_ascii=False)


def _http_guest(app, session_id, nickname):
    with app.app_context():
        token = live_quiz.make_join_token(live_quiz._invitation_row(session_id))
    guest, joined = _guest_join(app, token, nickname)
    assert joined.status_code == 200
    return guest


def test_answer_http_shapes_dispatch_table_and_keep_choice_compatible(
    flask_app, table_session
):
    _, table, _ = table_session
    table_guest = _http_guest(flask_app, table["id"], "填表學生")
    answer = [["0", "1"], ["2", "3"]]
    accepted = table_guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1", "answer": answer},
        headers={"Origin": "http://localhost"},
    )
    assert accepted.status_code == 200
    assert accepted.get_json()["active_question"]["answer"] == answer

    ambiguous = _http_guest(flask_app, table["id"], "歧義學生").post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1", "answer": answer, "option_id": "a"},
        headers={"Origin": "http://localhost"},
    )
    missing = _http_guest(flask_app, table["id"], "缺答案學生").post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1"},
        headers={"Origin": "http://localhost"},
    )
    wrong_table_shape = _http_guest(flask_app, table["id"], "錯形狀學生").post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1", "option_id": "a"},
        headers={"Origin": "http://localhost"},
    )
    assert (ambiguous.status_code, missing.status_code, wrong_table_shape.status_code) == (
        400,
        400,
        400,
    )

    owner = register_user(flask_app, display_name="Choice Answer Owner")
    lesson_id = db.create_lesson(
        owner.user_id, "單選題", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    choice = live_quiz.create_session(owner.user_id, lesson_id)
    live_quiz.trigger_question(choice["id"], owner.user_id, "q1", "main.cpp", 3)
    choice_guest = _http_guest(flask_app, choice["id"], "單選學生")
    compatible = choice_guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "option_id": "b"},
        headers={"Origin": "http://localhost"},
    )
    wrong_choice_shape = _http_guest(flask_app, choice["id"], "單選錯形狀").post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "q1", "answer": [["b"]]},
        headers={"Origin": "http://localhost"},
    )
    assert compatible.status_code == 200
    assert compatible.get_json()["active_question"]["selected_option_id"] == "b"
    assert wrong_choice_shape.status_code == 400


def test_teacher_socket_table_stats_use_cell_stats(
    flask_app, quiz_socketio, table_session
):
    owner, session, _ = table_session
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    teacher = quiz_socketio.test_client(
        flask_app,
        namespace="/lesson_quiz",
        flask_test_client=owner.http,
        auth={"role": "teacher", "session_id": session["id"]},
    )
    assert teacher.is_connected("/lesson_quiz")
    initial = _event(teacher, "quiz:stats")[-1]
    assert initial["cell_stats"] == [0, 0, 0, 0]
    assert "option_counts" not in initial

    guest = _http_guest(flask_app, session["id"], "Socket 填表學生")
    answered = guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1", "answer": [["9", "1"], ["2", "3"]]},
        headers={"Origin": "http://localhost"},
    )
    assert answered.status_code == 200
    updated = _event(teacher, "quiz:stats")[-1]
    assert updated["answer_count"] == 1
    assert updated["cell_stats"] == [1, 0, 0, 0]
    assert "option_counts" not in updated
    teacher.disconnect(namespace="/lesson_quiz")
