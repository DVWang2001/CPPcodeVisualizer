"""Persistent live-quiz state and strict lesson quiz validation."""

import json
import re
import secrets
from contextlib import closing
from typing import Optional

from . import db


MAX_QUESTIONS = 30
MAX_PROMPT_LENGTH = 500
MAX_OPTION_LENGTH = 200
MAX_EXPLANATION_LENGTH = 1000
MAX_NICKNAME_LENGTH = 50

QUIZ_KEYS = frozenset(("schema_version", "questions"))
QUESTION_KEYS = frozenset(
    ("id", "prompt", "options", "correct_option_id", "explanation", "trigger")
)
OPTION_KEYS = frozenset(("id", "text"))
TRIGGER_KEYS = frozenset(("kind", "source_file", "line", "anchor"))
ANCHOR_KEYS = frozenset(("line_text", "before_text", "after_text"))
CREDENTIAL_HASH_RE = re.compile(r"\A[0-9a-f]{64}\Z")


class QuizRejected(ValueError):
    """Quiz data is malformed or does not belong to the requested resource."""


class QuizConflict(QuizRejected):
    """A valid request conflicts with the current live-session state."""


def _exact_dict(value, keys, label):
    if not isinstance(value, dict):
        raise QuizRejected(f"{label}格式不正確。")
    actual = set(value)
    if actual - keys:
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
    if "\\" in left or "\\" in right:
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
        question = _exact_dict(value, QUESTION_KEYS, label)
        question_id = _text(question["id"], f"{label} ID", 1, db.MAX_BUNDLE_BYTES)
        if question_id in question_ids:
            raise QuizRejected("題目 ID 必須不重複。")
        question_ids.add(question_id)
        prompt = _text(question["prompt"], f"{label}題幹", 1, MAX_PROMPT_LENGTH)
        explanation = _text(
            question["explanation"], f"{label}解說", 0, MAX_EXPLANATION_LENGTH
        )

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
        questions.append(
            {
                "id": question_id,
                "prompt": prompt,
                "options": options,
                "correct_option_id": correct_option_id,
                "explanation": explanation,
                "trigger": resolved,
            }
        )
    return {"schema_version": 1, "questions": questions}


def _valid_id(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and 0 < value <= db.SQLITE_MAX_INTEGER
    )


def _question_payload(row):
    return {
        "id": row["question_key"],
        "prompt": row["prompt"],
        "options": json.loads(row["options_json"]),
        "correct_option_id": row["correct_option_id"],
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
        "option_counts": json.loads(row["option_counts_json"]),
    }


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
                option_counts = {option["id"]: 0 for option in question["options"]}
                trigger = question["trigger"]
                conn.execute(
                    "INSERT INTO live_quiz_questions "
                    "(session_id, question_key, prompt, options_json, correct_option_id, "
                    "explanation, source_file, trigger_line, trigger_anchor_json, position, "
                    "state, option_counts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)",
                    (
                        session_id,
                        question["id"],
                        question["prompt"],
                        json.dumps(question["options"], ensure_ascii=False, separators=(",", ":")),
                        question["correct_option_id"],
                        question["explanation"],
                        trigger["source_file"],
                        trigger["line"],
                        json.dumps(trigger["anchor"], ensure_ascii=False, separators=(",", ":")),
                        position,
                        json.dumps(option_counts, ensure_ascii=False, separators=(",", ":")),
                    ),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return session_owned_by(session_id, owner_id)


def trigger_question(
    session_id: int, owner_id: int, question_key: str, source_file: str, line: int
) -> Optional[dict]:
    if not _valid_id(session_id) or not _valid_id(owner_id):
        return None
    if not isinstance(question_key, str) or not question_key:
        raise QuizRejected("缺少題目 ID。")
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
                conn.execute(
                    "UPDATE live_quiz_questions SET state='open', opened_at=? WHERE id=?",
                    (db._now(), question["id"]),
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
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
    return {
        "answer_count": int(row["answer_count"]),
        "correct_count": int(row["correct_count"]),
        "option_counts": json.loads(row["option_counts_json"]),
    }


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
            "SELECT q.*, r.selected_option_id, r.is_correct "
            "FROM live_quiz_questions q "
            "LEFT JOIN live_quiz_responses r ON r.question_id=q.id AND r.participant_id=? "
            "WHERE q.session_id=? AND q.state IN ('open', 'closed') AND q.opened_at IS NOT NULL "
            "ORDER BY CASE q.state WHEN 'open' THEN 0 ELSE 1 END, q.opened_at DESC LIMIT 1",
            (participant["id"], participant["session_id"]),
        ).fetchone()
        active = None
        if question is not None:
            active = {
                "id": question["question_key"],
                "prompt": question["prompt"],
                "options": json.loads(question["options_json"]),
                "source_file": question["source_file"],
                "line": int(question["trigger_line"]),
                "state": question["state"],
                "selected_option_id": question["selected_option_id"],
            }
            if question["state"] == "closed":
                active["result"] = {
                    "is_correct": (
                        bool(question["is_correct"])
                        if question["selected_option_id"] is not None
                        else None
                    ),
                    "correct_option_id": question["correct_option_id"],
                    "explanation": question["explanation"],
                }
        return {
            "participant_id": int(participant["id"]),
            "session_id": int(participant["session_id"]),
            "session_title": participant["title"],
            "nickname": participant["nickname"],
            "state": "active",
            "active_question": active,
        }
