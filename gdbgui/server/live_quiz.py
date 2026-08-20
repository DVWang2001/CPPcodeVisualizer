"""Persistent live-quiz state and strict lesson quiz validation."""

import json
import ipaddress
import logging
import re
import secrets
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
from typing import Optional
from urllib.parse import urlsplit

import qrcode
from flask import Blueprint, current_app, jsonify, render_template, request, url_for
from flask_socketio import emit, join_room
from itsdangerous import BadSignature, URLSafeSerializer
from qrcode.image.svg import SvgPathImage

from . import db
from .http_util import current_user_id, is_cross_origin


logger = logging.getLogger(__name__)


MAX_QUESTIONS = 30
MAX_PROMPT_LENGTH = 500
MAX_OPTION_LENGTH = 200
MAX_EXPLANATION_LENGTH = 1000
MAX_NICKNAME_LENGTH = 50
QUESTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

MAX_CELLS_CEILING = 200
MAX_CELL_LENGTH = 32

QUIZ_KEYS = frozenset(("schema_version", "questions"))
#: 兩種題型共用的鍵。`kind` 允許缺席：既有教案沒有這個欄位，缺席時視為 choice。
COMMON_QUESTION_KEYS = frozenset(("id", "prompt", "explanation", "trigger"))
CHOICE_QUESTION_KEYS = COMMON_QUESTION_KEYS | {"options", "correct_option_id"}
TABLE_QUESTION_KEYS = COMMON_QUESTION_KEYS | {"kind", "table_spec"}
TABLE_SPEC_KEYS = frozenset(("var_hint", "max_cells"))
OPTION_KEYS = frozenset(("id", "text"))
TRIGGER_KEYS = frozenset(("kind", "source_file", "line", "anchor"))
ANCHOR_KEYS = frozenset(("line_text", "before_text", "after_text"))
CREDENTIAL_HASH_RE = re.compile(r"\A[0-9a-f]{64}\Z")
GUEST_COOKIE = "gdbgui_quiz_guest"
GUEST_MAX_AGE = 8 * 60 * 60
TOKEN_SALT = "gdbgui-live-quiz-join-v1"

blueprint = Blueprint("live_quiz", __name__)
_socketio = None


class QuizRejected(ValueError):
    """Quiz data is malformed or does not belong to the requested resource."""


class QuizConflict(QuizRejected):
    """A valid request conflicts with the current live-session state."""


def validate_captured_table(raw: object, max_cells: int) -> dict:
    """驗證教師端送上來的表格快照。"""
    if not isinstance(raw, dict):
        raise QuizRejected("表格格式不正確。")
    if set(raw) != {"rows", "cols", "row_labels", "col_labels", "values"}:
        raise QuizRejected("表格含有未知欄位或缺少必要欄位。")

    rows, cols = raw["rows"], raw["cols"]
    for value in (rows, cols):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise QuizRejected("表格維度必須是正整數。")
    if rows * cols > max_cells:
        raise QuizRejected(f"表格有 {rows}×{cols}={rows * cols} 格，超過上限 {max_cells} 格。")

    values = raw["values"]
    if not isinstance(values, list) or len(values) != rows:
        raise QuizRejected("表格列數與內容不符。")
    normalized_values = []
    for index, row in enumerate(values):
        if not isinstance(row, list) or len(row) != cols:
            actual = len(row) if isinstance(row, list) else "?"
            raise QuizRejected(f"第 {index + 1} 列有 {actual} 格，與其他列不一致。")
        for cell in row:
            if not isinstance(cell, str):
                raise QuizRejected("表格內容必須是字串。")
            if len(cell) > MAX_CELL_LENGTH:
                raise QuizRejected(f"單格內容不可超過 {MAX_CELL_LENGTH} 字元。填表題只適用純量。")
        normalized_values.append(list(row))

    labels = {}
    for key, expected in (("row_labels", rows), ("col_labels", cols)):
        label = raw[key]
        if not isinstance(label, list) or len(label) != expected:
            raise QuizRejected("表格標籤數量與維度不符。")
        for text in label:
            if not isinstance(text, str) or len(text) > MAX_CELL_LENGTH:
                raise QuizRejected("表格標籤格式不正確。")
        labels[key] = list(label)

    return {"rows": rows, "cols": cols, "values": normalized_values, **labels}


def _table_cell_is_correct(given, expected):
    given = given.strip()
    return bool(given) and given == expected.strip()


def grade_table(answer, correct):
    """回傳 (答對格數, 總格數)；trim 後的非空字串才可能答對。"""
    right = sum(
        _table_cell_is_correct(answer[row_index][col_index], expected)
        for row_index, row in enumerate(correct)
        for col_index, expected in enumerate(row)
    )
    return right, sum(len(row) for row in correct)


def accumulate_cell_stats(stats, answer, correct):
    """把答錯的格子在列優先一維 stats 上 +1。"""
    cols = len(correct[0]) if correct else 0
    for row_index, row in enumerate(correct):
        for col_index, expected in enumerate(row):
            if not _table_cell_is_correct(answer[row_index][col_index], expected):
                stats[row_index * cols + col_index] += 1


def _exact_dict(value, keys, label, optional_keys=()):
    if not isinstance(value, dict):
        raise QuizRejected(f"{label}格式不正確。")
    actual = set(value)
    if actual - (keys | frozenset(optional_keys)):
        raise QuizRejected(f"{label}含有未知欄位。")
    if keys - actual:
        raise QuizRejected(f"{label}缺少必要欄位。")
    return value


def _text(value, label, minimum, maximum):
    if not isinstance(value, str):
        raise QuizRejected(f"{label}必須是文字。")
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise QuizRejected(f"{label}長度不正確。")
    return value


def _basename(path):
    if not isinstance(path, str):
        return ""
    return path.replace("\\", "/").rsplit("/", 1)[-1]


def _same_file(left, right):
    left_name, right_name = _basename(left), _basename(right)
    if not left_name or not right_name:
        return False
    if (
        "\\" in left
        or "\\" in right
        or re.match(r"^[A-Za-z]:[\\/]", left)
        or re.match(r"^[A-Za-z]:[\\/]", right)
    ):
        return left_name.casefold() == right_name.casefold()
    return left_name == right_name


def _source_line(line):
    return re.sub(r"\s+", " ", line.split("//@", 1)[0].strip())


