"""Persistent live-quiz state and strict lesson quiz validation."""

import itertools
import json
import ipaddress
import logging
import re
import secrets
import unicodedata
from contextlib import closing
from datetime import datetime, timedelta, timezone
from io import BytesIO
from time import monotonic
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
QUESTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

MAX_CELLS_CEILING = 200

QUIZ_KEYS = frozenset(("schema_version", "questions"))
#: 兩種題型共用的鍵。`kind` 允許缺席：既有教案沒有這個欄位，缺席時視為 choice。
COMMON_QUESTION_KEYS = frozenset(("id", "prompt", "explanation", "trigger"))
CHOICE_QUESTION_KEYS = COMMON_QUESTION_KEYS | {"options", "correct_option_id"}
TABLE_QUESTION_KEYS = COMMON_QUESTION_KEYS | {"kind", "table_spec"}
TABLE_SPEC_KEYS = frozenset(("var_hint", "max_cells"))
OPTION_KEYS = frozenset(("id", "text"))
TRIGGER_KEYS = frozenset(("kind", "source_file", "line", "anchor"))
ANCHOR_KEYS = frozenset(("line_text", "before_text", "after_text"))
#: 收場上傳（`POST /end` 的 body，形狀即 TS 的 `EndUpload`）。
END_UPLOAD_KEYS = frozenset(("questions",))
END_ITEM_KEYS = frozenset(("question_key",))
END_ITEM_OPTIONAL_KEYS = frozenset(
    (
        "opened_at",
        "closed_at",
        "answer_count",
        "correct_count",
        "option_counts",
        "cell_stats",
        "rows",
        "cols",
        "var_hint",
    )
)
END_TABLE_ONLY_KEYS = frozenset(("cell_stats", "rows", "cols", "var_hint"))
END_HEATMAP_KEYS = ("cell_stats", "rows", "cols")
MAX_VAR_HINT_LENGTH = 128
MAX_UPLOAD_TIMESTAMP_LENGTH = 64
#: 上傳時間戳來自老師筆電的時鐘，常與伺服器差上幾秒到幾分鐘（快或慢都有）。
#: 開題／收卷時間的合法範圍是 [created_at - 此值, now + 此值]（controller ruling 16）。
UPLOAD_CLOCK_SKEW_SECONDS = 300
#: join token 的有效期，從場次建立時間起算（`load_join_token` 的預設值）。
JOIN_TOKEN_MAX_AGE = 8 * 60 * 60
TOKEN_SALT = "gdbgui-live-quiz-join-v1"

# ── 薄中繼（/lesson_quiz）的上限 ──────────────────────────────────────────────
#: 老師最後一個分頁斷線後保留的秒數；期間內重連，課堂照常。測試會 monkeypatch。
TEACHER_GRACE_SECONDS = 30
MAX_STUDENT_SOCKETS_PER_SESSION = 200
#: 單一事件 payload 以 JSON（UTF-8）編碼後的位元組上限。填表題 200 格 × 32 字約 7 KB。
MAX_STUDENT_EVENT_BYTES = 16384
MAX_TEACHER_EVENT_BYTES = 65536
#: 每個學生 sid 一個 token bucket：容量 10、每秒補 5；連續丟棄 30 個就斷線。
STUDENT_BUCKET_CAPACITY = 10
STUDENT_BUCKET_REFILL_PER_SECOND = 5
STUDENT_MAX_CONSECUTIVE_DROPS = 30
#: `relay:to-student` 唯一允許的事件名。
RELAY_TO_STUDENT_EVENTS = frozenset(("quiz:student-state", "quiz:answer-received"))

blueprint = Blueprint("live_quiz", __name__)
_socketio = None


class QuizRejected(ValueError):
    """Quiz data is malformed or does not belong to the requested resource."""


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


