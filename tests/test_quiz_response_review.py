"""教師收卷後檢視個別學生的填表作答。

這條路徑刻意跨過了 2026-08-01 規格原本的一條邊界（「不提供依學生姓名檢視答案的
畫面」）。使用者明確要求並承擔「課堂上提醒學生匿名參加」的義務，規格那一句已一併
修改。因此這裡的測試重點不是「能不能看」，而是**只有該看的人、在該看的時候、看得到
該看的題型**——三道守衛少一道，這個功能就從教學工具變成外洩面。
"""

import json

import pytest

from gdbgui.server import db
from .conftest import register_user
from .test_live_quiz_db import valid_bundle

TABLE = {
    "rows": 2,
    "cols": 2,
    "row_labels": ["0", "1"],
    "col_labels": ["0", "1"],
    "values": [["0", "1"], ["2", "3"]],
}


def table_bundle():
    bundle = valid_bundle()
    bundle["quiz"]["questions"] = [
        {
            "id": "t1",
            "kind": "table",
            "prompt": "填出 dp",
            "explanation": "逐格比較。",
            "table_spec": {"var_hint": "dp", "max_cells": 40},
            "trigger": bundle["quiz"]["questions"][0]["trigger"],
        }
    ]
    return bundle


@pytest.fixture
def closed_question(flask_app):
    """一場已收卷的課堂：一位學生答了一半對。回傳 (author, other, session_id)。"""
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="Review Author")
    other = register_user(flask_app, display_name="Review Other")
    lesson_id = db.create_lesson(
        author.user_id, "即時課堂", json.dumps(table_bundle(), ensure_ascii=False)
    )
    created = author.http.post(
        "/api/live-quiz/sessions",
        json={"lesson_id": lesson_id},
        headers={"x-csrftoken": author.csrf},
    )
    session = created.get_json()
    session_id = session["id"]
    token = session["join_url"].rsplit("/", 1)[-1]

    guest = flask_app.test_client()
    guest.post(
        "/api/live-quiz/guest/join",
        json={"token": token, "nickname": "小明"},
        headers={"Origin": "http://localhost"},
    )
    author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/t1/trigger",
        json={"source_file": "main.cpp", "line": 3, "table": TABLE, "var_hint": "dp"},
        headers={"x-csrftoken": author.csrf},
    )
    guest.post(
        "/api/live-quiz/guest/answers",
        json={"question_id": "t1", "answer": [["0", "9"], ["2", "3"]]},
        headers={"Origin": "http://localhost"},
    )
    author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/t1/close",
        headers={"x-csrftoken": author.csrf},
    )
    return author, other, session_id


def _get(client, session_id):
    return client.get(f"/api/live-quiz/sessions/{session_id}/questions/t1/responses")


def test_owner_sees_each_answer_with_its_nickname_and_score(closed_question):
    author, _, session_id = closed_question

    response = _get(author.http, session_id)

    assert response.status_code == 200
    rows = response.get_json()["responses"]
    assert len(rows) == 1
    assert rows[0]["nickname"] == "小明"
    assert rows[0]["answer"] == [["0", "9"], ["2", "3"]]
    assert rows[0]["correct_cells"] == 3
    assert rows[0]["total_cells"] == 4


def test_another_teacher_cannot_read_this_classrooms_answers(closed_question):
    _, other, session_id = closed_question

    assert _get(other.http, session_id).status_code == 404


def test_answers_stay_hidden_while_the_question_is_still_open(flask_app):
    """收卷前不得外露個別作答：其他人還在寫，而老師此刻也不需要看。"""
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="Open Author")
    lesson_id = db.create_lesson(
        author.user_id, "即時課堂", json.dumps(table_bundle(), ensure_ascii=False)
    )
    created = author.http.post(
        "/api/live-quiz/sessions",
        json={"lesson_id": lesson_id},
        headers={"x-csrftoken": author.csrf},
    )
    session_id = created.get_json()["id"]
    author.http.post(
        f"/api/live-quiz/sessions/{session_id}/questions/t1/trigger",
        json={"source_file": "main.cpp", "line": 3, "table": TABLE, "var_hint": "dp"},
        headers={"x-csrftoken": author.csrf},
    )

    assert _get(author.http, session_id).status_code == 409


def test_choice_questions_have_no_per_student_view(flask_app):
    """單選題不做這個畫面：選項分布已經說完了，個別資料沒有多的教學價值。"""
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="Choice Author")
    lesson_id = db.create_lesson(
        author.user_id, "即時課堂", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    created = author.http.post(
        "/api/live-quiz/sessions",
        json={"lesson_id": lesson_id},
        headers={"x-csrftoken": author.csrf},
    )
    session_id = created.get_json()["id"]

    response = author.http.get(
        f"/api/live-quiz/sessions/{session_id}/questions/q1/responses"
    )

    assert response.status_code == 409
