"""即時課堂薄中繼（/lesson_quiz）：角色判定、路由隔離、流量限制與收場。

伺服器在這裡只做三件事：連線時決定角色（之後只信 `live_quiz.SIDS`）、把學生的
事件用固定信封轉給老師、把老師的事件轉給學生。每一條安全規則都有自己的測試，
而且每一條在「天真的實作」上都會失敗（見各測試的說明）。
"""

import json
import logging
from urllib.parse import urlsplit

import pytest
from itsdangerous import URLSafeSerializer

from gdbgui.server import db, live_quiz
from .conftest import register_user
from .test_live_quiz_db import valid_bundle


NS = "/lesson_quiz"


class Relay:
    def __init__(self, app, socketio):
        self.app = app
        self.socketio = socketio
        self.clients = []

    def new_session(self, author=None):
        author = author or register_user(self.app, display_name="Relay Author")
        lesson_id = db.create_lesson(
            author.user_id, "中繼課堂", json.dumps(valid_bundle(), ensure_ascii=False)
        )
        created = author.http.post(
            "/api/live-quiz/sessions",
            json={"lesson_id": lesson_id},
            headers={"x-csrftoken": author.csrf},
        )
        assert created.status_code == 201
        return author, created.get_json()

    def end(self, author, session_id):
        return author.http.post(
            f"/api/live-quiz/sessions/{session_id}/end",
            headers={"x-csrftoken": author.csrf},
        )

    def _connect(self, **kwargs):
        client = self.socketio.test_client(self.app, namespace=NS, **kwargs)
        self.clients.append(client)
        return client

    def teacher(self, author, session_id, **extra):
        auth = {"role": "teacher", "session_id": session_id, **extra}
        return self._connect(flask_test_client=author.http, auth=auth)

    def student(self, token):
        return self._connect(auth={"role": "student", "token": token})

    def sid_of(self, client):
        return self.socketio.server.manager.sid_from_eio_sid(client.eio_sid, NS)


def token_of(created):
    return urlsplit(created["join_url"]).path.rsplit("/", 1)[-1]


def take(client, name=None):
    """取出（並從佇列移除）這個 client 收到的 /lesson_quiz 事件；斷線後也讀得到。

    給了 `name` 就只取出並移除那一種事件，其他事件留在佇列裡。
    """

    def wanted(packet):
        return packet["namespace"] == NS and (name is None or packet["name"] == name)

    mine = [packet for packet in client.queue if wanted(packet)]
    client.queue = [packet for packet in client.queue if not wanted(packet)]
    if name is None:
        return [(packet["name"], packet["args"][0] if packet["args"] else None) for packet in mine]
    return [packet["args"][0] for packet in mine]


def nonce_of(session_id):
    return live_quiz._invitation_row(session_id)["join_nonce"]


def session_state(session_id):
    return live_quiz._invitation_row(session_id)["state"]


def wait_until(socketio, predicate, attempts=200):
    """讓 eventlet hub 跑背景計時器，直到條件成立。"""
    for _ in range(attempts):
        if predicate():
            return True
        socketio.sleep(0.01)
    return predicate()


def hello(client, device_id="dev-1", nickname="小明", **extra):
    client.emit("student:hello", {"device_id": device_id, "nickname": nickname, **extra}, namespace=NS)


def answer(client, device_id="dev-1", answer_value="b", nonce="n-1", **extra):
    client.emit(
        "student:answer",
        {
            "device_id": device_id,
            "question_key": "q1",
            "answer": answer_value,
            "nonce": nonce,
            **extra,
        },
        namespace=NS,
    )


@pytest.fixture
def relay(flask_app):
    from gdbgui.server.app import socketio
    from gdbgui.server.server import run_server

    if socketio.server is None:
        run_server(testing=True, app=flask_app, socketio=socketio)
    flask_app.config["MOBILE_JOIN_BASE_URL"] = "http://10.0.0.2:5000"
    context = Relay(flask_app, socketio)
    yield context
    for client in context.clients:
        if client.connected.get(NS):
            client.disconnect(namespace=NS)
    getattr(live_quiz, "SIDS", {}).clear()
    getattr(live_quiz, "_GRACE_TIMERS", {}).clear()