def _question_payload(row):
    payload = {
        "id": row["question_key"],
        "kind": row["kind"],
        "prompt": row["prompt"],
        "test_input": row["test_input"] if "test_input" in row.keys() and row["test_input"] is not None else None,
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
                    # 正解只給教師：這個 payload 只出現在擁有者才拿得到的回應裡
                    # （session_owned_by／_teacher_payload）。學生的畫面由老師分頁
                    # 經中繼送出，伺服器不再產生任何學生端的題目內容。
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
            prog_input = bundle.get("program_input")
            default_test_input = prog_input if isinstance(prog_input, str) else None
            for position, question in enumerate(quiz["questions"]):
                trigger = question["trigger"]
                conn.execute(
                    "INSERT INTO live_quiz_questions "
                    "(session_id, question_key, kind, prompt, explanation, source_file, "
                    " trigger_line, trigger_anchor_json, position, state, "
                    " options_json, correct_option_id, option_counts_json, table_spec_json, test_input) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)",
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
                        default_test_input,
                    ),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return session_owned_by(session_id, owner_id)


def _json_or_none(value):
    return json.loads(value) if value else None


def export_summary(owner_id: int) -> Optional[dict]:
    """擁有者所有課堂的匿名聚合，拿來證明「這幾場課堂確實辦過」。

    這裡**完全不碰** participants / responses，所以不含暱稱、不含逐筆作答，天生是
    去識別的（逐筆的課堂匯出現在由老師分頁在本機產生，伺服器從未持有）。只列出至少
    開過一題的課堂——只建立、沒出過題的（多半是測試）不算辦過。
    """
    if not _valid_id(owner_id):
        return None
    with closing(db.connect()) as conn:
        sessions = conn.execute(
            "SELECT id, title, state, created_at, ended_at FROM live_quiz_sessions "
            "WHERE owner_user_id=? AND id IN "
            "(SELECT session_id FROM live_quiz_questions WHERE opened_at IS NOT NULL) "
            "ORDER BY id",
            (owner_id,),
        ).fetchall()
        out = []
        for session in sessions:
            questions = conn.execute(
                "SELECT question_key, kind, prompt, opened_at, closed_at, answer_count, "
                "correct_count, option_counts_json, cell_stats_json "
                "FROM live_quiz_questions WHERE session_id=? AND opened_at IS NOT NULL "
                "ORDER BY position",
                (session["id"],),
            ).fetchall()
            out.append(
                {
                    "session_id": session["id"],
                    "title": session["title"],
                    "state": session["state"],
                    "created_at": session["created_at"],
                    "ended_at": session["ended_at"],
                    "questions": [
                        {
                            "question_key": q["question_key"],
                            "kind": q["kind"],
                            "prompt": q["prompt"],
                            "opened_at": q["opened_at"],
                            "closed_at": q["closed_at"],
                            "answer_count": q["answer_count"],
                            "correct_count": q["correct_count"],
                            "option_counts": _json_or_none(q["option_counts_json"]),
                            "cell_stats": _json_or_none(q["cell_stats_json"]),
                        }
                        for q in questions
                    ],
                }
            )
    return {"exported_at": db._now(), "sessions": out}


def _upload_count(value, label):
    if isinstance(value, bool) or not isinstance(value, int):
        raise QuizRejected(f"{label}必須是整數。")
    if not 0 <= value <= db.SQLITE_MAX_INTEGER:
        raise QuizRejected(f"{label}不可為負數或過大。")
    return value


def _utc_seconds(text):
    """解析 ISO 8601 時間（接受結尾 Z），回傳截到秒的 UTC datetime；無效或沒有時區回傳 None。"""
    if not isinstance(text, str) or not text or len(text) > MAX_UPLOAD_TIMESTAMP_LENGTH:
        return None
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).replace(microsecond=0)
    except (ValueError, OverflowError):
        return None


def _upload_time(value, label, earliest, latest):
    parsed = _utc_seconds(value)
    if parsed is None:
        raise QuizRejected(f"{label}不是有效的時間（需含時區）。")
    if not earliest <= parsed <= latest:
        raise QuizRejected(f"{label}不在課堂期間內。")
    return parsed


def _upload_var_hint(value, label):
    if isinstance(value, str) and any(unicodedata.category(ch) == "Cc" for ch in value):
        raise QuizRejected(f"{label}不可含控制字元。")
    return _text(value, label, 0, MAX_VAR_HINT_LENGTH)


