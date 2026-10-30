"""Live quiz persistence: immutable lesson snapshots, quiz validation and privacy."""

import json
from contextlib import closing
from hashlib import sha256

import pytest

from gdbgui.server import db, live_quiz
from .conftest import register_user


SOURCE = "int main() {\n  int i = 0;\n  i++;\n  return i;\n}"


def valid_bundle(prompt="i 是多少？", two_questions=False):
    questions = [
        {
            "id": "q1",
            "prompt": prompt,
            "options": [{"id": "a", "text": "0"}, {"id": "b", "text": "1"}],
            "correct_option_id": "b",
            "explanation": "i++ 會遞增。",
            "trigger": {
                "kind": "source_line",
                "source_file": "main.cpp",
                "line": 3,
                "anchor": {
                    "line_text": "i++;",
                    "before_text": "int i = 0;",
                    "after_text": "return i;",
                },
            },
        }
    ]
    if two_questions:
        questions.append(
            {
                "id": "q2",
                "prompt": "會回傳多少？",
                "options": [{"id": "a", "text": "0"}, {"id": "b", "text": "1"}],
                "correct_option_id": "b",
                "explanation": "回傳遞增後的 i。",
                "trigger": {
                    "kind": "source_line",
                    "source_file": "main.cpp",
                    "line": 4,
                    "anchor": {
                        "line_text": "return i;",
                        "before_text": "i++;",
                        "after_text": "}",
                    },
                },
            }
        )
    return {
        "version": "2.0",
        "fullname_to_render": "main.cpp",
        "source_code": SOURCE,
        "breakpoints": [],
        "program_input": "",
        "quiz": {"schema_version": 1, "questions": questions},
    }


def credential_hash(label):
    return sha256(label.encode("utf-8")).hexdigest()


def seed_legacy_participant(session_id, nickname, guest_hash, answered_question_key=None):
    """直接寫入舊 HTTP 訪客 API 會留下的參與者（與一筆單選作答）。

    那組 API 已移除（D5），但部署當下仍在 lobby 的舊場次可能還留著這些列；
    `end_session` 必須照樣刪光它們。回傳參與者 id。
    """
    now = db._now()
    with closing(db.connect()) as conn:
        participant_id = conn.execute(
            "INSERT INTO live_quiz_participants "
            "(session_id, nickname, credential_hash, created_at, last_seen_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, nickname, guest_hash, now, now),
        ).lastrowid
        if answered_question_key is not None:
            question_id = conn.execute(
                "SELECT id FROM live_quiz_questions WHERE session_id=? AND question_key=?",
                (session_id, answered_question_key),
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO live_quiz_responses "
                "(participant_id, question_id, answered_at, selected_option_id, is_correct) "
                "VALUES (?, ?, ?, 'b', 1)",
                (participant_id, question_id, now),
            )
        conn.commit()
    return int(participant_id)


@pytest.fixture
def quiz_owner(flask_app):
    return register_user(flask_app, display_name="Quiz Owner")


@pytest.fixture
def quiz_session(quiz_owner):
    lesson_id = db.create_lesson(
        quiz_owner.user_id, "迴圈", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    session = live_quiz.create_session(quiz_owner.user_id, lesson_id)
    assert session is not None
    return quiz_owner, lesson_id, session


def test_live_quiz_migration_is_idempotent(flask_app):
    assert db.schema_version() >= 5
    assert db.migrate() == 0
    with closing(db.connect()) as conn:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
            )
        }
    assert {
        "live_quiz_sessions",
        "live_quiz_questions",
        "live_quiz_participants",
        "live_quiz_responses",
        "live_quiz_session_owner_idx",
        "live_quiz_question_session_idx",
        "live_quiz_participant_session_idx",
    } <= names


def test_bundle_validation_relocates_a_unique_anchor_and_rejects_unknown_fields():
    bundle = valid_bundle()
    bundle["source_code"] = "// intro\n" + bundle["source_code"]
    normalized = live_quiz.validate_quiz_bundle(bundle)
    assert normalized["questions"][0]["trigger"]["line"] == 4

    bundle = valid_bundle()
    bundle["quiz"]["questions"][0]["surprise"] = True
    with pytest.raises(live_quiz.QuizRejected, match="未知欄位"):
        live_quiz.validate_quiz_bundle(bundle)

    for unsafe_id in ("q/1", ".."):
        bundle = valid_bundle()
        bundle["quiz"]["questions"][0]["id"] = unsafe_id
        with pytest.raises(live_quiz.QuizRejected, match="題目 ID"):
            live_quiz.validate_quiz_bundle(bundle)


