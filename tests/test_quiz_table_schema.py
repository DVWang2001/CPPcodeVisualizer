# tests/test_quiz_table_schema.py
"""migration 0006 的結構保證。

這些測試守的是「重建表」這個動作本身——它會複製既有資料，一旦複製漏了欄位或
CHECK 寫錯，症狀會出現在很久以後的課堂上，而不是在這裡。
"""

import sqlite3

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
