"""收場一次上傳聚合：老師分頁算好的匿名聚合在 `/end` 一次寫入。

伺服器不能證明這些數字是真的（設計說明「安全不變式」第 6 條），所以這裡只驗
格式與範圍——但每一條都要在拒絕時回 400、資料庫完全不變。驗證矩陣（安全審查 F2）
的每一列都有自己的測試，而且每一個壞輸入都刻意只違反**那一條**規則：拿掉那一條
檢查，測試就會失敗（上傳會被收下，回 200）。
"""

import json
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from gdbgui.server import db, live_quiz
from .conftest import register_user
from .test_live_quiz_db import credential_hash
from .test_live_quiz_relay import NS, relay, take  # noqa: F401  (relay 是 fixture)


SOURCE = "int main() {\n  int dp[2][3];\n  int i = 0;\n  i++;\n  return i;\n}"


def _trigger(line, line_text, before_text, after_text):
    return {
        "kind": "source_line",
        "source_file": "main.cpp",
        "line": line,
        "anchor": {
            "line_text": line_text,
            "before_text": before_text,
            "after_text": after_text,
        },
    }


def mixed_bundle():
    """兩題單選、兩題填表；q1／t1 會開過，q3／t2 從頭到尾沒開。"""
    return {
        "version": "2.0",
        "fullname_to_render": "main.cpp",
        "source_code": SOURCE,
        "breakpoints": [],
        "program_input": "",
        "quiz": {
            "schema_version": 1,
            "questions": [
                {
                    "id": "q1",
                    "prompt": "i 是多少？",
                    "options": [{"id": "a", "text": "0"}, {"id": "b", "text": "1"}],
                    "correct_option_id": "b",
                    "explanation": "i++ 會遞增。",
                    "trigger": _trigger(4, "i++;", "int i = 0;", "return i;"),
                },
                {
                    "id": "t1",
                    "kind": "table",
                    "prompt": "填出 dp",
                    "explanation": "",
                    "table_spec": {"var_hint": "dp", "max_cells": 40},
                    "trigger": _trigger(5, "return i;", "i++;", "}"),
                },
                {
                    "id": "q3",
                    "prompt": "沒開過的題",
                    "options": [{"id": "a", "text": "0"}, {"id": "b", "text": "1"}],
                    "correct_option_id": "a",
                    "explanation": "",
                    "trigger": _trigger(3, "int i = 0;", "int dp[2][3];", "i++;"),
                },
                {
                    "id": "t2",
                    "kind": "table",
                    "prompt": "沒開過的填表題",
                    "explanation": "",
                    "table_spec": {"var_hint": "dp", "max_cells": 6},
                    "trigger": _trigger(2, "int dp[2][3];", "int main() {", "int i = 0;"),
                },
            ],
        },
    }


@pytest.fixture
def ctx(flask_app):
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    author = register_user(flask_app, display_name="Upload Author")
    other = register_user(flask_app, display_name="Upload Other")
    lesson_id = db.create_lesson(
        author.user_id, "收場上傳", json.dumps(mixed_bundle(), ensure_ascii=False)
    )
    created = author.http.post(
        "/api/live-quiz/sessions",
        json={"lesson_id": lesson_id},
        headers={"x-csrftoken": author.csrf},
    )
    assert created.status_code == 201, created.get_json()
    session_id = created.get_json()["id"]
    # 把場次建立時間往前推一小時，上傳的時間戳才有「課堂期間」可以落在裡面。
    created_at = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1)
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_sessions SET created_at=? WHERE id=?",
            (created_at.isoformat(), session_id),
        )
        conn.commit()
    return SimpleNamespace(
        app=flask_app,
        author=author,
        other=other,
        lesson_id=lesson_id,
        session_id=session_id,
        created_at=created_at,
        token=urlsplit(created.get_json()["join_url"]).path.rsplit("/", 1)[-1],
    )