def _anchor_at(lines, index):
    return {
        "line_text": lines[index] if 0 <= index < len(lines) else "",
        "before_text": lines[index - 1] if index > 0 else "",
        "after_text": lines[index + 1] if index + 1 < len(lines) else "",
    }


def _resolve_trigger(trigger, source_code):
    lines = [_source_line(line) for line in source_code.split("\n")]
    candidates = [
        index + 1
        for index, line in enumerate(lines)
        if line and _anchor_at(lines, index) == trigger["anchor"]
    ]
    if len(candidates) != 1:
        raise QuizRejected("程式碼錨點失效或不唯一，請重新綁定。")
    normalized = {
        "kind": "source_line",
        "source_file": _basename(trigger["source_file"]),
        "line": candidates[0],
        "anchor": dict(trigger["anchor"]),
    }
    return normalized


def validate_quiz_bundle(bundle: object) -> Optional[dict]:
    """Return a normalized quiz, or reject malformed quiz fields at the trust boundary."""
    if not isinstance(bundle, dict):
        raise QuizRejected("教案內容格式不正確。")
    raw = bundle.get("quiz")
    if raw is None:
        return None
    raw = _exact_dict(raw, QUIZ_KEYS, "題庫")
    if isinstance(raw["schema_version"], bool) or raw["schema_version"] != 1:
        raise QuizRejected("題庫版本必須是 1。")
    if not isinstance(raw["questions"], list) or len(raw["questions"]) > MAX_QUESTIONS:
        raise QuizRejected("題庫問題數不可超過 30 題。")
    if not raw["questions"]:
        return {"schema_version": 1, "questions": []}

    source_code = bundle.get("source_code")
    source_file = bundle.get("fullname_to_render")
    if not isinstance(source_code, str) or not isinstance(source_file, str) or not _basename(source_file):
        raise QuizRejected("含題目的教案必須有來源程式碼與來源檔案。")

    questions = []
    question_ids = set()
    resolved_triggers = set()
    for index, value in enumerate(raw["questions"]):
        label = f"第 {index + 1} 題"
        if not isinstance(value, dict):
            raise QuizRejected(f"{label}格式不正確。")
        kind = value.get("kind", "choice")
        if kind not in ("choice", "table"):
            raise QuizRejected(f"{label}題型不正確。")
        expected_keys = CHOICE_QUESTION_KEYS if kind == "choice" else TABLE_QUESTION_KEYS
        if kind == "choice":
            # 舊教案沒有 kind；新教案可以明寫 kind='choice'。兩者都要收。
            expected_keys = expected_keys | {"kind"} if "kind" in value else expected_keys
        question = _exact_dict(value, expected_keys, label)
        question_id = _text(question["id"], f"{label} ID", 1, db.MAX_BUNDLE_BYTES)
        if not QUESTION_ID_PATTERN.fullmatch(question_id):
            raise QuizRejected("題目 ID 只能使用英文字母、數字、底線與連字號。")
        if question_id in question_ids:
            raise QuizRejected("題目 ID 必須不重複。")
        question_ids.add(question_id)
        prompt = _text(question["prompt"], f"{label}題幹", 1, MAX_PROMPT_LENGTH)
        explanation = _text(
            question["explanation"], f"{label}解說", 0, MAX_EXPLANATION_LENGTH
        )

        options, correct_option_id, table_spec = None, None, None
        if kind == "choice":
            if not isinstance(question["options"], list) or not 2 <= len(question["options"]) <= 6:
                raise QuizRejected(f"{label}選項需有 2 至 6 個。")
            options, option_ids = [], set()
            for option_index, value in enumerate(question["options"]):
                option = _exact_dict(value, OPTION_KEYS, f"{label}第 {option_index + 1} 個選項")
                option_id = _text(option["id"], f"{label}選項 ID", 1, db.MAX_BUNDLE_BYTES)
                if option_id in option_ids:
                    raise QuizRejected(f"{label}選項 ID 必須不重複。")
                option_ids.add(option_id)
                options.append(
                    {
                        "id": option_id,
                        "text": _text(
                            option["text"], f"{label}選項", 1, MAX_OPTION_LENGTH
                        ),
                    }
                )
            correct_option_id = _text(
                question["correct_option_id"], f"{label}正解", 1, db.MAX_BUNDLE_BYTES
            )
            if correct_option_id not in option_ids:
                raise QuizRejected(f"{label}正解必須對應一個選項。")
        else:
            spec = _exact_dict(question["table_spec"], TABLE_SPEC_KEYS, f"{label}表格設定")
            var_hint = _text(spec["var_hint"], f"{label}變數提示", 0, 128)
            max_cells = spec["max_cells"]
            if isinstance(max_cells, bool) or not isinstance(max_cells, int):
                raise QuizRejected(f"{label}格數上限必須是整數。")
            if not 1 <= max_cells <= MAX_CELLS_CEILING:
                raise QuizRejected(f"{label}格數上限必須介於 1 與 {MAX_CELLS_CEILING} 之間。")
            table_spec = {"var_hint": var_hint, "max_cells": max_cells}

        trigger = _exact_dict(question["trigger"], TRIGGER_KEYS, f"{label}觸發器")
        if trigger["kind"] != "source_line":
            raise QuizRejected(f"{label}只支援 source_line 觸發器。")
        if not _same_file(trigger["source_file"], source_file):
            raise QuizRejected(f"{label}來源檔案與目前教案不符。")
        if (
            isinstance(trigger["line"], bool)
            or not isinstance(trigger["line"], int)
            or trigger["line"] <= 0
        ):
            raise QuizRejected(f"{label}行號必須是正整數。")
        anchor = _exact_dict(trigger["anchor"], ANCHOR_KEYS, f"{label}錨點")
        normalized_anchor = {}
        for key in ("line_text", "before_text", "after_text"):
            if not isinstance(anchor[key], str) or _source_line(anchor[key]) != anchor[key]:
                raise QuizRejected(f"{label}錨點文字必須已正規化。")
            normalized_anchor[key] = anchor[key]
        if not normalized_anchor["line_text"]:
            raise QuizRejected(f"{label}綁定行不可空白。")

        resolved = _resolve_trigger(
            {
                "source_file": trigger["source_file"],
                "anchor": normalized_anchor,
            },
            source_code,
        )
        trigger_key = (resolved["source_file"].casefold(), resolved["line"])
        if trigger_key in resolved_triggers:
            raise QuizRejected("同一程式碼行只能綁定一題。")
        resolved_triggers.add(trigger_key)
        normalized = {
            "id": question_id,
            "kind": kind,
            "prompt": prompt,
            "explanation": explanation,
            "trigger": resolved,
        }
        if kind == "choice":
            normalized["options"] = options
            normalized["correct_option_id"] = correct_option_id
        else:
            normalized["table_spec"] = table_spec
        questions.append(normalized)
    return {"schema_version": 1, "questions": questions}


