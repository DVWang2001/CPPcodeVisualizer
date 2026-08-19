"""填表題的 bundle 驗證與出題捕獲。"""

import pytest

from gdbgui.server import live_quiz
from gdbgui.server.live_quiz import QuizRejected

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
