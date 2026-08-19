"""填表題的 bundle 驗證與出題捕獲。"""

import json
from contextlib import closing

import pytest

from gdbgui.server import db, live_quiz
from gdbgui.server.live_quiz import QuizRejected, validate_captured_table
from .conftest import register_user

SOURCE = "int main() {\n    int dp[2][2];\n    return 0;\n}\n"


def _bundle(question):
    return {
        "source_code": SOURCE,
        "fullname_to_render": "/tmp/a.cpp",
        "quiz": {"schema_version": 1, "questions": [question]},
    }


def _table_question(**overrides):
    question = {
        "id": "t1",
        "kind": "table",
        "prompt": "填出 dp 的最終內容",
        "explanation": "",
        "table_spec": {"var_hint": "dp", "max_cells": 200},
        "trigger": {
            "kind": "source_line",
            "source_file": "a.cpp",
            "line": 3,
            "anchor": {"line_text": "return 0;", "before_text": "int dp[2][2];", "after_text": "}"},
        },
    }
    question.update(overrides)
    return question


def _table(rows=2, cols=2, fill="1"):
    return {
        "rows": rows,
        "cols": cols,
        "row_labels": [str(i) for i in range(rows)],
        "col_labels": [str(j) for j in range(cols)],
        "values": [[fill] * cols for _ in range(rows)],
    }


def test_valid_table_is_normalized():
    table = validate_captured_table(_table(), max_cells=200)
    assert table["rows"] == 2 and table["cols"] == 2
    assert table["values"] == [["1", "1"], ["1", "1"]]


def test_ragged_table_is_rejected():
    """各列長度不一必須拒絕。自動補齊等於偽造正解。"""
    raw = _table()
    raw["values"][1] = ["1"]
    with pytest.raises(QuizRejected):
        validate_captured_table(raw, max_cells=200)


def test_table_over_max_cells_is_rejected():
    with pytest.raises(QuizRejected):
        validate_captured_table(_table(rows=20, cols=20), max_cells=200)


def test_cell_longer_than_limit_is_rejected():
    raw = _table(fill="x" * 33)
    with pytest.raises(QuizRejected):
        validate_captured_table(raw, max_cells=200)


def test_non_string_cell_is_rejected():
    raw = _table()
    raw["values"][0][0] = 1
    with pytest.raises(QuizRejected):
        validate_captured_table(raw, max_cells=200)


def test_table_question_is_accepted():
    quiz = live_quiz.validate_quiz_bundle(_bundle(_table_question()))
    question = quiz["questions"][0]
    assert question["kind"] == "table"
    assert question["table_spec"] == {"var_hint": "dp", "max_cells": 200}
    assert "options" not in question


def test_choice_question_still_works_without_kind():
    """既有教案沒有 kind 欄位，必須預設為 choice，否則所有舊教案一次全壞。"""
    question = {
        "id": "c1",
        "prompt": "會輸出什麼？",
        "options": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}],
        "correct_option_id": "a",
        "explanation": "",
        "trigger": _table_question()["trigger"],
    }
    quiz = live_quiz.validate_quiz_bundle(_bundle(question))
    assert quiz["questions"][0]["kind"] == "choice"


def test_max_cells_cannot_exceed_the_ceiling():
    with pytest.raises(QuizRejected):
        live_quiz.validate_quiz_bundle(
            _bundle(_table_question(table_spec={"var_hint": "dp", "max_cells": 500}))
        )


def test_table_question_rejects_choice_fields():
    with pytest.raises(QuizRejected):
        live_quiz.validate_quiz_bundle(
            _bundle(_table_question(correct_option_id="a"))
        )