# ── 連線與角色 ────────────────────────────────────────────────────────────────


def test_student_with_bad_or_ended_token_is_rejected(relay):
    author, created = relay.new_session()
    session_id = created["id"]
    good = token_of(created)
    forged = URLSafeSerializer("not-the-server-key", salt=live_quiz.TOKEN_SALT).dumps(
        {"session_id": session_id, "join_nonce": nonce_of(session_id)}
    )
    wrong_nonce = URLSafeSerializer(relay.app.secret_key, salt=live_quiz.TOKEN_SALT).dumps(
        {"session_id": session_id, "join_nonce": "guessed-nonce"}
    )
    for bad in ("", "garbage", good[:-3] + "AAA", forged, wrong_nonce, None, 12345, ["x"]):
        assert not relay.student(bad).is_connected(NS), bad

    accepted = relay.student(good)
    assert accepted.is_connected(NS)
    assert live_quiz.SIDS[relay.sid_of(accepted)]["role"] == "student"

    ended_author, ended = relay.new_session()
    ended_token = token_of(ended)
    assert relay.end(ended_author, ended["id"]).status_code == 200
    assert not relay.student(ended_token).is_connected(NS)


def test_teacher_must_own_lobby_session(relay):
    author, created = relay.new_session()
    session_id = created["id"]
    other = register_user(relay.app, display_name="Relay Other")

    assert not relay.teacher(other, session_id).is_connected(NS)
    anonymous = relay._connect(auth={"role": "teacher", "session_id": session_id})
    assert not anonymous.is_connected(NS)
    for bogus in (None, "1", True, 0, -1, session_id + 10_000):
        assert not relay.teacher(author, bogus).is_connected(NS), bogus

    owner = relay.teacher(author, session_id)
    assert owner.is_connected(NS)
    entry = live_quiz.SIDS[relay.sid_of(owner)]
    assert entry["role"] == "teacher"
    assert entry["nonce"] == nonce_of(session_id)
    assert entry["session_id"] == session_id

    assert relay.end(author, session_id).status_code == 200
    assert not relay.teacher(author, session_id).is_connected(NS)


def test_unknown_role_and_failed_teacher_auth_are_rejected(relay):
    """F7：未知角色 fail closed；老師驗證失敗不落入學生分支（即使 auth 帶了有效 token）。"""
    author, created = relay.new_session()
    session_id = created["id"]
    token = token_of(created)
    # 一個合法的舊式 cookie 學生：舊實作對任何非 teacher 的角色都會落入 cookie 分支。
    guest = relay.app.test_client()
    joined = guest.post(
        "/api/live-quiz/guest/join",
        json={"token": token, "nickname": "cookie 學生"},
        headers={"Origin": "http://localhost"},
    )
    assert joined.status_code == 200

    for role in ("admin", "Teacher", "student ", "", 1, ["teacher"], {"role": "teacher"}):
        rejected = relay._connect(flask_test_client=guest, auth={"role": role, "token": token})
        assert not rejected.is_connected(NS), role
        rejected = relay._connect(flask_test_client=guest, auth={"role": role})
        assert not rejected.is_connected(NS), role

    other = register_user(relay.app, display_name="Relay Impostor")
    impostor = relay._connect(
        flask_test_client=other.http,
        auth={"role": "teacher", "session_id": session_id, "token": token},
    )
    assert not impostor.is_connected(NS)
    impostor = relay._connect(auth={"role": "teacher", "token": token})
    assert not impostor.is_connected(NS)
    assert live_quiz.SIDS == {}


def test_student_connection_cap_per_session(relay, monkeypatch):
    assert live_quiz.MAX_STUDENT_SOCKETS_PER_SESSION == 200
    monkeypatch.setattr(live_quiz, "MAX_STUDENT_SOCKETS_PER_SESSION", 2)
    _, created = relay.new_session()
    _, other_created = relay.new_session()
    token = token_of(created)

    first = relay.student(token)
    second = relay.student(token)
    third = relay.student(token)
    assert first.is_connected(NS) and second.is_connected(NS)
    assert not third.is_connected(NS)
    # 上限是每一場各自計算，別場不受影響。
    assert relay.student(token_of(other_created)).is_connected(NS)

    first.disconnect(namespace=NS)
    assert relay.student(token).is_connected(NS)


