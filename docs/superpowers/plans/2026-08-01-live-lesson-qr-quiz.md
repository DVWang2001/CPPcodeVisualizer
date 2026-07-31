# QR Code 即時作答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在教案播放命中已綁定程式碼行時自動開啟單選題，讓內網學生掃 QR Code 後作答，教師即時取得正確且不重複的答對統計。

**Architecture:** 教案 bundle 保存題目與可重定位的 source anchor；Flask/SQLite 建立不可變的課堂題目快照並以精確公開白名單服務匿名學生；既有 Flask-SocketIO 推播狀態。教師端在 `Actions.inferior_program_paused()` 同步設播放 gate，再呼叫 trigger API；學生使用獨立、精簡的 React entry page，避免下載 GDB/Monaco。

**Tech Stack:** Python 3 / Flask 3 / stdlib sqlite3 / itsdangerous / Flask-SocketIO 5；React 16 / TypeScript 3.3 / Monaco 0.21 / Jest 24；Python `qrcode` SVG；Playwright 1.44 + test-only `jsqr`。

## Global Constraints

* 學生免登入、填暱稱；同一 HttpOnly guest credential 對同題只能提交一次。這不是強身分，清 cookie 或換裝置仍可重新加入。
* 第一版只支援每題 2–6 個選項且唯一正解；每篇最多 30 題，題幹 500 字、選項 200 字、解說 1,000 字。
* 題目只能由 GDB 真正停在已解析的 source file + line 時自動觸發；不提供手動開題，同場最多一題 open，同題每場只觸發一次。
* 播放 gate 必須同步擋住 next、step、continue、return 與 autoplay；trigger/close 失敗時不得偷偷續播。
* `MOBILE_JOIN_BASE_URL` 必須是無 query/fragment 的絕對 HTTP(S) URL，且不得使用 localhost、loopback、`0.0.0.0` 或 `::`。
* 學生在關題前不得從任何 HTTP/Socket payload 取得 `correct_option_id` 或 `explanation`。
* 結束課堂時刪除暱稱、credential hash 與逐筆 response，只保留匿名聚合統計。
* 公開範圍只能是精確 endpoint 名稱；不得豁免整個 blueprint 或 URL prefix。所有教師寫入沿用登入、owner、同源與 CSRF。
* 目標容量是 60 位同時答題；最終聚合必須完全正確，教師在三秒內收到最終狀態。
* 不增加外部字型、UI 框架、ORM、通用 event bus 或 QR 前端套件。沿用 Bootstrap、store、Socket.IO 與 SQLite。

## UX Direction

主題是「C++ 課堂裡的一張即時答題卡」，受眾是需要在幾秒內完成作答的學生與正在看程式碼的教師。學生頁的唯一工作是讀題與送出；教師面板的唯一工作是確認連線、觀察統計、關題並繼續。

* 色彩：Ink `#172033`、Slate `#34415A`、Classroom cyan `#1F8A9E`、Attention amber `#E2A93B`、Correct green `#2F855A`、Paper `#F7F9FC`。
* 字體：正文使用系統無襯線 `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；source line、數字與狀態使用現有 monospace。內網不下載 web font。
* 教師面板：安靜的 Bootstrap 卡片；QR 在左、加入數與題目狀態在右；open 後以選項橫條呈現分布。
* 學生頁：320px 起可用的單欄答題卡；頂端是一條具識別性的 source ticket（`example.cpp · line 18`），把題目與播放位置連起來。
* 唯一動態效果是 open 題目時 source ticket 淡入一次；`prefers-reduced-motion: reduce` 時完全停用。
* 所有互動至少 44×44px，有可見 focus ring、`aria-live="polite"`，正誤同時使用文字／圖示，不能只靠顏色。

```text
教師桌機                         學生手機
┌──────── QR ────────┬────────┐  ┌─ example.cpp · line 18 ─┐
│ █ ▄▄ █  掃碼加入   │ 已加入 │  │ 迴圈第一次後 i 是多少？ │
│ ▄ █ ▄  http://…    │ 28     │  │ ○ 0                   │
│                    │ 已答 21 │  │ ● 1                   │
│                    │ 答對 17 │  │ ○ 2                   │
└────────────────────┴────────┘  │       [送出答案]        │
                                  └─────────────────────────┘
```

---

### Task 1: Quiz bundle schema and source anchors

**Files:**
- Create: `gdbgui/src/js/quizSchema.ts`
- Create: `gdbgui/src/js/quizTrigger.ts`
- Create: `gdbgui/src/js/tests/quizSchema.jest.ts`
- Create: `gdbgui/src/js/tests/quizTrigger.jest.ts`
- Modify: `gdbgui/src/js/lessonVersion.ts`

**Interfaces:**
- Produces: `QuizSpec`, `QuizQuestion`, `QuizOption`, `QuizTrigger`, `QuizValidation` types.
- Produces: `validateQuiz(raw: unknown, sourceCode: string): QuizValidation` and `cloneQuiz(quiz: QuizSpec | null): QuizSpec | null`.
- Produces: `makeSourceTrigger(sourceCode: string, sourceFile: string, line: number): QuizTrigger`.
- Produces: `resolveSourceTrigger(trigger: QuizTrigger, sourceCode: string): {trigger: QuizTrigger; resolved: boolean; reason?: string}`.
- Produces: `triggerMatchesFrame(trigger: QuizTrigger, frame: {fullname?: string; file?: string; line?: string | number}): boolean`.
- Consumes: existing `stripDirective()` from `sourceAnnotations.ts`; `LessonBundle.quiz` becomes typed but remains optional.

- [ ] **Step 1: Write failing schema tests**

```typescript
import { validateQuiz } from "../quizSchema";

const source = "int main() {\n  int i = 0;\n  i++;\n  return 0;\n}";
const question = {
  id: "q1", prompt: "i 是多少？",
  options: [{ id: "a", text: "0" }, { id: "b", text: "1" }],
  correct_option_id: "b", explanation: "i++ 會遞增。",
  trigger: {
    kind: "source_line", source_file: "main.cpp", line: 3,
    anchor: { line_text: "i++;", before_text: "int i = 0;", after_text: "return 0;" }
  }
};