def at(ctx, minutes):
    """與 TS `toISOString()` 同格式：毫秒、結尾 Z。"""
    moment = ctx.created_at + timedelta(minutes=minutes, milliseconds=123)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stored(ctx, minutes):
    """伺服器自己的格式：秒、+00:00。"""
    return (ctx.created_at + timedelta(minutes=minutes)).isoformat(timespec="seconds")


def realistic_upload(ctx):
    """`liveQuizEngine.endedSummary()` 實際送出的形狀。"""
    return {
        "questions": [
            {
                "question_key": "q1",
                "opened_at": at(ctx, 10),
                "closed_at": at(ctx, 12),
                "answer_count": 3,
                "correct_count": 2,
                "option_counts": {"a": 1, "b": 2},
            },
            {
                "question_key": "t1",
                "opened_at": at(ctx, 13),
                "closed_at": at(ctx, 15),
                "answer_count": 2,
                "correct_count": 1,
                "var_hint": "dp",
                "cell_stats": [0, 1, 0, 2, 0, 0],
                "rows": 2,
                "cols": 3,
            },
            {
                "question_key": "q3",
                "opened_at": None,
                "closed_at": None,
                "answer_count": 0,
                "correct_count": 0,
                "option_counts": {"a": 0, "b": 0},
            },
            {
                "question_key": "t2",
                "opened_at": None,
                "closed_at": None,
                "answer_count": 0,
                "correct_count": 0,
                "var_hint": "dp",
            },
        ]
    }


def item(upload, key):
    return next(entry for entry in upload["questions"] if entry["question_key"] == key)


_NO_BODY = object()


def end(user, session_id, upload=_NO_BODY, **kwargs):
    if upload is _NO_BODY:
        return user.http.post(
            f"/api/live-quiz/sessions/{session_id}/end",
            headers={"x-csrftoken": user.csrf},
            **kwargs,
        )
    return user.http.post(
        f"/api/live-quiz/sessions/{session_id}/end",
        json=upload,
        headers={"x-csrftoken": user.csrf},
    )


def snapshot(ctx):
    with closing(db.connect()) as conn:
        session = tuple(
            conn.execute(
                "SELECT * FROM live_quiz_sessions WHERE id=?", (ctx.session_id,)
            ).fetchone()
        )
        questions = [
            tuple(row)
            for row in conn.execute(
                "SELECT * FROM live_quiz_questions WHERE session_id=? ORDER BY position",
                (ctx.session_id,),
            )
        ]
        lesson = tuple(
            conn.execute(
                "SELECT bundle_json, updated_at FROM lessons WHERE id=?", (ctx.lesson_id,)
            ).fetchone()
        )
        versions = conn.execute(
            "SELECT COUNT(*) FROM lesson_versions WHERE lesson_id=?", (ctx.lesson_id,)
        ).fetchone()[0]
        participants = conn.execute(
            "SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?",
            (ctx.session_id,),
        ).fetchone()[0]
    return session, questions, lesson, versions, participants


def question_rows(ctx):
    with closing(db.connect()) as conn:
        return {
            row["question_key"]: dict(row)
            for row in conn.execute(
                "SELECT * FROM live_quiz_questions WHERE session_id=?", (ctx.session_id,)
            )
        }


def session_row(ctx):
    with closing(db.connect()) as conn:
        return dict(
            conn.execute(
                "SELECT * FROM live_quiz_sessions WHERE id=?", (ctx.session_id,)
            ).fetchone()
        )


def lesson_bundle(ctx):
    return json.loads(db.lesson_by_id(ctx.lesson_id)["bundle_json"])


def assert_rejected(ctx, upload, user=None):
    before = snapshot(ctx)
    response = end(user or ctx.author, ctx.session_id, upload)
    assert response.status_code == 400, response.get_json()
    assert "error" in response.get_json()
    assert snapshot(ctx) == before
    assert session_row(ctx)["state"] == "lobby"


# ── 正常路徑 ──────────────────────────────────────────────────────────────────


