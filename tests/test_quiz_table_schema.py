# tests/test_quiz_table_schema.py
"""migration 0006 的結構保證。

這些測試守的是「重建表」這個動作本身——它會複製既有資料，一旦複製漏了欄位或
CHECK 寫錯，症狀會出現在很久以後的課堂上，而不是在這裡。
"""

import sqlite3
from contextlib import closing

import pytest

from gdbgui.server import db


@pytest.fixture(autouse=True)
def _migrated():
    """確保這個檔案能單獨執行。

    這個模組只 import db、不 import gdbgui.server.app，而 db.initialize()
    只在 app 模組被 import 時才會跑一次。其他即時課堂測試能單獨過，是因為
    它們用了 flask_app fixture（間接 import app）先把 schema 建起來；這個
    檔案完全不碰 flask app，所以要自己保證 migrate() 跑過，否則
    `pytest tests/test_quiz_table_schema.py` 單獨執行時連 live_quiz_questions
    這張表都不存在。db.migrate() 本身冪等，跟其他測試檔案的呼叫不會互相踩。
    """
    db.migrate()


def _columns(conn, table):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _pre_v6_database(data_dir, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", data_dir)
    with closing(db.connect()) as conn:
        conn.execute(db._SCHEMA_VERSION_DDL)
        for path in db.migration_files():
            version = int(path.name[:4])
            if version >= 6:
                break
            conn.executescript(path.read_text(encoding="utf-8"))
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, 'now')",
                (version,),
            )
        conn.executescript(
            """
            INSERT INTO users VALUES (1, 'owner', 'hash', 'Owner', 'now');
            INSERT INTO lessons VALUES (1, 1, 'lesson', '{}', 'now', 'now');
            INSERT INTO live_quiz_sessions
                (id, lesson_id, owner_user_id, title, join_nonce, state, created_at)
            VALUES (1, 1, 1, 'session', 'nonce', 'lobby', 'now');
            INSERT INTO live_quiz_participants
                (id, session_id, nickname, credential_hash, created_at, last_seen_at)
            VALUES (1, 1, 'student', 'credential', 'now', 'now');
            INSERT INTO live_quiz_questions
                (id, session_id, question_key, prompt, options_json, correct_option_id,
                 explanation, source_file, trigger_line, trigger_anchor_json, position,
                 state, answer_count, correct_count, option_counts_json)
            VALUES
                (1, 1, 'choice', 'p', '[{"id":"a","text":"A"}]', 'a', 'e',
                 'a.cpp', 3, '{}', 0, 'open', 1, 1, '{"a":1}');
            INSERT INTO live_quiz_responses
                (participant_id, question_id, selected_option_id, is_correct, answered_at)
            VALUES (1, 1, 'a', 1, 'now');
            """
        )


def test_question_table_has_kind_and_table_columns():
    with db.connect() as conn:
        columns = _columns(conn, "live_quiz_questions")
    assert {"kind", "table_spec_json", "correct_table_json", "cell_stats_json"} <= columns


def test_response_table_has_table_columns():
    with db.connect() as conn:
        columns = _columns(conn, "live_quiz_responses")
    assert {"answer_json", "correct_cells", "total_cells"} <= columns


def test_choice_row_still_requires_its_own_columns():
    """kind='choice' 少了 options_json 必須被 CHECK 擋下。"""
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO live_quiz_questions "
                "(session_id, question_key, kind, prompt, explanation, source_file, "
                " trigger_line, trigger_anchor_json, position, state) "
                "VALUES (1, 'q1', 'choice', 'p', '', 'a.cpp', 1, '{}', 1, 'ready')"
            )


def test_table_row_requires_table_spec():
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO live_quiz_questions "
                "(session_id, question_key, kind, prompt, explanation, source_file, "
                " trigger_line, trigger_anchor_json, position, state) "
                "VALUES (1, 'q2', 'table', 'p', '', 'a.cpp', 2, '{}', 2, 'ready')"
            )


def test_migrate_is_idempotent():
    """migrate() 可能重播部分套用過的檔案，重跑不得爆炸也不得改變欄位集合。"""
    with db.connect() as conn:
        before = _columns(conn, "live_quiz_questions")
    db.migrate()
    with db.connect() as conn:
        assert _columns(conn, "live_quiz_questions") == before