test("accepts a valid single-choice quiz", () => {
  expect(validateQuiz({ schema_version: 1, questions: [question] }, source).errors).toEqual([]);
});

test.each([
  [{ ...question, prompt: "" }, "題幹"],
  [{ ...question, options: [{ id: "a", text: "0" }] }, "選項"],
  [{ ...question, correct_option_id: "missing" }, "正解"],
  [{ ...question, surprise: true }, "未知欄位"],
])("rejects invalid question %#", (bad, fragment) => {
  expect(validateQuiz({ schema_version: 1, questions: [bad] }, source).errors.join(" ")).toContain(fragment);
});
```

- [ ] **Step 2: Run schema tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/quizSchema.jest.ts`

Expected: FAIL because `../quizSchema` does not exist.

- [ ] **Step 3: Implement the minimal schema parser**

```typescript
export type QuizOption = { id: string; text: string };
export type QuizAnchor = { line_text: string; before_text: string; after_text: string };
export type QuizTrigger = { kind: "source_line"; source_file: string; line: number; anchor: QuizAnchor };
export type QuizQuestion = {
  id: string; prompt: string; options: QuizOption[];
  correct_option_id: string; explanation: string; trigger: QuizTrigger;
};
export type QuizSpec = { schema_version: 1; questions: QuizQuestion[] };
export type QuizValidation = { quiz: QuizSpec | null; errors: string[] };

const QUIZ_KEYS = ["schema_version", "questions"];
const QUESTION_KEYS = ["id", "prompt", "options", "correct_option_id", "explanation", "trigger"];
const OPTION_KEYS = ["id", "text"];
const TRIGGER_KEYS = ["kind", "source_file", "line", "anchor"];
const ANCHOR_KEYS = ["line_text", "before_text", "after_text"];

const hasOnlyKeys = (value: object, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
```

`validateQuiz` applies these checks in order and collects user-facing errors rather than throwing: `undefined`/`null` normalizes to `null`; otherwise the root must contain exactly `schema_version: 1` and `questions`; questions must be an array of at most 30 exact-key objects; ids must be non-empty and unique; prompt must contain 1–500 characters; options must contain 2–6 exact-key objects with unique non-empty ids and 1–200-character text; `correct_option_id` must name exactly one option; explanation must be a string of at most 1,000 characters; trigger and anchor must have the exact keys above; kind must equal `source_line`; source file must have a non-empty basename; line must be a positive integer; and `resolveSourceTrigger` must find exactly one matching non-empty source line. Return a deep clone only when the error list is empty. An empty questions array is valid for saving but blocks starting a session later. Use these local helpers instead of adding a validation library.

- [ ] **Step 4: Write failing anchor tests**

```typescript
import { makeSourceTrigger, resolveSourceTrigger, triggerMatchesFrame } from "../quizTrigger";

const original = "int main() {\n  int i = 0;\n  i++;\n  return 0;\n}";

test("relocates a unique three-line anchor after insertion", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);
  const moved = resolveSourceTrigger(trigger, "// intro\n" + original);
  expect(moved.resolved).toBe(true);
  expect(moved.trigger.line).toBe(4);
});

test("does not guess when an anchor occurs twice", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);
  const duplicate = original + "\nint main() {\n  int i = 0;\n  i++;\n  return 0;\n}";
  expect(resolveSourceTrigger(trigger, duplicate).resolved).toBe(false);
});

test("matches normalized basename and exact positive line", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);
  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/run/main.cpp", line: "3" })).toBe(true);
  expect(triggerMatchesFrame(trigger, { fullname: "/usr/include/main.cpp", line: "4" })).toBe(false);
});
```

- [ ] **Step 5: Run anchor tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/quizTrigger.jest.ts`

Expected: FAIL because `../quizTrigger` does not exist.

- [ ] **Step 6: Implement anchor creation, relocation and frame matching**

```typescript
export const normalizedSourceLine = (line: string): string =>
  stripDirective(line).trim().replace(/\s+/g, " ");

export function makeSourceTrigger(sourceCode: string, sourceFile: string, line: number): QuizTrigger {
  const lines = sourceCode.split("\n").map(normalizedSourceLine);
  if (!Number.isInteger(line) || line < 1 || line > lines.length || !lines[line - 1]) {
    throw new Error("請把題目綁定到非空白的程式碼行。");
  }
  return {
    kind: "source_line", source_file: basename(sourceFile), line,
    anchor: { line_text: lines[line - 1], before_text: lines[line - 2] || "", after_text: lines[line] || "" }
  };
}
```

`resolveSourceTrigger` first checks the stored line, then scans all lines for exact anchor triples and accepts exactly one candidate. `triggerMatchesFrame` compares basename case-insensitively on Windows-style paths and exactly elsewhere by normalizing both `/` and `\\` separators to `/`.

- [ ] **Step 7: Run focused and full Jest suites**

Run: `npm test -- --runInBand gdbgui/src/js/tests/quizSchema.jest.ts gdbgui/src/js/tests/quizTrigger.jest.ts`

Expected: both suites PASS.

Run: `npm test -- --runInBand`

Expected: all existing and new suites PASS.

- [ ] **Step 8: Commit Task 1**

```powershell
git add gdbgui/src/js/quizSchema.ts gdbgui/src/js/quizTrigger.ts gdbgui/src/js/lessonVersion.ts gdbgui/src/js/tests/quizSchema.jest.ts gdbgui/src/js/tests/quizTrigger.jest.ts
git commit -m "feat: define lesson quiz schema and anchors"
```

### Task 2: SQLite session snapshot and atomic answer counting

**Files:**
- Create: `gdbgui/server/migrations/0005_live_quiz.sql`
- Create: `gdbgui/server/live_quiz.py`
- Create: `tests/test_live_quiz_db.py`
- Create: `tests/test_live_quiz_concurrency.py`
- Modify: `gdbgui/server/http_routes.py:1584-1623`

**Interfaces:**
- Produces: `QuizRejected`, `validate_quiz_bundle(bundle: object) -> Optional[dict]` mirroring Task 1 limits.
- Produces: `create_session(owner_id: int, lesson_id: int) -> Optional[dict]`.
- Produces: `session_owned_by(session_id: int, owner_id: int) -> Optional[dict]`.
- Produces: `trigger_question(session_id: int, owner_id: int, question_key: str, source_file: str, line: int) -> Optional[dict]`.
- Produces: `close_question(session_id: int, owner_id: int, question_key: str) -> Optional[dict]` and `end_session(session_id: int, owner_id: int) -> Optional[dict]`.
- Produces: `join_session(session_id: int, nickname: str, credential_hash: str) -> dict`, `answer_question(credential_hash: str, question_key: str, option_id: str) -> dict`, and `guest_state(credential_hash: str) -> Optional[dict]`.
- Consumes: `db.connect()`, `db._now()`, current `lessons`, `lesson_versions`, `users` tables.

- [ ] **Step 1: Write migration and snapshot tests first**

```python
def test_live_quiz_migration_is_idempotent(flask_app):
    assert db.schema_version() >= 5
    assert db.migrate() == 0

