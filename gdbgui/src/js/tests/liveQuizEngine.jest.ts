import { createEngine, LiveQuizEngine } from "../liveQuizEngine";

const OPTIONS = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
  { id: "c", text: "C" }
];

function choiceQuestion(id: string, position: number, line: number) {
  return {
    id,
    kind: "choice",
    prompt: `題目 ${id}`,
    test_input: null,
    explanation: `解析 ${id}`,
    source_file: "main.cpp",
    line,
    anchor: { source_file: "main.cpp", line },
    position,
    state: "ready",
    opened_at: null,
    closed_at: null,
    answer_count: 0,
    correct_count: 0,
    options: OPTIONS,
    correct_option_id: "b",
    option_counts: { a: 0, b: 0, c: 0 }
  };
}

function makeSession() {
  return {
    id: 7,
    lesson_id: 3,
    lesson_version_id: 5,
    lesson_version: 2,
    owner_id: 1,
    title: "第一堂",
    state: "lobby",
    created_at: "2026-10-30T00:00:00Z",
    ended_at: null,
    joined_count: 0,
    active_question: null,
    questions: [choiceQuestion("q1", 0, 10), choiceQuestion("q2", 1, 20)]
  };
}

let tick = 0;
function newEngine(): LiveQuizEngine {
  tick = 0;
  return createEngine(makeSession(), () => `t${++tick}`);
}

function thrownStatus(fn: () => any): number | undefined {
  try {
    fn();
  } catch (e) {
    return e.status;
  }
  return undefined;
}