def _valid_id(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and 0 < value <= db.SQLITE_MAX_INTEGER
    )


def student_question_payload(row) -> dict:
    """送給學生的題目內容；正解只在 closed 之後出現。"""
    payload = {
        "id": row["question_key"],
        "kind": row["kind"],
        "prompt": row["prompt"],
        "state": row["state"],
        "source_file": row["source_file"],
        "line": int(row["trigger_line"]),
    }
    closed = row["state"] == "closed"
    if closed:
        payload["explanation"] = row["explanation"]
    if row["kind"] == "choice":
        payload["options"] = json.loads(row["options_json"])
        if closed:
            payload["correct_option_id"] = row["correct_option_id"]
        return payload

    table = json.loads(row["correct_table_json"]) if row["correct_table_json"] else None
    if table is not None:
        payload.update(
            {
                "rows": table["rows"],
                "cols": table["cols"],
                "row_labels": table["row_labels"],
                "col_labels": table["col_labels"],
            }
        )
        if closed:
            payload["correct_values"] = table["values"]
    return payload


def _question_payload(row):
    payload = {
        "id": row["question_key"],
        "kind": row["kind"],
        "prompt": row["prompt"],
        "explanation": row["explanation"],
        "source_file": row["source_file"],
        "line": int(row["trigger_line"]),
        "anchor": json.loads(row["trigger_anchor_json"]),
        "position": int(row["position"]),
        "state": row["state"],
        "opened_at": row["opened_at"],
        "closed_at": row["closed_at"],
        "answer_count": int(row["answer_count"]),
        "correct_count": int(row["correct_count"]),
    }
    # 填表題沒有選項，options_json / correct_option_id / option_counts_json
    # 這三欄在資料庫裡是 NULL；無條件 json.loads 會直接 TypeError，開課即 500。
    if row["kind"] == "table":
        payload["table_spec"] = json.loads(row["table_spec_json"])
        table = json.loads(row["correct_table_json"]) if row["correct_table_json"] else None
        if table is not None:
            payload.update(
                {
                    "rows": table["rows"],
                    "cols": table["cols"],
                    "row_labels": table["row_labels"],
                    "col_labels": table["col_labels"],
                    "cell_stats": json.loads(row["cell_stats_json"]),
                    # 正解只給教師。這個 payload 只走 _teacher_payload（owner-only），
                    # 學生端走的是另一個函式 student_question_payload，那裡在 closed
                    # 之前不會出現正解。檢討個別作答時要靠它標出哪幾格錯。
                    "correct_values": table["values"],
                }
            )
    else:
        payload["options"] = json.loads(row["options_json"])
        payload["correct_option_id"] = row["correct_option_id"]
        payload["option_counts"] = json.loads(row["option_counts_json"])
    return payload


def _session_row(conn, session_id, owner_id=None):
    sql = (
        "SELECT s.*, v.version AS lesson_version FROM live_quiz_sessions s "
        "LEFT JOIN lesson_versions v ON v.id=s.lesson_version_id WHERE s.id=?"
    )
    params = [session_id]
    if owner_id is not None:
        sql += " AND s.owner_user_id=?"
        params.append(owner_id)
    return conn.execute(sql, params).fetchone()


def _session_payload(conn, row):
    questions = [
        _question_payload(question)
        for question in conn.execute(
            "SELECT * FROM live_quiz_questions WHERE session_id=? ORDER BY position",
            (row["id"],),
        )
    ]
    active = next((question for question in questions if question["state"] == "open"), None)
    joined_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?", (row["id"],)
        ).fetchone()[0]
    )
    return {
        "id": int(row["id"]),
        "lesson_id": int(row["lesson_id"]),
        "lesson_version_id": (
            int(row["lesson_version_id"]) if row["lesson_version_id"] is not None else None
        ),
        "lesson_version": (
            int(row["lesson_version"]) if row["lesson_version"] is not None else None
        ),
        "owner_id": int(row["owner_user_id"]),
        "title": row["title"],
        "state": row["state"],
        "created_at": row["created_at"],
        "ended_at": row["ended_at"],
        "joined_count": joined_count,
        "active_question": active,
        "questions": questions,
    }


def session_owned_by(session_id: int, owner_id: int) -> Optional[dict]:
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    with closing(db.connect()) as conn:
        row = _session_row(conn, session_id, owner_id)
        return _session_payload(conn, row) if row is not None else None


