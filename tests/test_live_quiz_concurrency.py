"""The answer transaction must not lose updates under the 60-student target load."""

import json
from concurrent.futures import ThreadPoolExecutor
from time import monotonic

from gdbgui.server import db, live_quiz
from .conftest import register_user
from .test_live_quiz_db import credential_hash, valid_bundle


def test_sixty_students_are_counted_exactly(flask_app):
    owner = register_user(flask_app, display_name="Concurrency Owner")
    lesson_id = db.create_lesson(
        owner.user_id, "併發", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    session = live_quiz.create_session(owner.user_id, lesson_id)
    live_quiz.trigger_question(session["id"], owner.user_id, "q1", "main.cpp", 3)
    credentials = []
    for index in range(60):
        guest_hash = credential_hash(f"student-{index}")
        live_quiz.join_session(session["id"], f"學生{index}", guest_hash)
        credentials.append(guest_hash)

    started = monotonic()
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(
            pool.map(lambda value: live_quiz.answer_question(value, "q1", "b"), credentials)
        )
    elapsed = monotonic() - started

    question = live_quiz.session_owned_by(session["id"], owner.user_id)["questions"][0]
    assert sum(result["inserted"] for result in results) == 60
    assert question["answer_count"] == question["correct_count"] == 60
    assert question["option_counts"] == {"a": 0, "b": 60}
    assert elapsed < 3


def test_parallel_retries_from_one_student_count_once(flask_app):
    owner = register_user(flask_app, display_name="Retry Owner")
    lesson_id = db.create_lesson(
        owner.user_id, "重送", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    session = live_quiz.create_session(owner.user_id, lesson_id)
    live_quiz.trigger_question(session["id"], owner.user_id, "q1", "main.cpp", 3)
    guest_hash = credential_hash("same-student")
    live_quiz.join_session(session["id"], "同一位", guest_hash)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda option: live_quiz.answer_question(guest_hash, "q1", option),
                ("a", "b"),
            )
        )

    question = live_quiz.session_owned_by(session["id"], owner.user_id)["questions"][0]
    assert sorted(result["inserted"] for result in results) == [False, True]
    assert question["answer_count"] == 1
    assert sum(question["option_counts"].values()) == 1