def _upload_option_counts(value, question, answer_count, label):
    option_ids = [option["id"] for option in json.loads(question["options_json"])]
    if not isinstance(value, dict) or set(value) != set(option_ids):
        raise QuizRejected(f"{label}的選項分布必須恰好對應題目的選項。")
    counts = {
        option_id: _upload_count(value[option_id], f"{label}選項計數")
        for option_id in option_ids
    }
    if sum(counts.values()) != answer_count:
        raise QuizRejected(f"{label}的選項分布總和與作答數不符。")
    return counts


def _upload_cell_stats(item, question, answer_count, label):
    if any(key not in item for key in END_HEATMAP_KEYS):
        raise QuizRejected(f"{label}缺少熱區圖或表格維度。")
    rows, cols = item["rows"], item["cols"]
    for value in (rows, cols):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise QuizRejected(f"{label}的表格維度必須是正整數。")
    spec = json.loads(question["table_spec_json"])
    limit = min(int(spec["max_cells"]), MAX_CELLS_CEILING)
    if rows * cols > limit:
        raise QuizRejected(f"{label}的表格超過 {limit} 格。")
    stats = item["cell_stats"]
    if not isinstance(stats, list) or len(stats) != rows * cols:
        raise QuizRejected(f"{label}的熱區圖格數與表格維度不符。")
    values = [_upload_count(value, f"{label}熱區圖") for value in stats]
    if any(value > answer_count for value in values):
        raise QuizRejected(f"{label}的熱區圖計數不可超過作答數。")
    return values


def _validated_end_upload(conn, session, upload, now):
    """驗證收場上傳（安全審查 F2 的矩陣），回傳正規化後的各題資料。

    只驗格式與範圍，不重新計算：伺服器不能證明數字是真的（設計說明的安全不變式 6）。
    任何一條不符就整份拒絕；呼叫端在同一個交易裡，拒絕時什麼都不寫。
    """
    upload = _exact_dict(upload, END_UPLOAD_KEYS, "收場資料")
    items = upload["questions"]
    if not isinstance(items, list) or len(items) > MAX_QUESTIONS:
        raise QuizRejected(f"收場資料的題目必須是不超過 {MAX_QUESTIONS} 題的清單。")
    questions = {
        row["question_key"]: row
        for row in conn.execute(
            "SELECT * FROM live_quiz_questions WHERE session_id=?", (session["id"],)
        )
    }
    created_at = _utc_seconds(session["created_at"])
    if created_at is None:
        # 舊資料可能沒有時區；伺服器自己寫的一律是 UTC。
        try:
            created_at = datetime.fromisoformat(session["created_at"]).replace(
                tzinfo=timezone.utc, microsecond=0
            )
        except (TypeError, ValueError) as exc:
            raise QuizRejected("課堂建立時間無效。") from exc
    # 時間戳來自老師筆電的時鐘：兩端都放寬 UPLOAD_CLOCK_SKEW_SECONDS（ruling 16）。
    skew = timedelta(seconds=UPLOAD_CLOCK_SKEW_SECONDS)
    earliest, latest = created_at - skew, now + skew

    seen = set()
    normalized = []
    for index, raw in enumerate(items):
        label = f"收場資料第 {index + 1} 題"
        item = _exact_dict(raw, END_ITEM_KEYS, label, END_ITEM_OPTIONAL_KEYS)
        key = item["question_key"]
        if not isinstance(key, str) or key not in questions:
            raise QuizRejected(f"{label}不屬於這堂課。")
        if key in seen:
            raise QuizRejected("收場資料的題目不可重複。")
        seen.add(key)
        question = questions[key]
        kind = question["kind"]
        if kind != "choice" and "option_counts" in item:
            raise QuizRejected(f"{label}不是單選題，不可有選項分布。")
        if kind != "table" and any(field in item for field in END_TABLE_ONLY_KEYS):
            raise QuizRejected(f"{label}不是填表題，不可有熱區圖或變數提示。")

        entry = {"row": question, "kind": kind, "opened": False}
        if "var_hint" in item:
            entry["var_hint"] = _upload_var_hint(item["var_hint"], f"{label}變數提示")

        if item.get("opened_at") is None:
            # 沒開過的題：伺服器不寫任何聚合，所以上傳也不能帶任何作答痕跡。
            if item.get("closed_at") is not None:
                raise QuizRejected(f"{label}尚未開放，不可有收卷時間。")
            if any(field in item for field in END_HEATMAP_KEYS):
                raise QuizRejected(f"{label}尚未開放，不可有熱區圖。")
            for field in ("answer_count", "correct_count"):
                if field in item and _upload_count(item[field], f"{label}作答數") != 0:
                    raise QuizRejected(f"{label}尚未開放，不可有作答。")
            if "option_counts" in item:
                _upload_option_counts(item["option_counts"], question, 0, label)
            normalized.append(entry)
            continue

        opened_at = _upload_time(item["opened_at"], f"{label}開題時間", earliest, latest)
        closed_at = None
        if item.get("closed_at") is not None:
            closed_at = _upload_time(item["closed_at"], f"{label}收卷時間", earliest, latest)
            if opened_at > closed_at:
                raise QuizRejected(f"{label}的收卷時間早於開題時間。")
        if "answer_count" not in item or "correct_count" not in item:
            raise QuizRejected(f"{label}缺少作答數。")
        answer_count = _upload_count(item["answer_count"], f"{label}作答數")
        correct_count = _upload_count(item["correct_count"], f"{label}答對數")
        if correct_count > answer_count:
            raise QuizRejected(f"{label}的答對數不可超過作答數。")
        if kind == "choice":
            if "option_counts" not in item:
                raise QuizRejected(f"{label}缺少選項分布。")
            entry["option_counts"] = _upload_option_counts(
                item["option_counts"], question, answer_count, label
            )
        else:
            entry["cell_stats"] = _upload_cell_stats(item, question, answer_count, label)
        entry.update(
            opened=True,
            opened_at=opened_at.isoformat(timespec="seconds"),
            closed_at=closed_at.isoformat(timespec="seconds") if closed_at else None,
            answer_count=answer_count,
            correct_count=correct_count,
        )
        normalized.append(entry)
    return normalized