def create_session(owner_id: int, lesson_id: int) -> Optional[dict]:
    if not _valid_id(owner_id) or not _valid_id(lesson_id):
        return None
    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            lesson = conn.execute(
                "SELECT l.id, l.user_id, v.id AS version_id, v.version, v.title, v.bundle_json "
                "FROM lessons l "
                "JOIN lesson_current_versions cv ON cv.lesson_id=l.id "
                "JOIN lesson_versions v ON v.id=cv.version_id "
                "WHERE l.id=? AND l.user_id=?",
                (lesson_id, owner_id),
            ).fetchone()
            if lesson is None:
                conn.commit()
                return None
            try:
                bundle = json.loads(lesson["bundle_json"])
            except (TypeError, ValueError) as exc:
                raise QuizRejected("教案題庫不是有效的 JSON。") from exc
            quiz = validate_quiz_bundle(bundle)
            if quiz is None or not quiz["questions"]:
                raise QuizRejected("開始課堂前至少需要一題。")

            now = db._now()
            session = conn.execute(
                "INSERT INTO live_quiz_sessions "
                "(lesson_id, lesson_version_id, owner_user_id, title, join_nonce, state, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'lobby', ?)",
                (
                    lesson_id,
                    lesson["version_id"],
                    owner_id,
                    lesson["title"],
                    secrets.token_urlsafe(24),
                    now,
                ),
            )
            session_id = int(session.lastrowid)
            for position, question in enumerate(quiz["questions"]):
                trigger = question["trigger"]
                conn.execute(
                    "INSERT INTO live_quiz_questions "
                    "(session_id, question_key, kind, prompt, explanation, source_file, "
                    " trigger_line, trigger_anchor_json, position, state, "
                    " options_json, correct_option_id, option_counts_json, table_spec_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)",
                    (
                        session_id,
                        question["id"],
                        question["kind"],
                        question["prompt"],
                        question["explanation"],
                        trigger["source_file"],
                        trigger["line"],
                        json.dumps(trigger["anchor"], ensure_ascii=False, separators=(",", ":")),
                        position,
                        json.dumps(question["options"], ensure_ascii=False, separators=(",", ":")) if question["kind"] == "choice" else None,
                        question["correct_option_id"] if question["kind"] == "choice" else None,
                        json.dumps({option["id"]: 0 for option in question["options"]}, ensure_ascii=False, separators=(",", ":")) if question["kind"] == "choice" else None,
                        json.dumps(question["table_spec"], ensure_ascii=False, separators=(",", ":")) if question["kind"] == "table" else None,
                    ),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return session_owned_by(session_id, owner_id)


def _persist_table_hint(session_id: int, owner_id: int, question_key: str, var_hint: str) -> None:
    with closing(db.connect()) as conn:
        snapshot = conn.execute(
            "SELECT s.lesson_id, v.version, v.title, v.bundle_json "
            "FROM live_quiz_sessions s JOIN lesson_versions v ON v.id=s.lesson_version_id "
            "WHERE s.id=? AND s.owner_user_id=?",
            (session_id, owner_id),
        ).fetchone()
    if snapshot is None:
        return
    bundle = json.loads(snapshot["bundle_json"])
    questions = bundle.get("quiz", {}).get("questions", [])
    question = next((item for item in questions if item.get("id") == question_key), None)
    if question is None or question.get("kind") != "table":
        return
    if question["table_spec"]["var_hint"] == var_hint:
        return
    question["table_spec"]["var_hint"] = var_hint
    try:
        db.update_lesson_owned_by(
            int(snapshot["lesson_id"]),
            owner_id,
            snapshot["title"],
            json.dumps(bundle, ensure_ascii=False, separators=(",", ":")),
            parent_version=int(snapshot["version"]),
            expected_current_version=int(snapshot["version"]),
        )
    except db.LessonRejected as exc:
        logger.warning("[live quiz] could not persist table hint: %s", exc)


def trigger_question(
    session_id: int,
    owner_id: int,
    question_key: str,
    source_file: str,
    line: int,
    table=None,
    var_hint=None,
) -> Optional[dict]:
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    if not isinstance(question_key, str) or not question_key:
        raise QuizRejected("缺少題目 ID。")
    hint_to_persist = None
    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            session = _session_row(conn, session_id, owner_id)
            if session is None or session["state"] != "lobby":
                conn.commit()
                return None
            question = conn.execute(
                "SELECT * FROM live_quiz_questions WHERE session_id=? AND question_key=?",
                (session_id, question_key),
            ).fetchone()
            if question is None:
                conn.commit()
                return None
            if (
                isinstance(line, bool)
                or not isinstance(line, int)
                or line != int(question["trigger_line"])
                or not isinstance(source_file, str)
                or not _same_file(question["source_file"], source_file)
            ):
                raise QuizRejected("觸發位置與題目錨點不符。")
            if question["state"] == "ready":
                other = conn.execute(
                    "SELECT 1 FROM live_quiz_questions "
                    "WHERE session_id=? AND state='open' AND question_key<>?",
                    (session_id, question_key),
                ).fetchone()
                if other is not None:
                    raise QuizConflict("上一題尚未結束作答。")
                if question["kind"] == "table":
                    spec = json.loads(question["table_spec_json"])
                    captured = validate_captured_table(table, spec["max_cells"])
                    cell_stats = [0] * (captured["rows"] * captured["cols"])
                    new_hint = var_hint if isinstance(var_hint, str) else spec["var_hint"]
                    if len(new_hint) > 128:
                        raise QuizRejected("變數提示過長。")
                    conn.execute(
                        "UPDATE live_quiz_questions SET correct_table_json=?, cell_stats_json=?, "
                        "table_spec_json=? WHERE id=?",
                        (
                            json.dumps(captured, ensure_ascii=False),
                            json.dumps(cell_stats),
                            json.dumps({**spec, "var_hint": new_hint}, ensure_ascii=False),
                            question["id"],
                        ),
                    )
                    if new_hint != spec["var_hint"]:
                        hint_to_persist = new_hint
                conn.execute(
                    "UPDATE live_quiz_questions SET state='open', opened_at=? WHERE id=?",
                    (db._now(), question["id"]),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    if hint_to_persist is not None:
        _persist_table_hint(session_id, owner_id, question_key, hint_to_persist)
    return session_owned_by(session_id, owner_id)


def close_question(session_id: int, owner_id: int, question_key: str) -> Optional[dict]:
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            session = _session_row(conn, session_id, owner_id)
            if session is None or session["state"] != "lobby":
                conn.commit()
                return None
            question = conn.execute(
                "SELECT id, state FROM live_quiz_questions WHERE session_id=? AND question_key=?",
                (session_id, question_key),
            ).fetchone()
            if question is None:
                conn.commit()
                return None
            if question["state"] == "ready":
                raise QuizConflict("題目尚未開放。")
            if question["state"] == "open":
                conn.execute(
                    "UPDATE live_quiz_questions SET state='closed', closed_at=? WHERE id=?",
                    (db._now(), question["id"]),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return session_owned_by(session_id, owner_id)



def responses_for_question(session_id: int, owner_id: int, question_key: str):
    """收卷後，教師檢視每位學生的填表作答。

    三道守衛，少一道這個功能就從教學工具變成外洩面：

      * **擁有者**——只有開這堂課的人看得到。
      * **題型是 table**——單選題不做這個畫面，選項分布已經說完了。
      * **狀態是 closed**——收卷前不得外露個別作答：其他人還在寫，而老師此刻也不需要看。

    排序把答對最少的排最前面：教師要檢討的就是那幾份。

    ⚠️ `end_session()` 會刪光 responses 與 participants，所以這份資料只在課堂還開著的
    時候存在。課後檢討需要另一套保留機制，那會再次動到資料邊界。
    """
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    with closing(db.connect()) as conn:
        if _session_row(conn, session_id, owner_id) is None:
            return None
        question = conn.execute(
            "SELECT id, kind, state FROM live_quiz_questions "
            "WHERE session_id=? AND question_key=?",
            (session_id, question_key),
        ).fetchone()
        if question is None:
            return None
        if question["kind"] != "table" or question["state"] != "closed":
            raise QuizConflict("這一題沒有可檢視的個別作答。")
        rows = conn.execute(
            "SELECT p.nickname, r.answer_json, r.correct_cells, r.total_cells "
            "FROM live_quiz_responses r "
            "JOIN live_quiz_participants p ON p.id = r.participant_id "
            "WHERE r.question_id=? ORDER BY r.correct_cells ASC, p.nickname ASC",
            (question["id"],),
        ).fetchall()
    return [
        {
            "nickname": row["nickname"],
            "answer": json.loads(row["answer_json"]) if row["answer_json"] else None,
            "correct_cells": row["correct_cells"],
            "total_cells": row["total_cells"],
        }
        for row in rows
    ]

def end_session(session_id: int, owner_id: int) -> Optional[dict]:
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            session = _session_row(conn, session_id, owner_id)
            if session is None or session["state"] != "lobby":
                conn.commit()
                return None
            now = db._now()
            conn.execute(
                "UPDATE live_quiz_sessions SET state='ended', ended_at=? WHERE id=?",
                (now, session_id),
            )
            conn.execute(
                "UPDATE live_quiz_questions SET state='closed', closed_at=? "
                "WHERE session_id=? AND state='open'",
                (now, session_id),
            )
            conn.execute(
                "DELETE FROM live_quiz_responses WHERE question_id IN "
                "(SELECT id FROM live_quiz_questions WHERE session_id=?)",
                (session_id,),
            )
            conn.execute("DELETE FROM live_quiz_participants WHERE session_id=?", (session_id,))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return session_owned_by(session_id, owner_id)


def join_session(session_id: int, nickname: str, credential_hash: str) -> dict:
    if not _valid_id(session_id):
        raise QuizConflict("課堂不存在或已結束。")
    nickname = _text(nickname, "暱稱", 1, MAX_NICKNAME_LENGTH)
    if any(ord(character) < 32 or ord(character) == 127 for character in nickname):
        raise QuizRejected("暱稱不可含控制字元。")
    if not isinstance(credential_hash, str) or CREDENTIAL_HASH_RE.fullmatch(credential_hash) is None:
        raise QuizRejected("裝置憑證格式不正確。")

    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            session = _session_row(conn, session_id)
            if session is None or session["state"] != "lobby":
                raise QuizConflict("課堂不存在或已結束。")
            existing = conn.execute(
                "SELECT id, session_id, nickname FROM live_quiz_participants "
                "WHERE credential_hash=?",
                (credential_hash,),
            ).fetchone()
            now = db._now()
            if existing is not None:
                if int(existing["session_id"]) != session_id:
                    raise QuizConflict("這個裝置憑證已用於其他課堂。")
                conn.execute(
                    "UPDATE live_quiz_participants SET last_seen_at=? WHERE id=?",
                    (now, existing["id"]),
                )
                participant_id = int(existing["id"])
                nickname = existing["nickname"]
            else:
                participant = conn.execute(
                    "INSERT INTO live_quiz_participants "
                    "(session_id, nickname, credential_hash, created_at, last_seen_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (session_id, nickname, credential_hash, now, now),
                )
                participant_id = int(participant.lastrowid)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return {"participant_id": participant_id, "session_id": session_id, "nickname": nickname}


def _stats_from_row(row):
    stats = {
        "answer_count": int(row["answer_count"]),
        "correct_count": int(row["correct_count"]),
    }
    key = "cell_stats" if row["kind"] == "table" else "option_counts"
    column = "cell_stats_json" if row["kind"] == "table" else "option_counts_json"
    stats[key] = json.loads(row[column])
    return stats


def answer_question(credential_hash: str, question_key: str, option_id: str) -> dict:
    if not isinstance(credential_hash, str) or CREDENTIAL_HASH_RE.fullmatch(credential_hash) is None:
        raise QuizRejected("裝置憑證格式不正確。")
    if not isinstance(question_key, str) or not question_key:
        raise QuizRejected("缺少題目 ID。")
    if not isinstance(option_id, str) or not option_id:
        raise QuizRejected("缺少答案選項。")

    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT p.id AS participant_id, s.state AS session_state, q.* "
                "FROM live_quiz_participants p "
                "JOIN live_quiz_sessions s ON s.id=p.session_id "
                "JOIN live_quiz_questions q ON q.session_id=p.session_id "
                "WHERE p.credential_hash=? AND q.question_key=?",
                (credential_hash, question_key),
            ).fetchone()
            if row is None:
                raise QuizConflict("找不到可作答的題目。")
            if row["kind"] != "choice":
                raise QuizRejected("作答格式與題型不符。")
            existing = conn.execute(
                "SELECT selected_option_id, is_correct FROM live_quiz_responses "
                "WHERE participant_id=? AND question_id=?",
                (row["participant_id"], row["id"]),
            ).fetchone()
            if existing is not None:
                conn.commit()
                return {
                    "inserted": False,
                    "selected_option_id": existing["selected_option_id"],
                    "is_correct": bool(existing["is_correct"]),
                    "stats": _stats_from_row(row),
                }
            if row["session_state"] != "lobby" or row["state"] != "open":
                raise QuizConflict("這一題目前未開放作答。")

            option_ids = {option["id"] for option in json.loads(row["options_json"])}
            if option_id not in option_ids:
                raise QuizRejected("答案選項不存在。")
            is_correct = option_id == row["correct_option_id"]
            counts = json.loads(row["option_counts_json"])
            counts[option_id] += 1
            answer_count = int(row["answer_count"]) + 1
            correct_count = int(row["correct_count"]) + int(is_correct)
            conn.execute(
                "INSERT INTO live_quiz_responses "
                "(participant_id, question_id, selected_option_id, is_correct, answered_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (row["participant_id"], row["id"], option_id, int(is_correct), db._now()),
            )
            conn.execute(
                "UPDATE live_quiz_questions SET answer_count=?, correct_count=?, "
                "option_counts_json=? WHERE id=?",
                (
                    answer_count,
                    correct_count,
                    json.dumps(counts, ensure_ascii=False, separators=(",", ":")),
                    row["id"],
                ),
            )
            conn.commit()
            return {
                "inserted": True,
                "selected_option_id": option_id,
                "is_correct": is_correct,
                "stats": {
                    "answer_count": answer_count,
                    "correct_count": correct_count,
                    "option_counts": counts,
                },
            }
        except BaseException:
            conn.rollback()
            raise


def answer_table_question(credential_hash: str, question_key: str, answer) -> dict:
    if not isinstance(credential_hash, str) or CREDENTIAL_HASH_RE.fullmatch(credential_hash) is None:
        raise QuizRejected("裝置憑證格式不正確。")
    if not isinstance(question_key, str) or not question_key:
        raise QuizRejected("缺少題目 ID。")

    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT p.id AS participant_id, s.state AS session_state, q.* "
                "FROM live_quiz_participants p "
                "JOIN live_quiz_sessions s ON s.id=p.session_id "
                "JOIN live_quiz_questions q ON q.session_id=p.session_id "
                "WHERE p.credential_hash=? AND q.question_key=?",
                (credential_hash, question_key),
            ).fetchone()
            if row is None:
                raise QuizConflict("找不到可作答的題目。")
            if row["kind"] != "table":
                raise QuizRejected("作答格式與題型不符。")
            existing = conn.execute(
                "SELECT answer_json, correct_cells, total_cells FROM live_quiz_responses "
                "WHERE participant_id=? AND question_id=?",
                (row["participant_id"], row["id"]),
            ).fetchone()
            if existing is not None:
                conn.commit()
                return {
                    "inserted": False,
                    "correct_cells": int(existing["correct_cells"]),
                    "total_cells": int(existing["total_cells"]),
                    "stats": _stats_from_row(row),
                }
            if row["session_state"] != "lobby" or row["state"] != "open":
                raise QuizConflict("這一題目前未開放作答。")

            correct = json.loads(row["correct_table_json"])
            if not isinstance(answer, list) or len(answer) != correct["rows"]:
                raise QuizRejected("作答的表格維度與題目不符。")
            for line in answer:
                if not isinstance(line, list) or len(line) != correct["cols"]:
                    raise QuizRejected("作答的表格維度與題目不符。")
                if any(not isinstance(cell, str) for cell in line):
                    raise QuizRejected("表格內容必須是字串。")
            answer = [[cell[:MAX_CELL_LENGTH] for cell in line] for line in answer]
            right, total = grade_table(answer, correct["values"])
            cell_stats = json.loads(row["cell_stats_json"])
            accumulate_cell_stats(cell_stats, answer, correct["values"])
            answer_count = int(row["answer_count"]) + 1
            correct_count = int(row["correct_count"]) + int(right == total)

            conn.execute(
                "INSERT INTO live_quiz_responses "
                "(participant_id, question_id, answered_at, answer_json, correct_cells, total_cells) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    row["participant_id"],
                    row["id"],
                    db._now(),
                    json.dumps(answer, ensure_ascii=False),
                    right,
                    total,
                ),
            )
            conn.execute(
                "UPDATE live_quiz_questions SET answer_count=?, correct_count=?, "
                "cell_stats_json=? WHERE id=?",
                (answer_count, correct_count, json.dumps(cell_stats), row["id"]),
            )
            conn.commit()
            return {
                "inserted": True,
                "correct_cells": right,
                "total_cells": total,
                "stats": {
                    "answer_count": answer_count,
                    "correct_count": correct_count,
                    "cell_stats": cell_stats,
                },
            }
        except BaseException:
            conn.rollback()
            raise