# ── 學生 → 老師 ───────────────────────────────────────────────────────────────


def test_student_connect_and_disconnect_send_presence_to_teacher(relay):
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    take(teacher)

    student = relay.student(token_of(created))
    sid = relay.sid_of(student)
    assert take(teacher, "relay:presence") == [{"sid": sid, "connected": True}]

    student.disconnect(namespace=NS)
    assert take(teacher, "relay:presence") == [{"sid": sid, "connected": False}]
    assert sid not in live_quiz.SIDS


def test_student_answer_reaches_teacher_with_sid_and_never_other_students(relay):
    author, created = relay.new_session()
    other_author, other_created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    other_teacher = relay.teacher(other_author, other_created["id"])
    alice = relay.student(token_of(created))
    bob = relay.student(token_of(created))
    stranger = relay.student(token_of(other_created))
    for client in (teacher, other_teacher, alice, bob, stranger):
        take(client)

    hello(alice, device_id="dev-alice", nickname="Alice")
    answer(alice, device_id="dev-alice", answer_value="b", nonce="n-7")

    alice_sid = relay.sid_of(alice)
    assert take(teacher, "relay:student-hello") == [
        {"sid": alice_sid, "data": {"device_id": "dev-alice", "nickname": "Alice"}}
    ]
    assert take(teacher, "relay:student-answer") == [
        {
            "sid": alice_sid,
            "data": {
                "device_id": "dev-alice",
                "question_key": "q1",
                "answer": "b",
                "nonce": "n-7",
            },
        }
    ]
    assert take(alice) == []
    assert take(bob) == []
    assert take(stranger) == []
    assert take(other_teacher) == []


def test_student_supplied_sid_field_cannot_override_envelope(relay):
    """F4：天真的 `{"sid": sid, **payload}` 會讓學生自帶的 sid 蓋掉伺服器的值。"""
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(teacher)

    answer(student, device_id="dev-1", sid="other", data="forged")
    received = take(teacher, "relay:student-answer")
    assert received == [
        {
            "sid": relay.sid_of(student),
            "data": {
                "device_id": "dev-1",
                "question_key": "q1",
                "answer": "b",
                "nonce": "n-1",
                "sid": "other",
                "data": "forged",
            },
        }
    ]
    assert set(received[0]) == {"sid", "data"}


def test_second_device_id_on_same_sid_is_dropped(relay):
    """F5：每個學生 sid 的第一個 device_id 被釘住，之後換 device_id 的事件一律丟棄。"""
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(teacher)

    hello(student, device_id="dev-A")
    answer(student, device_id="dev-B", nonce="from-B")
    hello(student, device_id="dev-B", nickname="換人")
    answer(student, device_id="dev-A", nonce="from-A")

    assert [msg["data"]["device_id"] for msg in take(teacher, "relay:student-hello")] == ["dev-A"]
    assert [msg["data"]["nonce"] for msg in take(teacher, "relay:student-answer")] == ["from-A"]
    assert live_quiz.SIDS[relay.sid_of(student)]["device_id"] == "dev-A"


def test_oversized_student_event_is_dropped(relay):
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(teacher)

    answer(student, answer_value="x" * (17 * 1024), nonce="too-big")
    assert take(teacher, "relay:student-answer") == []
    # 多位元組字元以 UTF-8 位元組計算：6000 個中文字約 18 KB。
    answer(student, answer_value="中" * 6000, nonce="too-big-utf8")
    assert take(teacher, "relay:student-answer") == []

    answer(student, answer_value="x" * (7 * 1024), nonce="fits")
    assert [msg["data"]["nonce"] for msg in take(teacher, "relay:student-answer")] == ["fits"]
    assert student.is_connected(NS)