def test_session_copies_the_current_lesson_quiz(flask_app):
    owner = register_user(flask_app)
    lesson_id = db.create_lesson(owner.user_id, "迴圈", json.dumps(valid_bundle()))
    created = live_quiz.create_session(owner.user_id, lesson_id)
    assert created["title"] == "迴圈"
    assert created["questions"][0]["prompt"] == "i 是多少？"
    db.update_lesson_owned_by(lesson_id, owner.user_id, "改過", json.dumps(other_bundle()))
    assert live_quiz.session_owned_by(created["id"], owner.user_id)["questions"][0]["prompt"] == "i 是多少？"
```

- [ ] **Step 2: Run migration/snapshot tests and confirm RED**

Run: `python -m pytest tests/test_live_quiz_db.py -q`

Expected: FAIL because `gdbgui.server.live_quiz` and migration 0005 do not exist.

- [ ] **Step 3: Add the exact four tables and indexes from the spec**

Create `0005_live_quiz.sql` with `live_quiz_sessions`, `live_quiz_questions`, `live_quiz_participants`, `live_quiz_responses`, their CHECK/UNIQUE/FK constraints, and the three named indexes. Keep every statement idempotent with `IF NOT EXISTS`.

- [ ] **Step 4: Implement bundle validation and session snapshot**

```python
class QuizRejected(ValueError):
    pass

QUIZ_KEYS = frozenset(("schema_version", "questions"))
QUESTION_KEYS = frozenset(("id", "prompt", "options", "correct_option_id", "explanation", "trigger"))
OPTION_KEYS = frozenset(("id", "text"))
TRIGGER_KEYS = frozenset(("kind", "source_file", "line", "anchor"))
ANCHOR_KEYS = frozenset(("line_text", "before_text", "after_text"))

def _require_exact_keys(value, keys, message):
    if not isinstance(value, dict) or set(value) != keys:
        raise QuizRejected(message)
```

`validate_quiz_bundle` mirrors every Task 1 type, exact-key, size, uniqueness, correct-option and source-anchor check, but raises `QuizRejected` at the first invalid boundary. It deep-copies valid JSON through `json.loads(json.dumps(raw))`. `create_session` begins `IMMEDIATE`, selects the lesson and its current version with `WHERE lessons.id=? AND lessons.owner_id=?`, validates the decoded bundle, rejects a missing/empty quiz, inserts one `live_quiz_sessions` row and one immutable `live_quiz_questions` snapshot row per question, commits, then returns `session_owned_by`. `http_routes._lesson_payload()` must call `validate_quiz_bundle(fields["bundle"])`; map `QuizRejected` to the existing 400 lesson-invalid response so malformed quiz data never enters lesson history.

- [ ] **Step 5: Write atomic trigger/answer/end tests**

```python
def test_question_triggers_once_and_answer_retry_is_idempotent(session_fixture):
    session, credential_hash = session_fixture
    first = live_quiz.trigger_question(session["id"], session["owner_id"], "q1", "main.cpp", 3)
    second = live_quiz.trigger_question(session["id"], session["owner_id"], "q1", "main.cpp", 3)
    assert first["active_question"]["id"] == "q1"
    assert second["active_question"]["id"] == "q1"
    one = live_quiz.answer_question(credential_hash, "q1", "b")
    retry = live_quiz.answer_question(credential_hash, "q1", "a")
    assert one["inserted"] is True
    assert retry["inserted"] is False
    assert retry["selected_option_id"] == "b"
    assert retry["stats"]["answer_count"] == 1

def test_end_keeps_aggregates_and_deletes_identity(session_fixture):
    session, credential_hash = session_fixture
    live_quiz.trigger_question(session["id"], session["owner_id"], "q1", "main.cpp", 3)
    live_quiz.answer_question(credential_hash, "q1", "b")
    ended = live_quiz.end_session(session["id"], session["owner_id"])
    assert ended["questions"][0]["correct_count"] == 1
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM live_quiz_participants WHERE session_id=?", (session["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM live_quiz_responses").fetchone()[0] == 0
```

Create the concurrency test before implementing answer counting:

```python
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256

def _join(session_id, index):
    credential_hash = sha256(f"credential-{index}".encode()).hexdigest()
    live_quiz.join_session(session_id, f"學生{index}", credential_hash)
    return credential_hash

def test_sixty_students_are_counted_exactly(active_question):
    credentials = [_join(active_question.session_id, index) for index in range(60)]
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda value: live_quiz.answer_question(value, "q1", "b"), credentials))
    question = live_quiz.session_owned_by(
        active_question.session_id, active_question.owner_id
    )["questions"][0]
    assert sum(result["inserted"] for result in results) == 60
    assert question["answer_count"] == question["correct_count"] == 60
    assert question["option_counts"] == {"a": 0, "b": 60}