def _write_end_upload(conn, entries, ended_at):
    """把驗證過的上傳寫進 live_quiz_questions；回傳要寫回教案的 {題目 ID: var_hint}。

    題目 `state` 由伺服器決定：有 opened_at 的題一律 closed，沒有的維持原狀。
    """
    hints = {}
    for entry in entries:
        row = entry["row"]
        if "var_hint" in entry:
            spec = json.loads(row["table_spec_json"])
            hints[row["question_key"]] = entry["var_hint"]
            if spec.get("var_hint") != entry["var_hint"]:
                conn.execute(
                    "UPDATE live_quiz_questions SET table_spec_json=? WHERE id=?",
                    (
                        json.dumps({**spec, "var_hint": entry["var_hint"]}, ensure_ascii=False),
                        row["id"],
                    ),
                )
        if not entry["opened"]:
            continue
        conn.execute(
            "UPDATE live_quiz_questions SET state='closed', opened_at=?, closed_at=?, "
            "answer_count=?, correct_count=? WHERE id=?",
            (
                entry["opened_at"],
                entry["closed_at"] or ended_at,
                entry["answer_count"],
                entry["correct_count"],
                row["id"],
            ),
        )
        if entry["kind"] == "choice":
            conn.execute(
                "UPDATE live_quiz_questions SET option_counts_json=? WHERE id=?",
                (
                    json.dumps(entry["option_counts"], ensure_ascii=False, separators=(",", ":")),
                    row["id"],
                ),
            )
        else:
            conn.execute(
                "UPDATE live_quiz_questions SET cell_stats_json=? WHERE id=?",
                (json.dumps(entry["cell_stats"]), row["id"]),
            )
    return hints