def test_windows_drive_paths_match_case_insensitively_with_either_separator():
    assert live_quiz._same_file("C:/lesson/MAIN.cpp", "D:/run/main.cpp")
    assert not live_quiz._same_file("/tmp/MAIN.cpp", "/tmp/main.cpp")


def test_lesson_write_rejects_malformed_quiz_and_persists_relocated_anchor(quiz_owner):
    malformed = valid_bundle()
    malformed["quiz"]["questions"][0]["surprise"] = True
    rejected = quiz_owner.http.post(
        "/api/lessons",
        json={"title": "不應儲存", "bundle": malformed},
        headers={"x-csrftoken": quiz_owner.csrf},
    )
    assert rejected.status_code == 400

    moved = valid_bundle()
    moved["source_code"] = "// intro\n" + moved["source_code"]
    created = quiz_owner.http.post(
        "/api/lessons",
        json={"title": "已重定位", "bundle": moved},
        headers={"x-csrftoken": quiz_owner.csrf},
    )
    assert created.status_code == 201
    stored = db.lesson_by_id(created.get_json()["id"])
    assert json.loads(stored["bundle_json"])["quiz"]["questions"][0]["trigger"]["line"] == 4


def test_session_copies_the_current_lesson_version(quiz_owner):
    lesson_id = db.create_lesson(
        quiz_owner.user_id, "迴圈", json.dumps(valid_bundle(), ensure_ascii=False)
    )
    db.update_lesson_owned_by(
        lesson_id,
        quiz_owner.user_id,
        "目前版本",
        json.dumps(valid_bundle("目前版本的題目"), ensure_ascii=False),
    )

    created = live_quiz.create_session(quiz_owner.user_id, lesson_id)
    assert created["title"] == "目前版本"
    assert created["lesson_version"] == 2
    assert created["questions"][0]["prompt"] == "目前版本的題目"

    db.update_lesson_owned_by(
        lesson_id,
        quiz_owner.user_id,
        "之後又修改",
        json.dumps(valid_bundle("不應改到場次"), ensure_ascii=False),
    )
    unchanged = live_quiz.session_owned_by(created["id"], quiz_owner.user_id)
    assert unchanged["title"] == "目前版本"
    assert unchanged["questions"][0]["prompt"] == "目前版本的題目"


def test_non_owner_cannot_create_or_read_a_session(quiz_session, flask_app):
    owner, lesson_id, session = quiz_session
    other = register_user(flask_app, display_name="Other")
    assert live_quiz.create_session(other.user_id, lesson_id) is None
    assert live_quiz.session_owned_by(session["id"], other.user_id) is None
    assert live_quiz.session_owned_by(session["id"], owner.user_id) is not None


def test_end_keeps_aggregates_and_deletes_identity(quiz_session):
    """部署前就在 lobby 的舊場次：題目開著、有聚合、也有暱稱與逐筆作答。

    不帶上傳的收場（寬限期滿的路徑）保留聚合、把開著的題關掉，並刪光身分資料。
    """
    owner, _, session = quiz_session
    seed_legacy_participant(session["id"], "應被刪除", credential_hash("privacy"), "q1")
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_questions SET state='open', opened_at=?, answer_count=1, "
            "correct_count=1, option_counts_json='{\"a\":0,\"b\":1}' "
            "WHERE session_id=? AND question_key='q1'",
            (db._now(), session["id"]),
        )
        conn.commit()

    ended = live_quiz.end_session(session["id"], owner.user_id)
    assert ended["state"] == "ended"
    assert ended["questions"][0]["state"] == "closed"
    assert ended["questions"][0]["correct_count"] == 1
    assert ended["questions"][0]["option_counts"] == {"a": 0, "b": 1}
    assert ended["joined_count"] == 0
    with closing(db.connect()) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?", (session["id"],)
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_responses r "
            "JOIN live_quiz_questions q ON q.id=r.question_id WHERE q.session_id=?",
            (session["id"],),
        ).fetchone()[0] == 0


def test_empty_quiz_cannot_start_a_session(quiz_owner):
    bundle = valid_bundle()
    bundle["quiz"]["questions"] = []
    lesson_id = db.create_lesson(
        quiz_owner.user_id, "空題庫", json.dumps(bundle, ensure_ascii=False)
    )
    with pytest.raises(live_quiz.QuizRejected):
        live_quiz.create_session(quiz_owner.user_id, lesson_id)
