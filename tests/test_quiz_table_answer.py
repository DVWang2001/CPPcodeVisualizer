"""填表題在教師端 payload 裡的形狀。

逐格判定、熱區累計與學生看得到什麼，現在都在老師分頁（liveQuizEngine.ts）裡，
測試在 gdbgui/src/js/tests/liveQuizEngine.jest.ts；伺服器只把題目與收場聚合交給擁有者。
"""

import json

from gdbgui.server import live_quiz


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


def test_teacher_table_payload_includes_heatmap_dimensions_and_stats():
    payload = live_quiz._question_payload(_table_row())
    assert {
        "rows": 1,
        "cols": 1,
        "row_labels": ["0"],
        "col_labels": ["0"],
        "cell_stats": [1],
    }.items() <= payload.items()