def _persist_table_hints(session_id: int, owner_id: int, hints: dict) -> bool:
    """收場後把所有填表題的 var_hint 用**一次**教案更新寫回；回傳是否已寫回（或無須寫回）。

    必須在收場交易 commit 之後才呼叫：`db.update_lesson_owned_by` 會開第二條連線與
    `BEGIN IMMEDIATE`，在交易內呼叫會等滿 busy_timeout（安全審查 F1）。
    任何失敗都不得回滾已結束的場次：記錄（不含上傳內容）後回傳 False。
    """
    if not hints:
        return True
    try:
        with closing(db.connect()) as conn:
            snapshot = conn.execute(
                "SELECT s.lesson_id, v.version, v.title, v.bundle_json "
                "FROM live_quiz_sessions s JOIN lesson_versions v ON v.id=s.lesson_version_id "
                "WHERE s.id=? AND s.owner_user_id=?",
                (session_id, owner_id),
            ).fetchone()
        if snapshot is None:
            return False
        bundle = json.loads(snapshot["bundle_json"])
        changed = False
        for question in bundle.get("quiz", {}).get("questions", []):
            hint = hints.get(question.get("id"))
            if hint is None or question.get("kind") != "table":
                continue
            if question["table_spec"]["var_hint"] != hint:
                question["table_spec"]["var_hint"] = hint
                changed = True
        if not changed:
            return True
        result = db.update_lesson_owned_by(
            int(snapshot["lesson_id"]),
            owner_id,
            snapshot["title"],
            json.dumps(bundle, ensure_ascii=False, separators=(",", ":")),
            parent_version=int(snapshot["version"]),
            expected_current_version=int(snapshot["version"]),
        )
        # 教案在課堂期間有了更新的版本時，update 不覆蓋、回傳 changed=False。
        return result is not None and result.changed
    except Exception as exc:
        logger.warning(
            "[live quiz] could not persist table hints for session %s (%s)",
            session_id,
            type(exc).__name__,
        )
        return False


def end_session(session_id: int, owner_id: int, upload: Optional[dict] = None) -> Optional[dict]:
    """結束課堂。`upload` 是老師端算好的匿名聚合（TS `EndUpload`）。

    `upload is None`（寬限期滿、分頁遺失或空 body）只把場次標為 ended，不寫聚合。
    驗證與寫入在同一個 `BEGIN IMMEDIATE` 交易內；驗證失敗丟 `QuizRejected`，什麼都不寫。
    教案的 var_hint 在 commit **之後**才寫回，結果放在回傳值的 `hint_saved`。
    """
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    hints = {}
    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            session = _session_row(conn, session_id, owner_id)
            if session is None or session["state"] != "lobby":
                conn.commit()
                return None
            now = db._now()
            if upload is not None:
                entries = _validated_end_upload(
                    conn, session, upload, datetime.fromisoformat(now)
                )
                hints = _write_end_upload(conn, entries, now)
            conn.execute(
                "UPDATE live_quiz_sessions SET state='ended', ended_at=? WHERE id=?",
                (now, session_id),
            )
            conn.execute(
                "UPDATE live_quiz_questions SET state='closed', closed_at=? "
                "WHERE session_id=? AND state='open'",
                (now, session_id),
            )
            # 新流程不再寫這兩張表，但部署當下仍在 lobby 的舊場次可能還留著暱稱與逐筆
            # 作答（舊 HTTP 訪客 API 寫的）；收場一律刪光，不得移除（安全審查 F8）。
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
    # 交易已 commit、連線已關：這之後的教案寫入失敗也不會讓場次回滾（F1）。
    hint_saved = _persist_table_hints(session_id, owner_id, hints)
    payload = session_owned_by(session_id, owner_id)
    if payload is not None:
        payload["hint_saved"] = hint_saved
    return payload


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


def load_join_token(token, max_age=JOIN_TOKEN_MAX_AGE):
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


@blueprint.get("/api/live-quiz/export")
def export_summary_route():
    payload = export_summary(current_user_id())
    if payload is None:
        return _error("找不到課堂。", 404)
    response = current_app.response_class(
        json.dumps(payload, ensure_ascii=False, indent=2), mimetype="application/json"
    )
    response.headers["Content-Disposition"] = (
        'attachment; filename="live-quiz-summary-%s.json"' % payload["exported_at"][:10]
    )
    return response


def _end_upload_body():
    """`/end` 的 body：空 body 或 `{}` 代表沒有上傳；其餘交給 end_session 驗證。

    有 body 卻不是 JSON 就拒絕，不當成「沒有上傳」默默收場。
    """
    if not request.get_data(cache=True).strip():
        return None
    body = request.get_json(silent=True)
    if body is None:
        raise QuizRejected("收場資料不是有效的 JSON。")
    if body == {}:
        return None
    return body