```

- [ ] **Step 6: Run tests and confirm RED for missing state transitions**

Run: `python -m pytest tests/test_live_quiz_db.py tests/test_live_quiz_concurrency.py -q`

Expected: snapshot tests PASS; trigger/answer/end/concurrency tests FAIL because those state transitions are absent.

- [ ] **Step 7: Implement minimal transactional state transitions**

Every mutation opens its own connection, executes `BEGIN IMMEDIATE`, verifies owner/credential and state inside that transaction, and commits before returning. `answer_question` uses the composite primary key for idempotence; on `sqlite3.IntegrityError`, read and return the existing answer without changing aggregates. Increment `option_counts_json` inside the same write transaction.

- [ ] **Step 8: Run focused backend tests**

Run: `python -m pytest tests/test_live_quiz_db.py tests/test_live_quiz_concurrency.py tests/test_lesson_sharing.py -q`

Expected: PASS, including all 60 unique answers and existing lesson version/fork behavior.

- [ ] **Step 9: Commit Task 2**

```powershell
git add gdbgui/server/migrations/0005_live_quiz.sql gdbgui/server/live_quiz.py gdbgui/server/http_routes.py tests/test_live_quiz_db.py tests/test_live_quiz_concurrency.py
git commit -m "feat: persist live quiz sessions and answers"
```

### Task 3: Teacher/guest HTTP security and QR SVG

**Files:**
- Modify: `gdbgui/server/live_quiz.py`
- Modify: `gdbgui/server/app.py:24-165`
- Modify: `gdbgui/server/http_util.py:18-35,150-170`
- Modify: `requirements.in`
- Modify: `requirements.txt`
- Create: `gdbgui/templates/quiz_join.html`
- Create: `tests/test_live_quiz_api.py`
- Modify: `tests/test_route_gate.py:138-149`

**Interfaces:**
- Produces Flask Blueprint `blueprint = Blueprint("live_quiz", __name__)` with every endpoint from the spec.
- Produces `PUBLIC_ENDPOINTS` additions for exact join/guest endpoint names and `CSRF_EXEMPT_ENDPOINTS` containing only `live_quiz.guest_join` and `live_quiz.guest_answer`.
- Produces `make_join_token(session_row) -> str`, `load_join_token(token, max_age=28800) -> Optional[int]`, and `validated_mobile_base_url(value: str) -> str`.
- Produces cookie `gdbgui_quiz_guest`: random 32 bytes, HttpOnly, SameSite=Lax, Secure iff configured, Max-Age 28800.
- Consumes Task 2 DB functions and Flask persistent `app.secret_key`.

- [ ] **Step 1: Write failing authorization and guest-boundary tests**

```python
def test_teacher_routes_require_owner_and_csrf(author, other, quiz_lesson):
    created = author.http.post("/api/live-quiz/sessions", json={"lesson_id": quiz_lesson}, headers={"x-csrftoken": author.csrf})
    assert created.status_code == 201
    session_id = created.get_json()["id"]
    assert other.http.get(f"/api/live-quiz/sessions/{session_id}").status_code == 404
    assert author.http.post(f"/api/live-quiz/sessions/{session_id}/end").status_code == 403

def test_only_exact_guest_endpoints_are_public(flask_app):
    expected = {"auth.login", "auth.register", "auth.logout", "static",
                "live_quiz.join_page", "live_quiz.guest_join",
                "live_quiz.guest_state", "live_quiz.guest_answer"}
    assert PUBLIC_ENDPOINTS == frozenset(expected)
    assert CSRF_EXEMPT_ENDPOINTS == frozenset({"live_quiz.guest_join", "live_quiz.guest_answer"})
```

- [ ] **Step 2: Run API tests and confirm RED**

Run: `python -m pytest tests/test_live_quiz_api.py tests/test_route_gate.py -q`

Expected: FAIL because blueprint, endpoint allowlists and routes are absent.

- [ ] **Step 3: Add token, URL and cookie tests**

```python
@pytest.mark.parametrize("bad", ["", "localhost:5000", "http://localhost:5000", "http://127.0.0.1:5000", "http://0.0.0.0:5000", "http://[::1]:5000", "ftp://10.0.0.2/x", "http://10.0.0.2/x?q=1"])
def test_mobile_base_url_rejects_unreachable_or_unsafe_values(bad):
    with pytest.raises(live_quiz.QuizRejected):
        live_quiz.validated_mobile_base_url(bad)

def test_join_sets_only_a_hashed_guest_credential(client, active_join_token):
    response = client.post("/api/live-quiz/guest/join", json={"token": active_join_token, "nickname": "小明"}, headers={"Origin": "http://localhost"})
    assert response.status_code == 200
    assert "gdbgui_quiz_guest=" in response.headers["Set-Cookie"]
    assert "HttpOnly" in response.headers["Set-Cookie"]
    with closing(db.connect()) as conn:
        row = conn.execute("SELECT credential_hash FROM live_quiz_participants").fetchone()
    assert len(row[0]) == 64
    assert row[0] not in response.headers["Set-Cookie"]
```

- [ ] **Step 4: Run new tests and confirm RED**

Run: `python -m pytest tests/test_live_quiz_api.py -q`

Expected: FAIL at missing URL/token/cookie helpers.

- [ ] **Step 5: Implement blueprint and narrow CSRF exemption**

```python
# app.py before_request order remains: cross-origin check first, then exact exemption.
if request.method in ["POST", "PUT", "DELETE", "PATCH"]:
    if request.endpoint in CSRF_EXEMPT_ENDPOINTS:
        return None
    # existing CSRF token validation unchanged