def test_upload_writes_aggregates_and_export_summary_lists_session(ctx):
    response = end(ctx.author, ctx.session_id, realistic_upload(ctx))
    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert body["state"] == "ended"
    assert body["hint_saved"] is True

    rows = question_rows(ctx)
    q1, t1, q3, t2 = rows["q1"], rows["t1"], rows["q3"], rows["t2"]
    assert (q1["state"], q1["answer_count"], q1["correct_count"]) == ("closed", 3, 2)
    assert json.loads(q1["option_counts_json"]) == {"a": 1, "b": 2}
    assert (q1["opened_at"], q1["closed_at"]) == (stored(ctx, 10), stored(ctx, 12))
    assert (t1["state"], t1["answer_count"], t1["correct_count"]) == ("closed", 2, 1)
    assert json.loads(t1["cell_stats_json"]) == [0, 1, 0, 2, 0, 0]
    assert (t1["opened_at"], t1["closed_at"]) == (stored(ctx, 13), stored(ctx, 15))
    # 沒開過的題：伺服器不寫任何聚合，狀態維持 ready。
    for never in (q3, t2):
        assert never["state"] == "ready"
        assert never["opened_at"] is None and never["closed_at"] is None
        assert never["answer_count"] == 0 and never["correct_count"] == 0
    assert json.loads(q3["option_counts_json"]) == {"a": 0, "b": 0}
    assert t2["cell_stats_json"] is None

    summary = ctx.author.http.get("/api/live-quiz/export").get_json()
    [listed] = [s for s in summary["sessions"] if s["session_id"] == ctx.session_id]
    assert listed["state"] == "ended"
    assert [q["question_key"] for q in listed["questions"]] == ["q1", "t1"]
    assert listed["questions"][0]["option_counts"] == {"a": 1, "b": 2}
    assert listed["questions"][1]["cell_stats"] == [0, 1, 0, 2, 0, 0]


def test_question_still_open_at_end_is_closed_at_the_end_time(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["closed_at"] = None
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    t1 = question_rows(ctx)["t1"]
    assert t1["state"] == "closed"
    assert t1["closed_at"] == session_row(ctx)["ended_at"]


def test_upload_timestamps_accept_z_and_offsets_and_are_stored_in_server_format(ctx):
    upload = realistic_upload(ctx)
    taipei = timezone(timedelta(hours=8))
    q1 = item(upload, "q1")
    q1["opened_at"] = (ctx.created_at + timedelta(minutes=10)).isoformat()  # +00:00
    q1["closed_at"] = (
        (ctx.created_at + timedelta(minutes=12, microseconds=456789)).astimezone(taipei).isoformat()
    )
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    rows = question_rows(ctx)
    assert rows["q1"]["opened_at"] == stored(ctx, 10)
    assert rows["q1"]["closed_at"] == stored(ctx, 12)
    assert rows["t1"]["opened_at"] == stored(ctx, 13)  # 原本是 ...123Z


def test_minimal_never_opened_items_are_accepted(ctx):
    """沒開過的題可以只帶 question_key，或只帶 var_hint。"""
    upload = {
        "questions": [
            {"question_key": "q3"},
            {"question_key": "t2", "var_hint": "dp"},
        ]
    }
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    assert session_row(ctx)["state"] == "ended"
    assert all(row["state"] == "ready" for row in question_rows(ctx).values())


def test_end_with_upload_still_deletes_participants_and_responses(ctx):
    """F8：升級前就在 lobby 的舊場次可能還留著暱稱，收場仍要刪光。"""
    live_quiz.join_session(ctx.session_id, "應被刪除", credential_hash("f8"))
    assert snapshot(ctx)[4] == 1
    assert end(ctx.author, ctx.session_id, realistic_upload(ctx)).status_code == 200
    with closing(db.connect()) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?",
            (ctx.session_id,),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM live_quiz_responses r JOIN live_quiz_questions q "
            "ON q.id=r.question_id WHERE q.session_id=?",
            (ctx.session_id,),
        ).fetchone()[0] == 0