def test_non_dict_or_binary_payload_is_dropped_without_error(relay):
    """F3：bytes 會讓 json.dumps 拋 TypeError；不得冒泡成 handler 例外。"""
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(teacher)

    student.emit("student:answer", "just a string", namespace=NS)
    student.emit("student:answer", ["a", "list"], namespace=NS)
    student.emit("student:answer", 42, namespace=NS)
    student.emit("student:answer", b"\x00\x01binary", namespace=NS)
    student.emit("student:answer", {"device_id": "dev-1", "answer": b"\xff"}, namespace=NS)
    student.emit("student:answer", namespace=NS)
    student.emit("student:answer", {"device_id": "dev-1"}, {"extra": 1}, namespace=NS)
    student.emit("student:hello", {"device_id": 7, "nickname": "非字串裝置"}, namespace=NS)
    assert take(teacher) == []
    assert student.is_connected(NS)

    # 老師端送壞掉的 payload 也一樣不得冒泡。
    teacher.emit("relay:to-students", b"\x00", namespace=NS)
    teacher.emit("relay:to-students", {"payload": b"\x00"}, namespace=NS)
    teacher.emit("relay:to-student", "nope", namespace=NS)
    teacher.emit("relay:to-student", {"sid": ["x"], "event": ["y"], "payload": {}}, namespace=NS)
    assert take(student) == []

    answer(student, nonce="ok")
    assert [msg["data"]["nonce"] for msg in take(teacher, "relay:student-answer")] == ["ok"]


def test_burst_of_student_events_is_throttled_then_disconnected(relay, monkeypatch):
    """F3：token bucket 容量 10、每秒補 5；連續丟棄 30 個就斷線。時鐘固定，結果不看機器快慢。"""
    assert live_quiz.STUDENT_BUCKET_CAPACITY == 10
    assert live_quiz.STUDENT_BUCKET_REFILL_PER_SECOND == 5
    assert live_quiz.STUDENT_MAX_CONSECUTIVE_DROPS == 30
    clock = [1000.0]
    monkeypatch.setattr(live_quiz, "_clock", lambda: clock[0])

    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    sid = relay.sid_of(student)
    take(teacher)

    for index in range(11):
        answer(student, nonce=f"burst-{index}")
    assert len(take(teacher, "relay:student-answer")) == 10

    clock[0] += 1.0  # 補 5 個
    for index in range(5):
        answer(student, nonce=f"refill-{index}")
    assert len(take(teacher, "relay:student-answer")) == 5

    # 上面那一個丟棄已被成功轉送重設；接下來要再連續丟 30 個才斷線。
    for index in range(29):
        answer(student, nonce=f"flood-{index}")
    assert student.is_connected(NS)
    answer(student, nonce="flood-last")
    assert not student.is_connected(NS)

    assert take(teacher, "relay:student-answer") == []
    assert take(teacher, "relay:presence") == [{"sid": sid, "connected": False}]
    assert sid not in live_quiz.SIDS


# ── 老師 → 學生 ───────────────────────────────────────────────────────────────


def test_student_cannot_emit_teacher_events(relay):
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    mallory = relay.student(token_of(created))
    victim = relay.student(token_of(created))
    take(teacher)
    take(mallory)
    take(victim)

    mallory.emit("relay:to-students", {"payload": {"state": "ended"}}, namespace=NS)
    mallory.emit(
        "relay:to-student",
        {"sid": relay.sid_of(victim), "event": "quiz:student-state", "payload": {"x": 1}},
        namespace=NS,
    )
    assert take(victim) == []
    assert take(mallory) == []
    assert take(teacher) == []

    # 對照：同樣的事件由老師送，學生就收得到。
    teacher.emit("relay:to-students", {"payload": {"state": "lobby"}}, namespace=NS)
    assert take(victim, "quiz:student-state") == [{"state": "lobby"}]
    assert take(mallory, "quiz:student-state") == [{"state": "lobby"}]