def guest_state(credential_hash: str) -> Optional[dict]:
    if not isinstance(credential_hash, str) or CREDENTIAL_HASH_RE.fullmatch(credential_hash) is None:
        return None
    with closing(db.connect()) as conn:
        participant = conn.execute(
            "SELECT p.id, p.session_id, p.nickname, s.title, s.state "
            "FROM live_quiz_participants p "
            "JOIN live_quiz_sessions s ON s.id=p.session_id "
            "WHERE p.credential_hash=? AND s.state='lobby'",
            (credential_hash,),
        ).fetchone()
        if participant is None:
            return None
        question = conn.execute(
            "SELECT q.*, r.selected_option_id, r.is_correct, r.answer_json, "
            "r.correct_cells, r.total_cells "
            "FROM live_quiz_questions q "
            "LEFT JOIN live_quiz_responses r ON r.question_id=q.id AND r.participant_id=? "
            "WHERE q.session_id=? AND q.state IN ('open', 'closed') AND q.opened_at IS NOT NULL "
            "ORDER BY CASE q.state WHEN 'open' THEN 0 ELSE 1 END, q.opened_at DESC LIMIT 1",
            (participant["id"], participant["session_id"]),
        ).fetchone()
        active = None
        if question is not None:
            active = student_question_payload(question)
            if question["kind"] == "choice":
                active["selected_option_id"] = question["selected_option_id"]
            else:
                active["answer"] = (
                    json.loads(question["answer_json"])
                    if question["answer_json"] is not None
                    else None
                )
            if question["state"] == "closed" and question["kind"] == "choice":
                active["result"] = {
                    "is_correct": (
                        bool(question["is_correct"])
                        if question["selected_option_id"] is not None
                        else None
                    ),
                    "correct_option_id": active.pop("correct_option_id"),
                    "explanation": active.pop("explanation"),
                }
            elif question["state"] == "closed":
                active["result"] = {
                    "correct_cells": (
                        int(question["correct_cells"])
                        if question["answer_json"] is not None
                        else None
                    ),
                    "total_cells": (
                        int(question["total_cells"])
                        if question["answer_json"] is not None
                        else None
                    ),
                    "explanation": active.pop("explanation"),
                }
        return {
            "participant_id": int(participant["id"]),
            "session_id": int(participant["session_id"]),
            "session_title": participant["title"],
            "nickname": participant["nickname"],
            "state": "active",
            "active_question": active,
        }