@blueprint.post("/api/live-quiz/sessions/<int:session_id>/end")
def end_session_route(session_id):
    try:
        upload = _end_upload_body()
        row = _invitation_row(session_id, current_user_id())
        ended = end_session(session_id, current_user_id(), upload)
    except QuizRejected as exc:
        return _error(str(exc), 400)
    if ended is not None and row is not None:
        relay_end(row["join_nonce"])
        if _socketio is not None and _socketio.server is not None:
            _socketio.close_room(_teacher_room(row["join_nonce"]), namespace=LIVE_QUIZ_NAMESPACE)
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


# ── 薄中繼 ────────────────────────────────────────────────────────────────────
#
# 連線時伺服器決定角色與場次，寫進 `SIDS`；之後每一個 handler 的角色與場次**只**
# 從 `SIDS` 讀，從不讀 handshake 的 `auth` 或事件 payload。中繼不保存、不解讀
# 答題內容，也不把任何 token、device_id、暱稱或答案寫進 log。
#
# 全部狀態都在單一 eventlet hub 上被存取；底下沒有任何一段在讀與寫 `SIDS` 之間
# 讓出 hub，所以不需要鎖。

LIVE_QUIZ_NAMESPACE = "/lesson_quiz"

#: sid -> {"role", "nonce", "session_id", "device_id", "bucket"}；斷線時移除。
SIDS = {}
#: join_nonce -> 寬限期計時器的世代號。老師重連或收場時移除，舊計時器醒來發現
#: 世代號對不上就放棄。世代號取自全域遞增計數器，不會在同一個 nonce 上重複。
_GRACE_TIMERS = {}
_grace_generations = itertools.count(1)
#: 流量限制用的時鐘；測試會 monkeypatch。
_clock = monotonic


def _teacher_room(join_nonce):
    return f"lesson_quiz:teacher:{join_nonce}"


def _student_room(join_nonce):
    return f"lesson_quiz:students:{join_nonce}"


def _relay_emit(event, payload, to):
    if _socketio is None or _socketio.server is None:
        return
    _socketio.emit(event, payload, to=to, namespace=LIVE_QUIZ_NAMESPACE)


def _disconnect_sid(sid):
    if _socketio is not None and _socketio.server is not None:
        _socketio.server.disconnect(sid, namespace=LIVE_QUIZ_NAMESPACE)