```

Register `live_quiz.blueprint` in `app.py`. Join/guest routes validate signed token or hashed cookie and session state themselves. Teacher routes obtain owner only from `current_user_id()`. Route errors use 400 for malformed input, 404 for absent/non-owner, 409 for invalid state, and 410 for an ended invitation.

- [ ] **Step 6: Add QR dependency and endpoint**

Add `qrcode>=8,<9` to `requirements.in`, run `pip-compile requirements.in`, and use `qrcode.image.svg.SvgPathImage` to return an in-memory SVG with `Content-Type: image/svg+xml` and `Cache-Control: no-store`. No PNG/Pillow production path is needed.

Run: `python -m pytest tests/test_live_quiz_api.py tests/test_route_gate.py -q`

Expected: PASS; QR test asserts its decoded XML contains an SVG path and response headers are no-store.

- [ ] **Step 7: Commit Task 3**

```powershell
git add gdbgui/server/live_quiz.py gdbgui/server/app.py gdbgui/server/http_util.py gdbgui/templates/quiz_join.html requirements.in requirements.txt tests/test_live_quiz_api.py tests/test_route_gate.py
git commit -m "feat: expose secure live quiz and QR APIs"
```

### Task 4: Socket.IO rooms and complete-state reconnect

**Files:**
- Modify: `gdbgui/server/live_quiz.py`
- Modify: `gdbgui/server/app.py:109-165`
- Create: `tests/test_live_quiz_socket.py`

**Interfaces:**
- Produces: `register_socket_handlers(socketio) -> None`, called once after `socketio = SocketIO(...)`.
- Produces rooms `live_quiz:<session_id>:teacher` and `live_quiz:participant:<participant_id>`.
- Produces events `quiz:teacher-state`, `quiz:stats`, `quiz:student-state`.
- Produces `emit_teacher_state(session_id)` and `emit_student_states(session_id)` called only after DB commit.
- Consumes teacher Flask login session or guest HttpOnly cookie; clients cannot choose a participant id.

- [ ] **Step 1: Write failing socket authentication/reconnect tests**

```python
def test_teacher_socket_requires_owner(socketio, flask_app, active_session, author, other):
    ok = socketio.test_client(flask_app, namespace="/lesson_quiz", flask_test_client=author.http,
                              auth={"role": "teacher", "session_id": active_session["id"]})
    denied = socketio.test_client(flask_app, namespace="/lesson_quiz", flask_test_client=other.http,
                                  auth={"role": "teacher", "session_id": active_session["id"]})
    assert ok.is_connected("/lesson_quiz")
    assert not denied.is_connected("/lesson_quiz")
    assert any(p["name"] == "quiz:teacher-state" for p in ok.get_received("/lesson_quiz"))

def test_student_reconnect_receives_personal_closed_result(student_socket):
    packets = student_socket.get_received("/lesson_quiz")
    state = next(p["args"][0] for p in packets if p["name"] == "quiz:student-state")
    assert state["active_question"]["result"] == {"is_correct": True, "correct_option_id": "b", "explanation": "i++ 會遞增。"}
```

- [ ] **Step 2: Run socket tests and confirm RED**

Run: `python -m pytest tests/test_live_quiz_socket.py -q`

Expected: FAIL because `/lesson_quiz` handlers are not registered.

- [ ] **Step 3: Implement authenticated connect handlers and emit helpers**

```python
def register_socket_handlers(socketio):
    @socketio.on("connect", namespace="/lesson_quiz")
    def connect_live_quiz(auth=None):
        if is_cross_origin(request):
            return False
        if (auth or {}).get("role") == "teacher":
            session = session_owned_by((auth or {}).get("session_id"), current_user_id())
            if session is None:
                return False
            join_room(f"live_quiz:{session['id']}:teacher")
            emit("quiz:teacher-state", session)
            return True
        credential_hash = hash_guest_cookie(request.cookies.get(GUEST_COOKIE))
        state = guest_state(credential_hash) if credential_hash else None
        if state is None:
            return False
        join_room(f"live_quiz:participant:{state['participant_id']}")
        emit("quiz:student-state", state)
        return True
```

Mutation routes call emit helpers after the DB function has committed. Answer emits teacher stats and the answering participant state; close emits all participant states so each receives only their own result.

- [ ] **Step 4: Verify socket and API suites**

Run: `python -m pytest tests/test_live_quiz_socket.py tests/test_live_quiz_api.py tests/test_execution_isolation.py -q`

Expected: PASS and existing `/gdb_listener` isolation remains green.

- [ ] **Step 5: Commit Task 4**

```powershell
git add gdbgui/server/live_quiz.py gdbgui/server/app.py tests/test_live_quiz_socket.py
git commit -m "feat: broadcast live quiz state"
```

### Task 5: Teacher question authoring and bundle persistence

**Files:**
- Create: `gdbgui/src/js/QuizAuthoringDialog.tsx`
- Create: `gdbgui/src/js/tests/quizAuthoring.jest.ts`
- Modify: `gdbgui/src/js/SourceCode.tsx:1120-1315,1450-1700`
- Modify: `gdbgui/src/js/lessonVersion.ts`

**Interfaces:**
- Produces component props `QuizAuthoringDialog({ quiz, sourceCode, sourceFile, getCursorLine, onSave, onClose })`.
- Produces pure functions `addQuestion`, `removeQuestion`, `moveQuestion`, `bindQuestion` in `quizSchema.ts` for low-cost Jest tests.
- SourceCode owns `lessonQuizDraft: QuizSpec | null`; saving dialog updates `lessonBundleTemplate.quiz`, so existing `lessonBundleForSave()` and version diff persist it.
- Consumes Task 1 schema/trigger functions and existing `mergeLessonBundle()`.

- [ ] **Step 1: Write failing immutable-authoring tests**

```typescript
test("bindQuestion captures the current Monaco line without mutating input", () => {
  const original = emptyQuiz();
  const withQuestion = addQuestion(original);
  const bound = bindQuestion(withQuestion, withQuestion.questions[0].id, source, "main.cpp", 3);
  expect(original.questions).toEqual([]);
  expect(bound.questions[0].trigger.line).toBe(3);
});