def validated_mobile_base_url(value):
    """Return a public/LAN HTTP origin suitable for a phone-scannable join URL."""
    if not isinstance(value, str) or not value:
        raise QuizRejected("尚未設定手機可連線網址。")
    try:
        parsed = urlsplit(value)
        parsed.port  # Force validation of malformed ports.
    except ValueError:
        raise QuizRejected("手機連線網址必須是可連線的 HTTP(S) 網址。")
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
    except ValueError:
        address = None
    hostname = (parsed.hostname or "").casefold()
    if (
        parsed.scheme not in ("http", "https")
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or hostname == "localhost"
        or hostname.endswith(".localhost")
        or (address is not None and (address.is_loopback or address.is_unspecified))
    ):
        raise QuizRejected("手機連線網址必須是可連線的 HTTP(S) 網址。")
    return value.rstrip("/")


def _serializer():
    return URLSafeSerializer(current_app.secret_key, salt=TOKEN_SALT)


def _invitation_row(session_id, owner_id=None):
    with closing(db.connect()) as conn:
        return _session_row(conn, session_id, owner_id)


def make_join_token(session_row):
    return _serializer().dumps(
        {"session_id": int(session_row["id"]), "join_nonce": session_row["join_nonce"]}
    )


def load_join_token(token, max_age=GUEST_MAX_AGE):
    if not isinstance(token, str) or not token:
        return None
    try:
        payload = _serializer().loads(token)
    except BadSignature:
        return None
    if not isinstance(payload, dict):
        return None
    session_id, nonce = payload.get("session_id"), payload.get("join_nonce")
    if not _valid_id(session_id) or not isinstance(nonce, str) or not nonce:
        return None
    with closing(db.connect()) as conn:
        found = conn.execute(
            "SELECT id, created_at FROM live_quiz_sessions "
            "WHERE id=? AND join_nonce=? AND state='lobby'",
            (session_id, nonce),
        ).fetchone()
    if found is None:
        return None
    try:
        created_at = datetime.fromisoformat(found["created_at"])
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - created_at).total_seconds()
    except (TypeError, ValueError):
        return None
    if not isinstance(max_age, (int, float)) or age < 0 or age > max_age:
        return None
    return int(found["id"])