def test_to_student_rejects_sid_of_another_session(relay):
    author, created = relay.new_session()
    other_author, other_created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    other_teacher = relay.teacher(other_author, other_created["id"])
    mine = relay.student(token_of(created))
    theirs = relay.student(token_of(other_created))
    for client in (teacher, other_teacher, mine, theirs):
        take(client)

    for target in (relay.sid_of(theirs), relay.sid_of(other_teacher), relay.sid_of(teacher), "no-such-sid"):
        teacher.emit(
            "relay:to-student",
            {"sid": target, "event": "quiz:student-state", "payload": {"leak": True}},
            namespace=NS,
        )
    assert take(theirs) == []
    assert take(other_teacher) == []
    assert take(teacher) == []
    assert take(mine) == []

    teacher.emit(
        "relay:to-student",
        {"sid": relay.sid_of(mine), "event": "quiz:answer-received", "payload": {"nonce": "n-1"}},
        namespace=NS,
    )
    assert take(mine, "quiz:answer-received") == [{"nonce": "n-1"}]
    assert take(theirs) == []


def test_to_student_rejects_unknown_event_name(relay):
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(student)
    sid = relay.sid_of(student)

    for event in ("quiz:teacher-state", "relay:student-answer", "disconnect", "message", "", None):
        teacher.emit(
            "relay:to-student", {"sid": sid, "event": event, "payload": {"x": 1}}, namespace=NS
        )
    assert take(student) == []
    assert student.is_connected(NS)

    teacher.emit(
        "relay:to-student",
        {"sid": sid, "event": "quiz:student-state", "payload": {"state": "lobby"}},
        namespace=NS,
    )
    assert take(student, "quiz:student-state") == [{"state": "lobby"}]


def test_oversized_teacher_relay_is_dropped(relay):
    assert live_quiz.MAX_TEACHER_EVENT_BYTES == 65536
    assert live_quiz.MAX_STUDENT_EVENT_BYTES == 16384
    author, created = relay.new_session()
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token_of(created))
    take(student)

    teacher.emit("relay:to-students", {"payload": {"blob": "x" * (65 * 1024)}}, namespace=NS)
    assert take(student) == []
    teacher.emit("relay:to-students", {"payload": {"blob": "x" * (40 * 1024)}}, namespace=NS)
    assert len(take(student, "quiz:student-state")) == 1


# ── 收場與寬限期 ──────────────────────────────────────────────────────────────


def test_event_after_session_end_is_not_delivered_and_socket_is_disconnected(relay):
    """F6：收場後伺服器主動斷開該場所有連線，並清掉 SIDS 與寬限期計時器。"""
    author, created = relay.new_session()
    session_id = created["id"]
    nonce = nonce_of(session_id)
    token = token_of(created)
    teacher = relay.teacher(author, session_id)
    student = relay.student(token)
    bystander_author, bystander = relay.new_session()
    bystander_teacher = relay.teacher(bystander_author, bystander["id"])
    bystander_student = relay.student(token_of(bystander))
    teacher_sid, student_sid = relay.sid_of(teacher), relay.sid_of(student)
    take(student)
    take(bystander_student)

    assert relay.end(author, session_id).status_code == 200
    assert take(student, "quiz:student-state") == [{"state": "ended"}]
    assert not student.is_connected(NS)
    assert not teacher.is_connected(NS)
    assert teacher_sid not in live_quiz.SIDS and student_sid not in live_quiz.SIDS
    assert not any(entry["nonce"] == nonce for entry in live_quiz.SIDS.values())
    # 別場不受影響。
    assert bystander_teacher.is_connected(NS) and bystander_student.is_connected(NS)
    assert take(bystander_student) == []

    # 收場後同一張 token 與老師都進不來，所以晚到的事件沒有任何可送達的對象。
    assert not relay.student(token).is_connected(NS)
    assert not relay.teacher(author, session_id).is_connected(NS)

    # 老師斷線後留下的寬限期計時器（預設 30 秒，不會在測試裡到期）也要在收場時清掉。
    pending_author, pending = relay.new_session()
    pending_nonce = nonce_of(pending["id"])
    relay.teacher(pending_author, pending["id"]).disconnect(namespace=NS)
    assert pending_nonce in live_quiz._GRACE_TIMERS
    assert relay.end(pending_author, pending["id"]).status_code == 200
    assert pending_nonce not in live_quiz._GRACE_TIMERS