def test_create_session_accepts_a_table_question(flask_app):
    """create_session -> _session_payload 會對每一題無條件 json.loads(options_json)；
    填表題的 options_json 是 NULL，這條路徑之前完全沒被測到，一落地就是開課 500。"""
    owner = register_user(flask_app, display_name="Table Owner")
    bundle = {
        "version": "2.0",
        "fullname_to_render": "a.cpp",
        "source_code": SOURCE,
        "breakpoints": [],
        "program_input": "",
        "quiz": {"schema_version": 1, "questions": [_table_question()]},
    }
    lesson_id = db.create_lesson(
        owner.user_id, "填表題教案", json.dumps(bundle, ensure_ascii=False)
    )
    session = live_quiz.create_session(owner.user_id, lesson_id)
    assert session is not None
    assert session["questions"][0]["kind"] == "table"


def test_trigger_route_captures_table_and_optional_hint(flask_app):
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    owner = register_user(flask_app, display_name="Table Owner")
    bundle = {
        "version": "2.0",
        "fullname_to_render": "a.cpp",
        "source_code": SOURCE,
        "breakpoints": [],
        "program_input": "",
        "quiz": {"schema_version": 1, "questions": [_table_question()]},
    }
    lesson_id = db.create_lesson(
        owner.user_id, "填表題教案", json.dumps(bundle, ensure_ascii=False)
    )
    session = live_quiz.create_session(owner.user_id, lesson_id)

    captured = _table(fill="7")
    response = owner.http.post(
        f"/api/live-quiz/sessions/{session['id']}/questions/t1/trigger",
        json={"source_file": "a.cpp", "line": 3, "table": captured, "var_hint": "memo"},
        headers={"x-csrftoken": owner.csrf},
    )

    assert response.status_code == 200, response.get_json()
    assert response.get_json()["questions"][0]["table_spec"]["var_hint"] == "memo"
    with closing(db.connect()) as conn:
        row = conn.execute(
            "SELECT correct_table_json, cell_stats_json FROM live_quiz_questions "
            "WHERE session_id=? AND question_key='t1'",
            (session["id"],),
        ).fetchone()
    assert json.loads(row["correct_table_json"]) == captured
    assert json.loads(row["cell_stats_json"]) == [0, 0, 0, 0]


def test_selected_hint_persists_to_the_next_session_without_mutating_pinned_version(flask_app):
    owner = register_user(flask_app, display_name="Persistent Hint Owner")
    bundle = _bundle(_table_question())
    lesson_id = db.create_lesson(
        owner.user_id, "提示持久化", json.dumps(bundle, ensure_ascii=False)
    )
    first = live_quiz.create_session(owner.user_id, lesson_id)

    live_quiz.trigger_question(
        first["id"], owner.user_id, "t1", "a.cpp", 3, _table(), "memo"
    )

    second = live_quiz.create_session(owner.user_id, lesson_id)
    assert second["questions"][0]["table_spec"]["var_hint"] == "memo"
    pinned = db.lesson_version_owned_by(lesson_id, owner.user_id, 1)
    assert json.loads(pinned["bundle_json"])["quiz"]["questions"][0]["table_spec"]["var_hint"] == "dp"


def test_selected_hint_does_not_overwrite_a_concurrent_newer_lesson_version(flask_app):
    owner = register_user(flask_app, display_name="Concurrent Hint Owner")
    original = _bundle(_table_question())
    lesson_id = db.create_lesson(
        owner.user_id, "提示衝突", json.dumps(original, ensure_ascii=False)
    )
    first = live_quiz.create_session(owner.user_id, lesson_id)
    newer = _bundle(_table_question(table_spec={"var_hint": "newer", "max_cells": 200}))
    db.update_lesson_owned_by(
        lesson_id, owner.user_id, "提示衝突", json.dumps(newer, ensure_ascii=False)
    )

    live_quiz.trigger_question(
        first["id"], owner.user_id, "t1", "a.cpp", 3, _table(), "memo"
    )

    second = live_quiz.create_session(owner.user_id, lesson_id)
    assert second["questions"][0]["table_spec"]["var_hint"] == "newer"
    assert db.lesson_by_id(lesson_id)["current_version"] == 2