# ── 題目歸屬與數量 ────────────────────────────────────────────────────────────


def test_upload_rejects_unknown_question_key(ctx):
    upload = realistic_upload(ctx)
    upload["questions"].append({"question_key": "zz"})
    assert_rejected(ctx, upload)


def test_upload_rejects_duplicate_question_key(ctx):
    upload = realistic_upload(ctx)
    upload["questions"].append(dict(item(upload, "q1")))
    assert_rejected(ctx, upload)


def test_upload_rejects_more_than_max_questions(ctx, monkeypatch):
    monkeypatch.setattr(live_quiz, "MAX_QUESTIONS", 3)
    assert_rejected(ctx, realistic_upload(ctx))  # 四題，各自都合法


def test_upload_rejects_non_string_question_key(ctx):
    upload = realistic_upload(ctx)
    upload["questions"].append({"question_key": 7})
    assert_rejected(ctx, upload)


# ── 欄位與題型相符 ────────────────────────────────────────────────────────────


def test_upload_rejects_option_counts_on_a_table_question(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["option_counts"] = {"a": 1, "b": 1}
    assert_rejected(ctx, upload)


@pytest.mark.parametrize("field,value", [("cell_stats", [0]), ("rows", 1), ("cols", 1)])
def test_upload_rejects_table_fields_on_a_choice_question(ctx, field, value):
    upload = realistic_upload(ctx)
    item(upload, "q1")[field] = value
    assert_rejected(ctx, upload)


def test_upload_rejects_var_hint_on_a_choice_question(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q1")["var_hint"] = "dp"
    assert_rejected(ctx, upload)


@pytest.mark.parametrize(
    "counts",
    [
        {"b": 3},  # 少一個選項（總和仍對）
        {"a": 1, "b": 2, "z": 0},  # 多一個不存在的選項（總和仍對）
    ],
)
def test_upload_option_counts_keys_must_equal_the_question_options(ctx, counts):
    upload = realistic_upload(ctx)
    item(upload, "q1")["option_counts"] = counts
    assert_rejected(ctx, upload)


def test_upload_rejects_opened_choice_question_without_option_counts(ctx):
    upload = realistic_upload(ctx)
    del item(upload, "q1")["option_counts"]
    assert_rejected(ctx, upload)


@pytest.mark.parametrize("missing", ["cell_stats", "rows", "cols"])
def test_upload_rejects_opened_table_question_without_heatmap_fields(ctx, missing):
    upload = realistic_upload(ctx)
    del item(upload, "t1")[missing]
    assert_rejected(ctx, upload)


def test_upload_rejects_unknown_top_level_or_item_fields(ctx):
    upload = realistic_upload(ctx)
    upload["csrf_token"] = ctx.author.csrf
    assert_rejected(ctx, upload)
    upload = realistic_upload(ctx)
    item(upload, "q1")["nickname"] = "小明"
    assert_rejected(ctx, upload)


@pytest.mark.parametrize("questions", [None, {}, "q1"])
def test_upload_rejects_non_list_questions(ctx, questions):
    assert_rejected(ctx, {"questions": questions})


@pytest.mark.parametrize("raw", [b"not json", b"null", b"[]", b"\"x\""])
def test_upload_rejects_malformed_body(ctx, raw):
    before = snapshot(ctx)
    response = ctx.author.http.post(
        f"/api/live-quiz/sessions/{ctx.session_id}/end",
        data=raw,
        content_type="application/json",
        headers={"x-csrftoken": ctx.author.csrf},
    )
    assert response.status_code == 400
    assert snapshot(ctx) == before


# ── 題目狀態由伺服器決定 ──────────────────────────────────────────────────────


@pytest.mark.parametrize("key", ["q1", "q3"])
def test_upload_cannot_set_question_state(ctx, key):
    upload = realistic_upload(ctx)
    item(upload, key)["state"] = "open"
    assert_rejected(ctx, upload)


def test_never_opened_question_cannot_carry_close_time(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q3")["closed_at"] = at(ctx, 20)
    assert_rejected(ctx, upload)


@pytest.mark.parametrize("field", ["answer_count", "correct_count"])
def test_never_opened_question_cannot_carry_answers(ctx, field):
    upload = realistic_upload(ctx)
    item(upload, "t2")[field] = 1
    assert_rejected(ctx, upload)


def test_never_opened_table_cannot_carry_a_heatmap(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t2").update({"cell_stats": [0] * 6, "rows": 2, "cols": 3})
    assert_rejected(ctx, upload)


def test_never_opened_choice_cannot_carry_option_counts(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q3")["option_counts"] = {"a": 1, "b": 0}
    assert_rejected(ctx, upload)


# ── 計數 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "key,field,value",
    [
        ("q1", "option_counts", {"a": -1, "b": 4}),  # 總和仍是 3
        ("t1", "cell_stats", [0, -1, 0, 2, 0, 0]),  # 仍 ≤ answer_count
        ("q1", "answer_count", -3),
    ],
)
def test_upload_rejects_negative_counts_and_unknown_option_ids(ctx, key, field, value):
    upload = realistic_upload(ctx)
    item(upload, key)[field] = value
    assert_rejected(ctx, upload)
    upload = realistic_upload(ctx)
    item(upload, "q1")["option_counts"] = {"a": 1, "b": 2, "c": 0}
    assert_rejected(ctx, upload)


@pytest.mark.parametrize(
    "key,field,value",
    [
        ("q1", "correct_count", True),  # bool 是 int 的子類別，True == 1
        ("q1", "answer_count", 3.0),  # 3.0 == 3，總和仍對
        ("q1", "option_counts", {"a": 1.0, "b": 2}),
        ("t1", "cell_stats", [0, True, 0, 2, 0, 0]),
        ("t1", "answer_count", "2"),
    ],
)
def test_upload_rejects_boolean_or_non_integer_counts(ctx, key, field, value):
    upload = realistic_upload(ctx)
    item(upload, key)[field] = value
    assert_rejected(ctx, upload)


def test_upload_rejects_correct_count_above_answer_count(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q1")["correct_count"] = 4
    assert_rejected(ctx, upload)


def test_upload_rejects_option_counts_not_summing_to_answer_count(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q1")["option_counts"] = {"a": 1, "b": 1}
    assert_rejected(ctx, upload)


def test_upload_rejects_cell_stat_above_answer_count(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["cell_stats"] = [0, 3, 0, 0, 0, 0]
    assert_rejected(ctx, upload)


def test_upload_rejects_counts_beyond_sqlite_integer_range(ctx):
    upload = realistic_upload(ctx)
    huge = db.SQLITE_MAX_INTEGER + 1
    item(upload, "q1").update(
        {"answer_count": huge, "correct_count": 0, "option_counts": {"a": huge, "b": 0}}
    )
    assert_rejected(ctx, upload)


# ── 填表題的維度 ──────────────────────────────────────────────────────────────


def test_upload_rejects_table_dimensions_over_max_cells(ctx):
    upload = realistic_upload(ctx)
    t2 = item(upload, "t2")  # max_cells = 6
    t2.update(
        {
            "opened_at": at(ctx, 20),
            "closed_at": at(ctx, 21),
            "answer_count": 1,
            "correct_count": 0,
            "rows": 2,
            "cols": 4,
            "cell_stats": [0] * 8,
        }
    )
    assert_rejected(ctx, upload)


def test_upload_rejects_table_over_the_cell_ceiling_even_if_spec_allows_more(ctx):
    with closing(db.connect()) as conn:
        conn.execute(
            "UPDATE live_quiz_questions SET table_spec_json=? "
            "WHERE session_id=? AND question_key='t1'",
            (json.dumps({"var_hint": "dp", "max_cells": 500}), ctx.session_id),
        )
        conn.commit()
    upload = realistic_upload(ctx)
    item(upload, "t1").update({"rows": 15, "cols": 15, "cell_stats": [0] * 225})
    assert_rejected(ctx, upload)


def test_upload_rejects_cell_stats_length_mismatch(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["cell_stats"] = [0, 1, 0, 2, 0]
    assert_rejected(ctx, upload)


@pytest.mark.parametrize(
    "rows,cols,stats",
    [
        (0, 3, []),  # 0 格，長度相符、不超過上限
        (True, 6, [0] * 6),  # True × 6 = 6
        (2.0, 3, [0] * 6),
        ("2", 3, [0] * 6),
    ],
)
def test_upload_rejects_non_positive_or_non_integer_dimensions(ctx, rows, cols, stats):
    upload = realistic_upload(ctx)
    item(upload, "t1").update({"rows": rows, "cols": cols, "cell_stats": stats})
    assert_rejected(ctx, upload)


# ── 時間戳 ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value",
    [
        "yesterday",
        "2026-13-01T00:00:00Z",
        12345,
        "",
    ],
)
def test_upload_rejects_unparseable_timestamps(ctx, value):
    upload = realistic_upload(ctx)
    item(upload, "q1")["closed_at"] = value
    assert_rejected(ctx, upload)


def test_upload_rejects_timestamps_without_a_timezone(ctx):
    upload = realistic_upload(ctx)
    naive = (ctx.created_at + timedelta(minutes=10)).replace(tzinfo=None)
    item(upload, "q1")["opened_at"] = naive.isoformat()
    assert_rejected(ctx, upload)


def test_upload_rejects_opened_after_closed(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q1").update({"opened_at": at(ctx, 12), "closed_at": at(ctx, 10)})
    assert_rejected(ctx, upload)


def ts(moment):
    """任意時刻，TS `toISOString()` 格式（毫秒、Z）。"""
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def skewed_upload(ctx, side, seconds):
    """老師時鐘快（ahead：收卷時間在伺服器現在之後）或慢（behind：開題時間在建立之前）。"""
    upload = realistic_upload(ctx)
    if side == "ahead":
        moment = datetime.now(timezone.utc) + timedelta(seconds=seconds)
        item(upload, "t1")["closed_at"] = ts(moment)
    else:
        moment = ctx.created_at - timedelta(seconds=seconds)
        item(upload, "q1")["opened_at"] = ts(moment)
    return upload, moment.replace(microsecond=0).isoformat()


def test_upload_accepts_timestamps_within_skew_ahead_and_behind(ctx):
    """controller ruling 16：老師筆電時鐘常差幾秒到幾分鐘，±300 秒內要收。"""
    upload = realistic_upload(ctx)
    ahead, ahead_stored = skewed_upload(ctx, "ahead", 200)
    behind, behind_stored = skewed_upload(ctx, "behind", 200)
    item(upload, "t1")["closed_at"] = item(ahead, "t1")["closed_at"]
    item(upload, "q1")["opened_at"] = item(behind, "q1")["opened_at"]
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    rows = question_rows(ctx)
    assert rows["t1"]["closed_at"] == ahead_stored
    assert rows["q1"]["opened_at"] == behind_stored


@pytest.mark.parametrize("side", ["ahead", "behind"])
def test_upload_rejects_timestamps_beyond_skew(ctx, side):
    upload, _ = skewed_upload(ctx, side, 400)
    assert_rejected(ctx, upload)
    # 對照：同一邊、在容忍範圍內就收——證明上面是被時鐘偏差的界線擋下，不是別的規則。
    upload, stored_value = skewed_upload(ctx, side, 200)
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    rows = question_rows(ctx)
    assert stored_value in (rows["t1"]["closed_at"], rows["q1"]["opened_at"])


def test_upload_rejects_timestamps_far_outside_the_session(ctx):
    upload = realistic_upload(ctx)
    item(upload, "q1")["opened_at"] = at(ctx, -30)
    assert_rejected(ctx, upload)
    upload = realistic_upload(ctx)
    item(upload, "q1")["closed_at"] = at(ctx, 120)  # 建立於一小時前，這是一小時後
    assert_rejected(ctx, upload)


# ── var_hint ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("hint", ["d\x07p", "dp\n", "\x00", "d\x85p", "d\x7fp"])
def test_upload_rejects_var_hint_with_control_characters(ctx, hint):
    upload = realistic_upload(ctx)
    item(upload, "t2")["var_hint"] = hint
    assert_rejected(ctx, upload)


@pytest.mark.parametrize("hint", ["x" * 129, 7, None])
def test_upload_rejects_var_hint_that_is_too_long_or_not_text(ctx, hint):
    upload = realistic_upload(ctx)
    item(upload, "t2")["var_hint"] = hint
    assert_rejected(ctx, upload)


# ── 教案提示寫回（F1） ────────────────────────────────────────────────────────


def test_upload_persists_table_var_hint_to_lesson(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["var_hint"] = "memo"
    item(upload, "t2")["var_hint"] = "  arr  "
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["hint_saved"] is True

    bundle = lesson_bundle(ctx)
    hints = {
        question["id"]: question["table_spec"]["var_hint"]
        for question in bundle["quiz"]["questions"]
        if question.get("kind") == "table"
    }
    assert hints == {"t1": "memo", "t2": "arr"}
    # 兩個提示只用一次教案更新寫回：版本從 1 變 2，不是 3。
    assert db.lesson_by_id(ctx.lesson_id)["current_version"] == 2
    # 場次自己的題目設定也跟著更新。
    rows = question_rows(ctx)
    assert json.loads(rows["t1"]["table_spec_json"])["var_hint"] == "memo"
    assert json.loads(rows["t2"]["table_spec_json"])["var_hint"] == "arr"


def test_unchanged_var_hint_does_not_write_a_lesson_version(ctx):
    assert end(ctx.author, ctx.session_id, realistic_upload(ctx)).status_code == 200
    assert db.lesson_by_id(ctx.lesson_id)["current_version"] == 1


def test_end_with_changed_var_hint_does_not_block_on_nested_transaction(ctx):
    upload = realistic_upload(ctx)
    item(upload, "t1")["var_hint"] = "memo"
    started = time.monotonic()
    response = end(ctx.author, ctx.session_id, upload)
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.get_json()
    assert elapsed < 2.0
    assert response.get_json()["hint_saved"] is True
    assert db.lesson_by_id(ctx.lesson_id)["current_version"] == 2


@pytest.mark.parametrize(
    "failure",
    [db.LessonRejected("lesson bundle is too large"), sqlite3.OperationalError("database is locked")],
)
def test_hint_write_failure_keeps_the_session_ended_and_reports_it(ctx, monkeypatch, caplog, failure):
    def reject(*args, **kwargs):
        raise failure

    monkeypatch.setattr(db, "update_lesson_owned_by", reject)
    upload = realistic_upload(ctx)
    item(upload, "t1")["var_hint"] = "secret-hint-marker"
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["hint_saved"] is False
    assert session_row(ctx)["state"] == "ended"
    assert question_rows(ctx)["q1"]["answer_count"] == 3
    assert db.lesson_by_id(ctx.lesson_id)["current_version"] == 1
    # 失敗有記錄，但上傳內容不進 log。
    assert "hint" in caplog.text
    assert "secret-hint-marker" not in caplog.text


def test_hint_is_not_saved_over_a_newer_lesson_version(ctx):
    newer = mixed_bundle()
    newer["quiz"]["questions"][1]["table_spec"]["var_hint"] = "newer"
    db.update_lesson_owned_by(
        ctx.lesson_id, ctx.author.user_id, "收場上傳", json.dumps(newer, ensure_ascii=False)
    )
    upload = realistic_upload(ctx)
    item(upload, "t1")["var_hint"] = "memo"
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200
    assert response.get_json()["hint_saved"] is False
    assert lesson_bundle(ctx)["quiz"]["questions"][1]["table_spec"]["var_hint"] == "newer"


# ── 收場本身 ──────────────────────────────────────────────────────────────────


def test_second_end_returns_404_and_overwrites_nothing(ctx):
    assert end(ctx.author, ctx.session_id, realistic_upload(ctx)).status_code == 200
    after_first = snapshot(ctx)
    other_upload = realistic_upload(ctx)
    item(other_upload, "q1").update(
        {"answer_count": 9, "correct_count": 9, "option_counts": {"a": 0, "b": 9}}
    )
    item(other_upload, "t1")["var_hint"] = "memo"
    assert end(ctx.author, ctx.session_id, other_upload).status_code == 404
    assert end(ctx.author, ctx.session_id).status_code == 404
    assert snapshot(ctx) == after_first
    # 直接呼叫也一樣（寬限期滿的路徑）。
    assert live_quiz.end_session(ctx.session_id, ctx.author.user_id, other_upload) is None
    assert snapshot(ctx) == after_first


@pytest.mark.parametrize("upload", [_NO_BODY, {}])
def test_end_without_upload_marks_ended_and_keeps_no_aggregates(ctx, upload):
    response = end(ctx.author, ctx.session_id, upload)
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["state"] == "ended"
    assert response.get_json()["hint_saved"] is True
    assert session_row(ctx)["state"] == "ended"
    for row in question_rows(ctx).values():
        assert row["state"] == "ready"
        assert row["opened_at"] is None and row["answer_count"] == 0
    summary = ctx.author.http.get("/api/live-quiz/export").get_json()
    assert ctx.session_id not in [s["session_id"] for s in summary["sessions"]]
    assert db.lesson_by_id(ctx.lesson_id)["current_version"] == 1


def test_two_argument_end_session_still_ends_without_aggregates(ctx):
    """Task 3 的寬限期路徑用兩個參數呼叫。"""
    ended = live_quiz.end_session(ctx.session_id, ctx.author.user_id)
    assert ended["state"] == "ended"
    assert all(row["state"] == "ready" for row in question_rows(ctx).values())


def test_end_by_non_owner_is_404(ctx):
    before = snapshot(ctx)
    assert end(ctx.other, ctx.session_id, realistic_upload(ctx)).status_code == 404
    # 不屬於他的場次，連「上傳格式錯」都不該先告訴他：一律 404。
    assert end(ctx.other, ctx.session_id, {"questions": [{"question_key": "zz"}]}).status_code == 404
    assert snapshot(ctx) == before
    assert live_quiz.end_session(ctx.session_id, ctx.other.user_id, realistic_upload(ctx)) is None
    assert snapshot(ctx) == before


def test_end_route_notifies_students_and_closes_rooms(ctx, relay):
    teacher = relay.teacher(ctx.author, ctx.session_id)
    student = relay.student(ctx.token)
    assert teacher.is_connected(NS) and student.is_connected(NS)
    take(student)
    nonce = live_quiz._invitation_row(ctx.session_id)["join_nonce"]
    rooms = relay.socketio.server.manager.rooms
    assert live_quiz._teacher_room(nonce) in rooms.get(NS, {})
    assert live_quiz._student_room(nonce) in rooms.get(NS, {})

    response = end(ctx.author, ctx.session_id, realistic_upload(ctx))
    assert response.status_code == 200, response.get_json()
    assert take(student, "quiz:student-state") == [{"state": "ended"}]
    assert not student.is_connected(NS) and not teacher.is_connected(NS)
    assert live_quiz._teacher_room(nonce) not in rooms.get(NS, {})
    assert live_quiz._student_room(nonce) not in rooms.get(NS, {})