def test_replaying_0006_preserves_populated_table_quiz(tmp_path, monkeypatch):
    """腳本已完成但版本號未落盤時，重播不能把 table 資料當 choice 複製。"""
    monkeypatch.setattr(db, "DATA_DIR", tmp_path / "replay")
    db.migrate()
    with closing(db.connect()) as conn:
        conn.executescript(
            """
            INSERT INTO users VALUES (1, 'owner', 'hash', 'Owner', 'now');
            INSERT INTO lessons VALUES (1, 1, 'lesson', '{}', 'now', 'now');
            INSERT INTO live_quiz_sessions
                (id, lesson_id, owner_user_id, title, join_nonce, state, created_at)
            VALUES (1, 1, 1, 'session', 'nonce', 'lobby', 'now');
            INSERT INTO live_quiz_participants
                (id, session_id, nickname, credential_hash, created_at, last_seen_at)
            VALUES (1, 1, 'student', 'credential', 'now', 'now');
            INSERT INTO live_quiz_questions
                (id, session_id, question_key, kind, prompt, explanation, source_file,
                 trigger_line, trigger_anchor_json, position, state, opened_at,
                 answer_count, correct_count, table_spec_json, correct_table_json,
                 cell_stats_json)
            VALUES
                (1, 1, 'table', 'table', 'p', 'e', 'a.cpp', 3, '{}', 0, 'open',
                 'now', 1, 0, '{"var_hint":"dp","max_cells":4}',
                 '{"rows":1,"cols":1,"row_labels":["0"],"col_labels":["0"],"values":[["42"]]}',
                 '[1]');
            INSERT INTO live_quiz_responses
                (participant_id, question_id, answered_at, answer_json, correct_cells, total_cells)
            VALUES (1, 1, 'now', '[["0"]]', 0, 1);
            DELETE FROM schema_version WHERE version = 6;
            """
        )

    assert db.migrate() == 1

    with closing(db.connect()) as conn:
        question = conn.execute(
            "SELECT kind, table_spec_json, correct_table_json, cell_stats_json "
            "FROM live_quiz_questions WHERE id=1"
        ).fetchone()
        response = conn.execute(
            "SELECT answer_json, correct_cells, total_cells "
            "FROM live_quiz_responses WHERE participant_id=1 AND question_id=1"
        ).fetchone()
    assert tuple(question) == (
        "table",
        '{"var_hint":"dp","max_cells":4}',
        '{"rows":1,"cols":1,"row_labels":["0"],"col_labels":["0"],"values":[["42"]]}',
        "[1]",
    )
    assert tuple(response) == ('[["0"]]', 0, 1)


@pytest.mark.parametrize("denied_alter", [1, 2], ids=["questions-gap", "responses-gap"])
def test_interrupted_0006_rolls_back_before_replay(tmp_path, monkeypatch, denied_alter):
    """DROP 後、rename 前斷線時，兩張正式表與既有作答都必須仍是完整的 v5。"""
    _pre_v6_database(tmp_path / f"gap-{denied_alter}", monkeypatch)
    migration = next(path for path in db.migration_files() if path.name.startswith("0006_"))
    alter_count = 0

    def interrupt_nth_rename(action, _arg1, _arg2, _database, _trigger):
        nonlocal alter_count
        if action == sqlite3.SQLITE_ALTER_TABLE:
            alter_count += 1
            if alter_count == denied_alter:
                return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    with closing(db.connect()) as conn:
        conn.set_authorizer(interrupt_nth_rename)
        with pytest.raises(sqlite3.DatabaseError, match="authorized"):
            conn.executescript(migration.read_text(encoding="utf-8"))

    with closing(db.connect()) as conn:
        assert "kind" not in _columns(conn, "live_quiz_questions")
        assert "answer_json" not in _columns(conn, "live_quiz_responses")
        assert conn.execute("SELECT COUNT(*) FROM live_quiz_questions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM live_quiz_responses").fetchone()[0] == 1

    assert db.migrate() == 1
    with closing(db.connect()) as conn:
        question = conn.execute(
            "SELECT kind, options_json, correct_option_id, option_counts_json "
            "FROM live_quiz_questions WHERE id=1"
        ).fetchone()
        response = conn.execute(
            "SELECT selected_option_id, is_correct, answer_json "
            "FROM live_quiz_responses WHERE participant_id=1 AND question_id=1"
        ).fetchone()
        foreign_key_errors = list(conn.execute("PRAGMA foreign_key_check"))
    assert tuple(question) == (
        "choice", '[{"id":"a","text":"A"}]', "a", '{"a":1}'
    )
    assert tuple(response) == ("a", 1, None)
    assert foreign_key_errors == []