describe("liveQuizEngine", () => {
  it("trigger 只能開 ready 題，同時只能開一題", () => {
    const engine = newEngine();
    engine.trigger("q1", "main.cpp", 10);
    expect(thrownStatus(() => engine.trigger("q2", "main.cpp", 20))).toBe(409);
    engine.close("q1");
    const session = engine.trigger("q2", "main.cpp", 20);
    expect(session.active_question.id).toBe("q2");
  });

  it("trigger 的 source_file 與 line 必須符合錨點", () => {
    const engine = newEngine();
    expect(thrownStatus(() => engine.trigger("q1", "main.cpp", 11))).toBe(400);
    expect(thrownStatus(() => engine.trigger("q1", "other.cpp", 10))).toBe(400);
    // Windows 路徑只比檔名且不分大小寫；POSIX 路徑分大小寫
    expect(thrownStatus(() => engine.trigger("q1", "C:\\work\\MAIN.cpp", 10))).toBeUndefined();
    const engine2 = newEngine();
    expect(thrownStatus(() => engine2.trigger("q1", "/tmp/MAIN.cpp", 10))).toBe(400);
    expect(thrownStatus(() => engine2.trigger("q1", "/tmp/main.cpp", 10))).toBeUndefined();
  });

  it("60 位學生各答一次，計數正確", () => {
    const engine = newEngine();
    engine.trigger("q1", "main.cpp", 10);
    const ids = ["a", "b", "c"];
    for (let i = 0; i < 60; i++) {
      engine.hello(`d${i}`, `學生${i}`);
      engine.answerChoice(`d${i}`, "q1", ids[i % 3]);
    }
    const stats = engine.stats()!;
    expect(stats.answer_count).toBe(60);
    expect(stats.joined_count).toBe(60);
    expect(stats.correct_count).toBe(20);
    const counts = stats.option_counts!;
    expect(counts.a + counts.b + counts.c).toBe(60);
  });

  it("同一裝置重送同一答案只算一次", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    engine.answerChoice("d1", "q1", "b");
    const stats = engine.stats()!;
    expect(stats.answer_count).toBe(1);
    expect(stats.correct_count).toBe(1);
    expect(stats.option_counts).toEqual({ a: 0, b: 1, c: 0 });
  });

  it("收卷前改答案：舊選項減一、新選項加一，answer_count 不變", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    const state = engine.answerChoice("d1", "q1", "a");
    expect(state.active_question.selected_option_id).toBe("a");
    const stats = engine.stats()!;
    expect(stats.answer_count).toBe(1);
    expect(stats.correct_count).toBe(0);
    expect(stats.option_counts).toEqual({ a: 1, b: 0, c: 0 });
  });

  it("收卷後作答被拒絕，狀態不變", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    engine.close("q1");
    const before = JSON.stringify(engine.teacherSession());
    expect(thrownStatus(() => engine.answerChoice("d2", "q1", "b"))).toBe(409);
    // 已作答的人收卷後再送：不改答案，回傳舊答案
    const state = engine.answerChoice("d1", "q1", "a");
    expect(state.active_question.selected_option_id).toBe("b");
    expect(JSON.stringify(engine.teacherSession())).toBe(before);
  });

  it("不存在的選項被拒絕", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    expect(thrownStatus(() => engine.answerChoice("d1", "q1", "zzz"))).toBe(400);
    expect(engine.stats()!.answer_count).toBe(0);
  });

  it("暱稱空白、超過 50 字或含控制字元會被拒絕", () => {
    const engine = newEngine();
    expect(thrownStatus(() => engine.hello("d1", "   "))).toBe(400);
    expect(thrownStatus(() => engine.hello("d1", ""))).toBe(400);
    expect(thrownStatus(() => engine.hello("d1", "x".repeat(51)))).toBe(400);
    expect(thrownStatus(() => engine.hello("d1", "ab\u0007c"))).toBe(400);
    expect(thrownStatus(() => engine.hello("d1", "ab\u007fc"))).toBe(400);
    expect(thrownStatus(() => engine.hello("d1", "x".repeat(50)))).toBeUndefined();
    expect(engine.teacherSession().joined_count).toBe(1);
  });

  it("同一裝置再次 hello 不增加 joined_count", () => {
    const engine = newEngine();
    expect(engine.hello("d1", "小明")).toEqual({ isNew: true });
    expect(engine.hello("d1", "改名字")).toEqual({ isNew: false });
    expect(engine.teacherSession().joined_count).toBe(1);
    expect(engine.studentState("d1")!.nickname).toBe("小明");
  });

  it("收卷前，學生狀態不含 correct_option_id 與 explanation", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "a");
    const text = JSON.stringify(engine.studentState("d1"));
    expect(text).not.toContain("correct_option_id");
    expect(text).not.toContain("explanation");
    expect(text).not.toContain("解析");
  });

  it("收卷後，學生狀態含 result.is_correct、correct_option_id、explanation", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    engine.close("q1");
    const q = engine.studentState("d1")!.active_question;
    expect(q.state).toBe("closed");
    expect(q.selected_option_id).toBe("b");
    expect(q.result).toEqual({ is_correct: true, correct_option_id: "b", explanation: "解析 q1" });
    expect(Object.keys(q).sort()).toEqual(
      ["id", "kind", "line", "options", "prompt", "result", "selected_option_id", "source_file", "state", "test_input"].sort()
    );
    // 沒作答：is_correct 為 null
    expect(engine.studentState("d2")!.active_question.result.is_correct).toBeNull();
    expect(engine.studentState("nobody")).toBeNull();
  });

  it("學生狀態：open 題優先，否則取最近開的 closed 題", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    expect(engine.studentState("d1")!.active_question).toBeNull();
    engine.trigger("q1", "main.cpp", 10);
    engine.close("q1");
    engine.trigger("q2", "main.cpp", 20);
    expect(engine.studentState("d1")!.active_question.id).toBe("q2");
    engine.close("q2");
    expect(engine.studentState("d1")!.active_question.id).toBe("q2");
  });

  it("用戶端給的 key 是 __proto__ / constructor 時被拒絕且狀態不變", () => {
    const engine = newEngine();
    engine.hello("__proto__", "小明");
    engine.hello("d1", "小華");
    engine.trigger("q1", "main.cpp", 10);
    const before = JSON.stringify(engine.teacherSession());
    for (const key of ["__proto__", "constructor"]) {
      expect(thrownStatus(() => engine.answerChoice("d1", key, "a"))).toBe(404);
      expect(thrownStatus(() => engine.answerChoice("d1", "q1", key))).toBe(400);
      expect(thrownStatus(() => engine.trigger(key, "main.cpp", 10))).toBe(404);
      expect(thrownStatus(() => engine.close(key))).toBe(404);
    }
    expect(thrownStatus(() => engine.answerChoice("constructor", "q1", "a"))).toBe(409);
    expect(JSON.stringify(engine.teacherSession())).toBe(before);
    expect(({} as any).a).toBeUndefined();
    expect(engine.studentState("constructor")).toBeNull();
    expect(engine.studentState("__proto__")!.nickname).toBe("小明");
  });

  it("teacherSession 的欄位與 _session_payload 相同", () => {
    const engine = newEngine();
    const session = engine.teacherSession();
    expect(Object.keys(session).sort()).toEqual(
      [
        "id", "lesson_id", "lesson_version_id", "lesson_version", "owner_id", "title",
        "state", "created_at", "ended_at", "joined_count", "active_question", "questions"
      ].sort()
    );
    expect(Object.keys(session.questions[0]).sort()).toEqual(
      [
        "id", "kind", "prompt", "test_input", "explanation", "source_file", "line", "anchor",
        "position", "state", "opened_at", "closed_at", "answer_count", "correct_count",
        "options", "correct_option_id", "option_counts"
      ].sort()
    );
  });

  it("endedSummary 列出每題的計數與時間", () => {
    const engine = newEngine();
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    engine.close("q1");
    const summary = engine.endedSummary();
    expect(summary.questions[0]).toEqual({
      question_key: "q1",
      opened_at: "t1",
      closed_at: "t2",
      answer_count: 1,
      correct_count: 1,
      option_counts: { a: 0, b: 1, c: 0 }
    });
    expect(summary.questions[1].opened_at).toBeNull();
  });
});