def _join_url(row):
    base = validated_mobile_base_url(current_app.config.get("MOBILE_JOIN_BASE_URL"))
    return base + url_for("live_quiz.join_page", token=make_join_token(row))


def _teacher_payload(session_id, owner_id):
    row = _invitation_row(session_id, owner_id)
    if row is None or row["state"] != "lobby":
        return None
    payload = session_owned_by(session_id, owner_id)
    payload["join_url"] = _join_url(row)
    payload["qr_url"] = url_for("live_quiz.qr_image", session_id=session_id)
    return payload


def _request_fields(keys, label="請求", optional_keys=()):
    return _exact_dict(
        request.get_json(silent=True), frozenset(keys), label, optional_keys
    )


def _error(message, status):
    return jsonify({"error": message}), status


@blueprint.post("/api/live-quiz/sessions")
def create_session_route():
    try:
        body = _request_fields(("lesson_id",))
        validated_mobile_base_url(current_app.config.get("MOBILE_JOIN_BASE_URL"))
        created = create_session(current_user_id(), body["lesson_id"])
        if created is None:
            return _error("找不到教案。", 404)
        return jsonify(_teacher_payload(created["id"], current_user_id())), 201
    except QuizRejected as exc:
        return _error(str(exc), 400)


@blueprint.get("/api/live-quiz/sessions/<int:session_id>")
def teacher_state(session_id):
    payload = _teacher_payload(session_id, current_user_id())
    return jsonify(payload) if payload is not None else _error("找不到課堂。", 404)


@blueprint.post(
    "/api/live-quiz/sessions/<int:session_id>/questions/<question_key>/trigger"
)
def trigger_question_route(session_id, question_key):
    try:
        body = _request_fields(
            ("source_file", "line"), optional_keys=("table", "var_hint")
        )
        updated = trigger_question(
            session_id,
            current_user_id(),
            question_key,
            body["source_file"],
            body["line"],
            table=body.get("table"),
            var_hint=body.get("var_hint"),
        )
        if updated is None:
            return _error("找不到課堂或題目。", 404)
        emit_teacher_state(session_id)
        emit_student_states(session_id)
        return jsonify(_teacher_payload(session_id, current_user_id()))
    except QuizConflict as exc:
        return _error(str(exc), 409)
    except QuizRejected as exc:
        return _error(str(exc), 400)


@blueprint.post(
    "/api/live-quiz/sessions/<int:session_id>/questions/<question_key>/close"
)
def close_question_route(session_id, question_key):
    try:
        updated = close_question(session_id, current_user_id(), question_key)
        if updated is None:
            return _error("找不到課堂或題目。", 404)
        emit_teacher_state(session_id)
        emit_student_states(session_id)
        return jsonify(_teacher_payload(session_id, current_user_id()))
    except QuizConflict as exc:
        return _error(str(exc), 409)



@blueprint.get(
    "/api/live-quiz/sessions/<int:session_id>/questions/<question_key>/responses"
)
def question_responses_route(session_id, question_key):
    try:
        rows = responses_for_question(session_id, current_user_id(), question_key)
        if rows is None:
            return _error("找不到課堂或題目。", 404)
        return jsonify({"responses": rows})
    except QuizConflict as exc:
        return _error(str(exc), 409)

@blueprint.post("/api/live-quiz/sessions/<int:session_id>/end")
def end_session_route(session_id):
    row = _invitation_row(session_id, current_user_id())
    participant_credentials = _participant_credentials(session_id)
    ended = end_session(session_id, current_user_id())
    if ended is not None:
        emit_teacher_state(session_id)
        _emit_ended(participant_credentials)
        if _socketio is not None and _socketio.server is not None and row is not None:
            _socketio.close_room(
                _teacher_room(row["join_nonce"]), namespace="/lesson_quiz"
            )
    return jsonify(ended) if ended is not None else _error("找不到課堂。", 404)