test("moveQuestion preserves ids and changes only order", () => {
  const quiz = quizWithIds(["q1", "q2"]);
  expect(moveQuestion(quiz, "q2", -1).questions.map(q => q.id)).toEqual(["q2", "q1"]);
  expect(quiz.questions.map(q => q.id)).toEqual(["q1", "q2"]);
});
```

- [ ] **Step 2: Run authoring tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/quizAuthoring.jest.ts`

Expected: FAIL because authoring helpers are absent.

- [ ] **Step 3: Implement pure authoring helpers, then component**

Use `window.crypto.getRandomValues()` when available and a timestamp/counter fallback only for non-security question/option ids. The dialog uses controlled text inputs/radios, exact limit counters, Up/Down/Delete buttons, and “綁定目前行”. `onSave` runs `validateQuiz`; errors remain beside the affected card and unresolved anchors cannot be saved.

```tsx
<button type="button" className="btn btn-primary" onClick={save} disabled={errors.length > 0}>
  儲存題目
</button>
```

- [ ] **Step 4: Wire the dialog into SourceCode without duplicating save logic**

Add “課堂題目” beside existing lesson controls. Initialize from `lessonBundleTemplate.quiz`; on save replace only that key and let existing lesson save/version dialog persist and diff it. On lesson load/import call Task 1 validation and surface unresolved anchors before allowing lesson/session save.

- [ ] **Step 5: Verify Jest and production build**

Run: `npm test -- --runInBand gdbgui/src/js/tests/quizAuthoring.jest.ts gdbgui/src/js/tests/lessonVersion.jest.ts`

Expected: PASS.

Run: `$env:NODE_OPTIONS='--openssl-legacy-provider'; npm run build`

Expected: webpack exits 0 and generates bundles.

- [ ] **Step 6: Commit Task 5**

```powershell
git add gdbgui/src/js/QuizAuthoringDialog.tsx gdbgui/src/js/quizSchema.ts gdbgui/src/js/SourceCode.tsx gdbgui/src/js/lessonVersion.ts gdbgui/src/js/tests/quizAuthoring.jest.ts
git commit -m "feat: author quiz questions in lessons"
```

### Task 6: Teacher live panel and automatic playback gate

**Files:**
- Create: `gdbgui/src/js/liveQuizClient.ts`
- Create: `gdbgui/src/js/lessonQuizRuntime.ts`
- Create: `gdbgui/src/js/LiveQuizPanel.tsx`
- Create: `gdbgui/src/js/tests/lessonQuizRuntime.jest.ts`
- Modify: `gdbgui/src/js/Actions.ts:55-175`
- Modify: `gdbgui/src/js/GdbApi.tsx:640-750,1010-1075`
- Modify: `gdbgui/src/js/ControlButtons.tsx:1-155`
- Modify: `gdbgui/src/js/InitialStoreData.ts:35-55`
- Modify: `gdbgui/src/js/SourceCode.tsx`

**Interfaces:**
- Produces fetch methods `createLiveSession`, `getLiveSession`, `triggerLiveQuestion`, `closeLiveQuestion`, `endLiveSession`.
- Produces `lessonQuizRuntime.activate(session, quiz, callbacks)`, `.deactivate()`, `.onGdbPause(frame): boolean`, `.retryTrigger()`.
- Produces store key `quiz_playback_gate: boolean` and pure `isQuizPlaybackBlocked(storeLike): boolean`.
- Consumes Task 1 `triggerMatchesFrame`, Task 3 APIs, Task 4 Socket.IO namespace.

- [ ] **Step 1: Write failing runtime gate tests**

```typescript
test("opens the gate synchronously before trigger promise settles", () => {
  const deferred = pendingPromise();
  const runtime = makeRuntime({ trigger: () => deferred.promise, setGate });
  runtime.activate(sessionWithReadyQuestionAt("main.cpp", 3));
  expect(runtime.onGdbPause({ fullname: "/tmp/main.cpp", line: "3" })).toBe(true);
  expect(setGate).toHaveBeenCalledWith(true);
  expect(runtime.onGdbPause({ fullname: "/tmp/main.cpp", line: "3" })).toBe(false);
});

test("failed trigger keeps the gate and exposes retry", async () => {
  const runtime = makeRuntime({ trigger: () => Promise.reject(new Error("offline")), setGate });
  runtime.activate(sessionWithReadyQuestionAt("main.cpp", 3));
  runtime.onGdbPause({ fullname: "main.cpp", line: 3 });
  await flushPromises();
  expect(runtime.state().error).toContain("無法開啟題目");
  expect(setGate).not.toHaveBeenCalledWith(false);
});
```

- [ ] **Step 2: Run runtime tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/lessonQuizRuntime.jest.ts`

Expected: FAIL because runtime and gate helpers do not exist.

- [ ] **Step 3: Implement the runtime and client adapter**

Keep one module-level active runtime because the application has one teaching playback. The runtime tracks triggered/in-flight question ids and has no generic event bus. `onGdbPause` sets gate before starting fetch; successful close clears it; stop/restart/end calls `deactivate()`.

- [ ] **Step 4: Write failing behavioral integration tests for Actions/GdbApi**

```typescript
test("a matched pause suppresses narration", () => {
  jest.spyOn(lessonQuizRuntime, "onGdbPause").mockReturnValue(true);
  const narration = jest.spyOn(VisualizerHelper, "play_tts");
  Actions.inferior_program_paused({ fullname: "/tmp/main.cpp", line: "3", func: "main" });
  expect(narration).not.toHaveBeenCalled();
});