def _single_dict_arg(args, limit):
    """事件必須恰好帶一個 dict，且 JSON 編碼後不超過 `limit` 位元組；否則回傳 None。

    bytes（Socket.IO 的二進位附件）與無法編碼的值會讓 `json.dumps` 拋例外，在這裡
    吞掉，不讓它冒泡成 handler 例外。
    """
    if len(args) != 1 or not isinstance(args[0], dict):
        return None
    try:
        encoded = json.dumps(
            args[0], ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        return None
    return args[0] if len(encoded) <= limit else None


def _new_bucket():
    return {"tokens": float(STUDENT_BUCKET_CAPACITY), "stamp": _clock(), "drops": 0}


def _take_token(bucket):
    now = _clock()
    elapsed = max(0.0, now - bucket["stamp"])
    bucket["stamp"] = now
    bucket["tokens"] = min(
        float(STUDENT_BUCKET_CAPACITY),
        bucket["tokens"] + elapsed * STUDENT_BUCKET_REFILL_PER_SECOND,
    )
    if bucket["tokens"] >= 1:
        bucket["tokens"] -= 1
        return True
    return False


def _drop_student_event(sid, entry):
    """丟棄一個學生事件；連續丟棄達上限就斷開這個 sid。"""
    entry["bucket"]["drops"] += 1
    if entry["bucket"]["drops"] >= STUDENT_MAX_CONSECUTIVE_DROPS:
        _disconnect_sid(sid)


def _role_sids(nonce, role):
    return [sid for sid, entry in SIDS.items() if entry["nonce"] == nonce and entry["role"] == role]


def _relay_from_student(out_event, args):
    sid = request.sid
    entry = SIDS.get(sid)
    if entry is None or entry["role"] != "student":
        return
    if not _take_token(entry["bucket"]):
        return _drop_student_event(sid, entry)
    payload = _single_dict_arg(args, MAX_STUDENT_EVENT_BYTES)
    device_id = payload.get("device_id") if payload is not None else None
    if not isinstance(device_id, str) or not device_id:
        return _drop_student_event(sid, entry)
    if entry["device_id"] is None:
        entry["device_id"] = device_id
    elif entry["device_id"] != device_id:
        return _drop_student_event(sid, entry)
    entry["bucket"]["drops"] = 0
    # 固定信封：學生 payload 裡自帶的 `sid` 只會留在 data 裡，蓋不掉伺服器的值。
    _relay_emit(out_event, {"sid": sid, "data": payload}, _teacher_room(entry["nonce"]))


def _teacher_caller():
    """呼叫者是老師就回傳它的 SIDS 項目；學生冒用老師事件算一次丟棄。"""
    sid = request.sid
    entry = SIDS.get(sid)
    if entry is None:
        return None
    if entry["role"] == "teacher":
        return entry
    if entry["role"] == "student":
        _take_token(entry["bucket"])
        _drop_student_event(sid, entry)
    return None


def _relay_to_students(args):
    entry = _teacher_caller()
    if entry is None:
        return
    body = _single_dict_arg(args, MAX_TEACHER_EVENT_BYTES)
    payload = body.get("payload") if body is not None else None
    if not isinstance(payload, dict):
        return
    _relay_emit("quiz:student-state", payload, _student_room(entry["nonce"]))


def _relay_to_student(args):
    entry = _teacher_caller()
    if entry is None:
        return
    body = _single_dict_arg(args, MAX_TEACHER_EVENT_BYTES)
    if body is None:
        return
    target, event, payload = body.get("sid"), body.get("event"), body.get("payload")
    if not isinstance(event, str) or event not in RELAY_TO_STUDENT_EVENTS:
        return
    if not isinstance(target, str) or not isinstance(payload, dict):
        return
    target_entry = SIDS.get(target)
    if (
        target_entry is None
        or target_entry["role"] != "student"
        or target_entry["nonce"] != entry["nonce"]
    ):
        return
    _relay_emit(event, payload, target)


def relay_end(join_nonce):
    """課堂結束：通知該場學生、斷開該場所有 sid，並清掉 SIDS 與寬限期計時器。

    先把項目從 SIDS 拿掉再斷線，斷線 handler 就找不到它們，不會再啟動新的寬限期
    計時器或送 presence。
    """
    _GRACE_TIMERS.pop(join_nonce, None)
    sids = [sid for sid, entry in SIDS.items() if entry["nonce"] == join_nonce]
    for sid in sids:
        SIDS.pop(sid, None)
    _relay_emit("quiz:student-state", {"state": "ended"}, _student_room(join_nonce))
    for sid in sids:
        _disconnect_sid(sid)


def _start_teacher_grace(join_nonce, session_id):
    generation = next(_grace_generations)
    _GRACE_TIMERS[join_nonce] = generation
    _socketio.start_background_task(_teacher_grace_expired, join_nonce, session_id, generation)


def _teacher_grace_expired(join_nonce, session_id, generation):
    _socketio.sleep(TEACHER_GRACE_SECONDS)
    if _GRACE_TIMERS.get(join_nonce) != generation or _role_sids(join_nonce, "teacher"):
        return
    try:
        row = _invitation_row(session_id)
        if row is not None and row["state"] == "lobby":
            end_session(session_id, int(row["owner_user_id"]))
    except Exception:
        # 只記場次編號；不記 token、裝置或任何作答內容。
        logger.exception("live quiz: ending session %s after teacher grace failed", session_id)
    relay_end(join_nonce)


def _connect_teacher(auth):
    owner_id = current_user_id()
    session_id = auth.get("session_id")
    if owner_id is None or not _valid_id(session_id):
        return False
    row = _invitation_row(session_id, owner_id)
    if row is None or row["state"] != "lobby":
        return False
    nonce = row["join_nonce"]
    join_room(_teacher_room(nonce))
    # 老師不在時連上或送 hello 的學生，事件都進了空的老師房間。通知該場學生重送
    # hello，並把伺服器端已知的事實（sid 與已釘住的 device_id）只交給這個老師連線。
    _relay_emit("relay:teacher-online", {}, _student_room(nonce))
    emit(
        "relay:roster",
        {
            "students": [
                {"sid": sid, "device_id": SIDS[sid]["device_id"]}
                for sid in _role_sids(nonce, "student")
            ]
        },
    )
    # 寫入 SIDS 是最後一個步驟：上面任何一步拋例外，這個 sid 都不會留下老師身分，
    # 之後的 relay:* 事件也就一律被忽略。以下兩行都是不會失敗的 dict 操作，中間不讓出 hub。
    SIDS[request.sid] = {
        "role": "teacher",
        "nonce": nonce,
        "session_id": int(row["id"]),
        "device_id": None,
        "bucket": None,
    }
    # 老師在寬限期內回來：撤銷計時器的世代號，舊計時器醒來就會放棄。
    _GRACE_TIMERS.pop(nonce, None)
    return True


def _connect_relay_student(token):
    session_id = load_join_token(token)
    if session_id is None:
        return False
    row = _invitation_row(session_id)
    if row is None or row["state"] != "lobby":
        return False
    nonce = row["join_nonce"]
    if len(_role_sids(nonce, "student")) >= MAX_STUDENT_SOCKETS_PER_SESSION:
        return False
    sid = request.sid
    SIDS[sid] = {
        "role": "student",
        "nonce": nonce,
        "session_id": int(row["id"]),
        "device_id": None,
        "bucket": _new_bucket(),
    }
    join_room(_student_room(nonce))
    _relay_emit("relay:presence", {"sid": sid, "connected": True}, _teacher_room(nonce))
    return True


def register_socket_handlers(socketio):
    global _socketio
    _socketio = socketio
    if getattr(socketio, "_live_quiz_handlers_registered", False):
        return
    socketio._live_quiz_handlers_registered = True

    # 刻意不註冊 catch-all（"*"）handler：沒列在這裡的事件一律被 Socket.IO 忽略。

    @socketio.on("connect", namespace=LIVE_QUIZ_NAMESPACE)
    def connect_live_quiz(auth=None):
        if is_cross_origin(request):
            return False
        auth = auth if isinstance(auth, dict) else {}
        role = auth.get("role")
        if role == "teacher":
            # 老師：登入身分＋擁有的 lobby 場次；失敗直接拒絕，不落入學生分支。
            return _connect_teacher(auth)
        if role == "student":
            # 學生：有效的 join token；沒有 token 就是 None，load_join_token 會拒絕。
            return _connect_relay_student(auth.get("token"))
        # 沒有角色、未知角色或 auth 不是 dict：一律 fail closed。
        return False

    @socketio.on("disconnect", namespace=LIVE_QUIZ_NAMESPACE)
    def disconnect_live_quiz(*_reason):
        sid = request.sid
        entry = SIDS.pop(sid, None)
        if entry is None:
            return
        nonce = entry["nonce"]
        if entry["role"] == "student":
            _relay_emit("relay:presence", {"sid": sid, "connected": False}, _teacher_room(nonce))
        elif not _role_sids(nonce, "teacher"):
            # 只有老師房間已空才起算寬限期；第二個老師分頁斷線不結束課堂。
            _start_teacher_grace(nonce, entry["session_id"])

    @socketio.on("student:hello", namespace=LIVE_QUIZ_NAMESPACE)
    def student_hello(*args):
        _relay_from_student("relay:student-hello", args)

    @socketio.on("student:answer", namespace=LIVE_QUIZ_NAMESPACE)
    def student_answer(*args):
        _relay_from_student("relay:student-answer", args)

    @socketio.on("relay:to-students", namespace=LIVE_QUIZ_NAMESPACE)
    def relay_to_students(*args):
        _relay_to_students(args)

    @socketio.on("relay:to-student", namespace=LIVE_QUIZ_NAMESPACE)
    def relay_to_student(*args):
        _relay_to_student(args)