@blueprint.get("/api/live-quiz/sessions/<int:session_id>/qr.svg")
def qr_image(session_id):
    row = _invitation_row(session_id, current_user_id())
    if row is None or row["state"] != "lobby":
        return _error("找不到課堂。", 404)
    output = BytesIO()
    qrcode.make(_join_url(row), image_factory=SvgPathImage).save(output)
    response = current_app.response_class(output.getvalue(), mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "no-store"
    return response


@blueprint.get("/join/<token>")
def join_page(token):
    session_id = load_join_token(token)
    row = _invitation_row(session_id) if session_id is not None else None
    if row is None:
        return _error("課堂不存在或已結束。", 404)
    return render_template(
        "quiz_join.html",
        session_title=row["title"],
        initial_data={"token": token, "session_title": row["title"]},
    )


def _cookie_hash():
    return hash_guest_cookie(request.cookies.get(GUEST_COOKIE))


def hash_guest_cookie(credential):
    if not isinstance(credential, str) or not credential:
        return None
    return sha256(credential.encode("utf-8")).hexdigest()


@blueprint.post("/api/live-quiz/guest/join")
def guest_join():
    try:
        body = _request_fields(("token", "nickname"))
        session_id = load_join_token(body["token"])
        if session_id is None:
            return _error("課堂不存在或已結束。", 404)

        credential = request.cookies.get(GUEST_COOKIE)
        credential_hash = _cookie_hash()
        if credential_hash is not None:
            with closing(db.connect()) as conn:
                same_session = conn.execute(
                    "SELECT 1 FROM live_quiz_participants "
                    "WHERE credential_hash=? AND session_id=?",
                    (credential_hash, session_id),
                ).fetchone()
            if same_session is None:
                credential = credential_hash = None
        if credential_hash is None:
            credential = secrets.token_urlsafe(32)
            credential_hash = sha256(credential.encode("utf-8")).hexdigest()

        join_session(session_id, body["nickname"], credential_hash)
        state = guest_state(credential_hash)
        if state is None:
            return _error("課堂不存在或已結束。", 409)
        response = jsonify(state)
        response.set_cookie(
            GUEST_COOKIE,
            credential,
            max_age=GUEST_MAX_AGE,
            httponly=True,
            secure=bool(current_app.config.get("SESSION_COOKIE_SECURE")),
            samesite="Lax",
            path="/",
        )
        emit_teacher_state(session_id)
        return response
    except QuizConflict as exc:
        return _error(str(exc), 409)
    except QuizRejected as exc:
        return _error(str(exc), 400)


@blueprint.get("/api/live-quiz/guest/state")
def guest_state_route():
    state = guest_state(_cookie_hash())
    return jsonify(state) if state is not None else _error("找不到參與者。", 404)


@blueprint.post("/api/live-quiz/guest/answers")
def guest_answer():
    credential_hash = _cookie_hash()
    if credential_hash is None:
        return _error("找不到參與者。", 404)
    try:
        body = _request_fields(
            ("question_id",), optional_keys=("option_id", "answer")
        )
        has_option = "option_id" in body
        has_table = "answer" in body
        if has_option == has_table:
            raise QuizRejected("作答必須且只能提供一種答案格式。")
        if has_option:
            answer_question(credential_hash, body["question_id"], body["option_id"])
        else:
            answer_table_question(credential_hash, body["question_id"], body["answer"])
        state = guest_state(credential_hash)
        if state is None:
            return _error("課堂不存在或已結束。", 409)
        emit_teacher_state(state["session_id"])
        emit_student_state(credential_hash)
        return jsonify(state)
    except QuizConflict as exc:
        return _error(str(exc), 409)
    except QuizRejected as exc:
        return _error(str(exc), 400)


def _teacher_room(join_nonce):
    return f"lesson_quiz:teacher:{join_nonce}"


def _participant_room(credential_hash):
    return f"lesson_quiz:participant:{credential_hash}"


def _latest_question(state):
    opened = [question for question in state["questions"] if question["opened_at"]]
    return max(opened, key=lambda question: question["opened_at"]) if opened else None


def _socket_stats_payload(state, question):
    payload = {
        "joined_count": state["joined_count"],
        "question_id": question["id"],
        "state": question["state"],
        "answer_count": question["answer_count"],
        "correct_count": question["correct_count"],
    }
    key = "cell_stats" if question["kind"] == "table" else "option_counts"
    payload[key] = question[key]
    return payload


def emit_teacher_state(session_id):
    if _socketio is None or _socketio.server is None:
        return
    row = _invitation_row(session_id)
    if row is None:
        return
    owner_id = int(row["owner_user_id"])
    state = _teacher_payload(session_id, owner_id) or session_owned_by(session_id, owner_id)
    if state is None:
        return
    room = _teacher_room(row["join_nonce"])
    _socketio.emit("quiz:teacher-state", state, room=room, namespace="/lesson_quiz")
    question = state["active_question"] or _latest_question(state)
    if question is not None:
        _socketio.emit(
            "quiz:stats",
            _socket_stats_payload(state, question),
            room=room,
            namespace="/lesson_quiz",
        )


def emit_student_state(credential_hash):
    if _socketio is None or _socketio.server is None:
        return
    state = guest_state(credential_hash)
    if state is not None:
        _socketio.emit(
            "quiz:student-state",
            state,
            room=_participant_room(credential_hash),
            namespace="/lesson_quiz",
        )


def emit_student_states(session_id):
    if _socketio is None or _socketio.server is None:
        return
    with closing(db.connect()) as conn:
        credentials = [
            row["credential_hash"]
            for row in conn.execute(
                "SELECT credential_hash FROM live_quiz_participants WHERE session_id=?",
                (session_id,),
            )
        ]
    for credential_hash in credentials:
        emit_student_state(credential_hash)


def _participant_credentials(session_id):
    with closing(db.connect()) as conn:
        return [
            row["credential_hash"]
            for row in conn.execute(
                "SELECT credential_hash FROM live_quiz_participants WHERE session_id=?",
                (session_id,),
            )
        ]


def _emit_ended(participant_credentials):
    if _socketio is None or _socketio.server is None:
        return
    for credential_hash in participant_credentials:
        room = _participant_room(credential_hash)
        _socketio.emit(
            "quiz:student-state",
            {"state": "ended"},
            room=room,
            namespace="/lesson_quiz",
        )
        _socketio.close_room(room, namespace="/lesson_quiz")


def register_socket_handlers(socketio):
    global _socketio
    _socketio = socketio
    if getattr(socketio, "_live_quiz_handlers_registered", False):
        return
    socketio._live_quiz_handlers_registered = True

    @socketio.on("connect", namespace="/lesson_quiz")
    def connect_live_quiz(auth=None):
        if is_cross_origin(request):
            return False
        auth = auth if isinstance(auth, dict) else {}
        if auth.get("role") == "teacher":
            owner_id = current_user_id()
            row = _invitation_row(auth.get("session_id"), owner_id)
            state = _teacher_payload(auth.get("session_id"), owner_id)
            if row is None or state is None or state["state"] != "lobby":
                return False
            join_room(_teacher_room(row["join_nonce"]))
            emit("quiz:teacher-state", state)
            question = state["active_question"] or _latest_question(state)
            if question is not None:
                emit(
                    "quiz:stats",
                    _socket_stats_payload(state, question),
                )
            return True

        credential_hash = _cookie_hash()
        state = guest_state(credential_hash)
        if state is None:
            return False
        join_room(_participant_room(credential_hash))
        emit("quiz:student-state", state)
        return True