def test_teacher_disconnect_beyond_grace_ends_session_and_notifies_students(relay, monkeypatch):
    monkeypatch.setattr(live_quiz, "TEACHER_GRACE_SECONDS", 0)
    author, created = relay.new_session()
    session_id = created["id"]
    nonce = nonce_of(session_id)
    teacher = relay.teacher(author, session_id)
    student = relay.student(token_of(created))
    take(student)

    teacher.disconnect(namespace=NS)
    assert wait_until(relay.socketio, lambda: session_state(session_id) == "ended")
    assert wait_until(relay.socketio, lambda: not student.is_connected(NS))
    assert take(student, "quiz:student-state") == [{"state": "ended"}]
    assert not any(entry["nonce"] == nonce for entry in live_quiz.SIDS.values())
    assert nonce not in live_quiz._GRACE_TIMERS


def test_teacher_reconnect_within_grace_keeps_session(relay, monkeypatch):
    monkeypatch.setattr(live_quiz, "TEACHER_GRACE_SECONDS", 0.2)
    author, created = relay.new_session()
    session_id = created["id"]
    teacher = relay.teacher(author, session_id)
    student = relay.student(token_of(created))
    take(student)

    teacher.disconnect(namespace=NS)
    back = relay.teacher(author, session_id)
    assert back.is_connected(NS)

    # 讓舊計時器確實醒來過（0.2 秒的好幾倍），它必須發現世代號不同而放棄。
    relay.socketio.sleep(0.6)
    relay.socketio.sleep(0)
    assert session_state(session_id) == "lobby"
    assert student.is_connected(NS)
    assert take(student, "quiz:student-state") == []

    answer(student, nonce="still-alive")
    assert [msg["data"]["nonce"] for msg in take(back, "relay:student-answer")] == ["still-alive"]


def test_teacher_second_tab_disconnect_does_not_end_session(relay, monkeypatch):
    """F6：寬限期只在老師房間已空時才結束課堂。"""
    monkeypatch.setattr(live_quiz, "TEACHER_GRACE_SECONDS", 0)
    author, created = relay.new_session()
    session_id = created["id"]
    first_tab = relay.teacher(author, session_id)
    second_tab = relay.teacher(author, session_id)
    student = relay.student(token_of(created))
    take(student)

    second_tab.disconnect(namespace=NS)
    assert nonce_of(session_id) not in live_quiz._GRACE_TIMERS
    relay.socketio.sleep(0.2)
    relay.socketio.sleep(0)
    assert session_state(session_id) == "lobby"
    assert student.is_connected(NS)
    assert take(student, "quiz:student-state") == []

    first_tab.disconnect(namespace=NS)
    assert wait_until(relay.socketio, lambda: session_state(session_id) == "ended")
    assert wait_until(relay.socketio, lambda: not student.is_connected(NS))


# ── log 衛生 ──────────────────────────────────────────────────────────────────


def test_relay_logs_no_token_or_answers(relay, caplog):
    """範圍僅限應用程式 log；eventlet 與反向代理的存取 log 不在此列（設計說明安全不變式 4）。"""
    caplog.set_level(logging.DEBUG)
    author, created = relay.new_session()
    token = token_of(created)
    teacher = relay.teacher(author, created["id"])
    student = relay.student(token)
    take(teacher)

    device_id = "device-secret-5f1c"
    nickname = "暱稱祕密王小明"
    answer_text = "answer-secret-9a7e"
    hello(student, device_id=device_id, nickname=nickname)
    answer(student, device_id=device_id, answer_value=answer_text, nonce="log-1")
    answer(student, device_id="device-secret-other", answer_value=answer_text)
    answer(student, device_id=device_id, answer_value=answer_text * 2000)
    teacher.emit(
        "relay:to-student",
        {"sid": relay.sid_of(student), "event": "quiz:answer-received", "payload": {"nonce": "log-1"}},
        namespace=NS,
    )
    relay.student(token + "tampered")
    relay.student("garbage-token-secret")
    student.disconnect(namespace=NS)

    delivered = take(teacher, "relay:student-answer")
    assert [msg["data"]["answer"] for msg in delivered] == [answer_text]

    logged = caplog.text
    for secret in (token, device_id, "device-secret-other", nickname, answer_text, "garbage-token-secret"):
        assert secret not in logged