test.each([
  "click_continue_button", "click_next_button", "click_step_button", "click_return_button"
])("%s does not resume or send a command while the quiz gate is closed", name => {
  store.set("quiz_playback_gate", true);
  const send = jest.spyOn(GdbApi, "run_gdb_command");
  const resume = jest.spyOn(Actions, "inferior_program_resuming");
  (GdbApi as any)[name]();
  expect(send).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test("autoplay rechecks the gate after an animation barrier", async () => {
  const barrier = pendingPromise<void>();
  const advance = jest.spyOn(GdbApi, "click_next_button");
  (window as any).gdbgui_bst_anim_done = barrier.promise;
  (window as any).gdbgui_execute_autoplay_command("next");
  store.set("quiz_playback_gate", true);
  barrier.resolve();
  await flushPromises();
  expect(advance).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run integration tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/lessonQuizRuntime.jest.ts`

Expected: FAIL because Actions/GdbApi are not wired to the gate.

- [ ] **Step 6: Wire gate at the shared execution points**

`Actions.inferior_program_paused(frame)` calls runtime before TTS; if matched, call `Actions.stop_tts()` and skip `play_tts`. Put the shared `isQuizPlaybackBlocked()` guard at the first line of each four public execution action methods, before a for-loop virtual step can mutate state. Both checks inside `gdbgui_execute_autoplay_command` (before and after animation wait) return when the gate is true. `inferior_program_starting`, `inferior_program_exited`, explicit end session and entering edit mode deactivate the runtime.

- [ ] **Step 7: Build the teacher panel**

Render session setup, QR `<img>`, copyable URL, joined count, current source ticket, distribution bars, retry, “結束作答並繼續” and “結束課堂”. Do not add manual question buttons. Disable playback controls from `quiz_playback_gate`, but leave stop/restart available to clear a stuck session.

- [ ] **Step 8: Verify runtime, full Jest and build**

Run: `npm test -- --runInBand gdbgui/src/js/tests/lessonQuizRuntime.jest.ts`

Expected: PASS.

Run: `npm test -- --runInBand`

Expected: all suites PASS.

Run: `$env:NODE_OPTIONS='--openssl-legacy-provider'; npm run build`

Expected: webpack exits 0.

- [ ] **Step 9: Commit Task 6**

```powershell
git add gdbgui/src/js/liveQuizClient.ts gdbgui/src/js/lessonQuizRuntime.ts gdbgui/src/js/LiveQuizPanel.tsx gdbgui/src/js/Actions.ts gdbgui/src/js/GdbApi.tsx gdbgui/src/js/ControlButtons.tsx gdbgui/src/js/InitialStoreData.ts gdbgui/src/js/SourceCode.tsx gdbgui/src/js/tests/lessonQuizRuntime.jest.ts
git commit -m "feat: trigger quizzes during lesson playback"
```

### Task 7: Mobile student app

**Files:**
- Create: `gdbgui/src/js/studentQuiz.tsx`
- Create: `gdbgui/src/js/studentQuizState.ts`
- Create: `gdbgui/src/js/tests/studentQuizState.jest.ts`
- Create: `gdbgui/src/css/studentQuiz.css`
- Modify: `webpack.config.js`
- Modify: `gdbgui/templates/quiz_join.html`

**Interfaces:**
- Produces reducer states `joining | waiting | open | answered | closed | ended | reconnecting | error`.
- Produces guest calls `join(token, nickname)`, `getState()`, `answer(questionId, optionId)` and guest socket reconnect.
- Produces Webpack entry `studentQuiz` and `/static/js/studentQuiz.js`.
- Consumes Task 3 join template/API and Task 4 `quiz:student-state`; receives only `{token, session_title}` through Jinja `tojson` in `window.initial_quiz_data`.

- [ ] **Step 1: Write failing reducer/redaction tests**

```typescript
test("open state never invents or retains a previous answer key", () => {
  const next = reduceStudentState(closedStateWithAnswer(), {
    status: "open", active_question: { id: "q2", prompt: "下一題", options: [{ id: "a", text: "A" }] }
  });
  expect(next.active_question.correct_option_id).toBeUndefined();
  expect(next.selected_option_id).toBeNull();
});

test("submitted answer stays locked until a server full-state update", () => {
  const next = markSubmitted(openState(), "b");
  expect(next.status).toBe("answered");
  expect(next.selected_option_id).toBe("b");
});
```

- [ ] **Step 2: Run reducer tests and confirm RED**

Run: `npm test -- --runInBand gdbgui/src/js/tests/studentQuizState.jest.ts`

Expected: FAIL because reducer module does not exist.

- [ ] **Step 3: Implement reducer and minimal API adapter**

The reducer replaces state from server snapshots instead of merging secret-bearing prior fields. Fetch uses `credentials: "same-origin"`; non-2xx messages become specific Chinese UI guidance. Socket reconnect sets `reconnecting`, then GETs full guest state.

- [ ] **Step 4: Build the accessible student page**

```tsx
<main className="quiz-card">
  <p className="source-ticket">{sourceFile} · line {line}</p>
  <h1>{prompt}</h1>
  <fieldset disabled={status !== "open" || submitting}>
    <legend className="sr-only">請選擇一個答案</legend>
    {options.map(option => (
      <label key={option.id}>
        <input type="radio" name="answer" value={option.id} checked={selected === option.id}
               onChange={() => setSelected(option.id)} />
        {option.text}
      </label>
    ))}
  </fieldset>
  <button className="answer-submit" disabled={!selected || submitting}>送出答案</button>
  <p role="status" aria-live="polite">{statusText}</p>
</main>
```

Apply the UX token palette, 44px controls, focus-visible outlines, 320px layout, reduced-motion media query and text/icon correct/error indicators. `quiz_join.html` loads only the student bundle and does not expose lesson source, all questions or answers.

- [ ] **Step 5: Verify reducer, build and template privacy**

Run: `npm test -- --runInBand gdbgui/src/js/tests/studentQuizState.jest.ts`

Expected: PASS.

Run: `$env:NODE_OPTIONS='--openssl-legacy-provider'; npm run build`

Expected: webpack emits `studentQuiz.js` and exits 0.

Run: `python -m pytest tests/test_live_quiz_api.py -q`

Expected: join HTML test confirms prompt/source bundle/correct answer are absent.

- [ ] **Step 6: Commit Task 7**

```powershell
git add gdbgui/src/js/studentQuiz.tsx gdbgui/src/js/studentQuizState.ts gdbgui/src/js/tests/studentQuizState.jest.ts gdbgui/src/css/studentQuiz.css webpack.config.js gdbgui/templates/quiz_join.html
git commit -m "feat: add mobile lesson quiz page"
```

### Task 8: QR pixel E2E and deployment proof

**Files:**
- Create: `e2e/package.json`
- Modify: `e2e/package-lock.json`
- Create: `e2e/tests/zz_live_quiz.spec.ts`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.test.yml`
- Modify: `README.md`

**Interfaces:**
- E2E exports no production API. It decodes the actual QR SVG raster with `jsqr`, then opens the decoded URL in `devices['iPhone 13']`.
- Compose passes `MOBILE_JOIN_BASE_URL`; production documentation explains LAN IP, port publishing, Windows firewall, Wi-Fi client isolation, `10.0.2.2` for Android Emulator, and real-phone acceptance.
- Consumes all prior tasks.

- [ ] **Step 1: Restore E2E manifest and add test-only decoder**

```json
{
  "name": "e2e",
  "private": true,
  "version": "1.0.0",
  "devDependencies": {
    "@playwright/test": "1.44.0",
    "jsqr": "1.4.0"
  }
}
```

Run `npm install --package-lock-only` in `e2e/`; inspect that `jsqr` appears only in `e2e/package-lock.json`, not the production root package.

- [ ] **Step 2: Write QR-pixel mobile E2E first**

```typescript
import { test, expect, devices } from "@playwright/test";

test("student scans rendered QR and answers when playback reaches the bound line", async ({ browser }) => {
  const teacher = await browser.newContext(devices["Desktop Chrome"]);
  const teacherPage = await teacher.newPage();
  await loginAndOpenQuizLesson(teacherPage);
  await teacherPage.getByRole("button", { name: "開始課堂" }).click();
  const decodedUrl = await decodeQrPixels(teacherPage.locator("img[alt='學生加入 QR Code']"));
  expect(new URL(decodedUrl).pathname).toMatch(/^\/join\//);

  const phone = await browser.newContext(devices["iPhone 13"]);
  const studentPage = await phone.newPage();
  await studentPage.goto(decodedUrl);
  await studentPage.getByLabel("暱稱").fill("小明");
  await studentPage.getByRole("button", { name: "加入課堂" }).click();
  await runTeacherToBoundLine(teacherPage);
  await expect(studentPage.getByRole("heading", { name: "i 是多少？" })).toBeVisible();
  await studentPage.getByLabel("1").check();
  await studentPage.getByRole("button", { name: "送出答案" }).click();
  await expect(teacherPage.getByText("答對 1")).toBeVisible();
});
```

`decodeQrPixels` fetches the `<img>` SVG, draws it to canvas, calls browser-injected `jsQR(imageData.data, width, height)`, and returns `result.data`. It must not read a sibling link or reconstruct URL text.

- [ ] **Step 3: Run E2E and confirm RED**

Run: `docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test tests/zz_live_quiz.spec.ts --reporter=list`

Expected: FAIL at the first missing/incorrect integration point; fix only that point, re-run, and repeat until the complete scenario passes.

- [ ] **Step 4: Add network configuration and operational documentation**

Compose reads `MOBILE_JOIN_BASE_URL` from environment. README includes these exact checks:

```text
1. Start server bound/published on 0.0.0.0:5000.
2. Set MOBILE_JOIN_BASE_URL=http://<LAN-IP>:5000; never use localhost for real phones.
3. Allow inbound TCP 5000 in Windows Firewall.
4. Put teacher and phones on a Wi-Fi/VLAN without client isolation.
5. Android Emulator only: use http://10.0.2.2:5000 and import the QR PNG/JPEG at Extended controls > Camera > Virtual scene images.
6. Restore the LAN URL and scan once with a physical phone before class.
```

- [ ] **Step 5: Run complete verification**

Run: `npm test -- --runInBand`

Expected: all Jest suites PASS.

Run: `$env:NODE_OPTIONS='--openssl-legacy-provider'; npm run build`

Expected: webpack exits 0.

Run: `python -m pytest tests/test_live_quiz_db.py tests/test_live_quiz_api.py tests/test_live_quiz_socket.py tests/test_live_quiz_concurrency.py tests/test_lesson_sharing.py tests/test_route_gate.py -q`

Expected: all focused Python tests PASS.

Run: `python -m pytest tests/ -q`

Expected: all tests that do not require forbidden Docker/user-namespace privileges PASS; any environment-only failures must be individually identified and must not include live quiz, auth, route-gate or lesson tests.

Run: `docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test tests/zz_live_quiz.spec.ts --reporter=list`

Expected: QR-pixel/iPhone test PASS.

- [ ] **Step 6: Perform manual QR acceptance when hardware is available**

Use Android Emulator virtual camera with the generated QR, then use one physical phone on the configured LAN. Record the tested base URL form, device/emulator type and result in the final handoff; never include the signed join token itself.

- [ ] **Step 7: Commit Task 8**

```powershell
git add e2e/package.json e2e/package-lock.json e2e/tests/zz_live_quiz.spec.ts docker-compose.yml docker-compose.test.yml README.md
git commit -m "test: verify QR lesson quiz end to end"
```

## Final review gate

- [ ] Re-read the design spec and map every scope item, invariant, API, failure behavior and acceptance criterion to passing evidence from Tasks 1–8.
- [ ] Search production student payloads for `correct_option_id` and `explanation`; verify they appear only in closed/personal state code paths.
- [ ] Search `PUBLIC_ENDPOINTS` and `CSRF_EXEMPT_ENDPOINTS`; confirm there is no prefix/blueprint exemption.
- [ ] Confirm `git status --short` is clean and all commits belong to this feature branch.
- [ ] Invoke `superpowers:requesting-code-review`, resolve correctness and scope findings, rerun affected tests.
- [ ] Invoke `superpowers:verification-before-completion`, rerun the full verification commands, then invoke `superpowers:finishing-a-development-branch` for integration options.
