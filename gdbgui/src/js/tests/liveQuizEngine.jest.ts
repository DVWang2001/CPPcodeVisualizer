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
    // 只接受引擎自己丟的 EngineError；其他例外（如 SyntaxError）代表 bug，直接讓測試失敗
    if (!e || typeof e.status !== "number" || typeof e.message !== "string" || e instanceof Error) {
      throw e;
    }
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
    expect(engine.studentState("constructor")).toBeNull();
    expect(engine.studentState("__proto__")!.nickname).toBe("小明");
  });

  it("含填表題的課：選擇題照常運作，填表題 trigger 得到乾淨的 400", () => {
    const session = makeSession();
    const table: any = {
      id: "t1", kind: "table", prompt: "填表", test_input: null, explanation: "",
      source_file: "main.cpp", line: 30, anchor: { source_file: "main.cpp", line: 30 },
      position: 2, state: "ready", opened_at: null, closed_at: null,
      answer_count: 0, correct_count: 0, table_spec: { var_hint: "dp", max_cells: 16 }
    };
    session.questions.push(table);
    const engine = createEngine(session, () => "now");
    expect(engine.teacherSession().questions.length).toBe(3);
    expect(thrownStatus(() => engine.trigger("t1", "main.cpp", 30))).toBe(400);
    // 失敗的 trigger 不能留下 open 狀態
    expect(engine.teacherSession().active_question).toBeNull();
    const opened = engine.trigger("q1", "main.cpp", 10);
    expect(opened.active_question.id).toBe("q1");
    expect(engine.close("q1").questions[0].state).toBe("closed");
    expect(engine.endedSummary().questions.length).toBe(3);
  });

  it("選項 ID 是 __proto__ 時仍正確計數", () => {
    const session = makeSession();
    (session.questions[0] as any).options = [
      { id: "__proto__", text: "P" },
      { id: "b", text: "B" }
    ];
    const engine = createEngine(session, () => "now");
    engine.hello("d1", "小明");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "__proto__");
    const counts = engine.stats()!.option_counts!;
    expect(Object.keys(counts).sort()).toEqual(["__proto__", "b"]);
    expect(Object.getOwnPropertyDescriptor(counts, "__proto__")!.value).toBe(1);
    engine.answerChoice("d1", "q1", "b");
    const after = engine.stats()!.option_counts!;
    expect(Object.getOwnPropertyDescriptor(after, "__proto__")!.value).toBe(0);
    expect(after.b).toBe(1);
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
    // hello 與 answerChoice 也各讀一次時鐘（joined_at、answered_at 要進匯出）
    expect(summary.questions[0]).toEqual({
      question_key: "q1",
      opened_at: "t2",
      closed_at: "t4",
      answer_count: 1,
      correct_count: 1,
      option_counts: { a: 0, b: 1, c: 0 }
    });
    expect(summary.questions[1].opened_at).toBeNull();
  });

  it("暱稱長度以字元（code point）計，不是 UTF-16 單位", () => {
    const engine = newEngine();
    expect(thrownStatus(() => engine.hello("d1", "😀".repeat(50)))).toBeUndefined();
    expect(thrownStatus(() => engine.hello("d2", "😀".repeat(51)))).toBe(400);
  });
});

const TABLE = {
  rows: 2,
  cols: 2,
  row_labels: ["r0", "r1"],
  col_labels: ["c0", "c1"],
  values: [
    ["1", "2"],
    [" 3 ", "4"]
  ]
};

function tableSession(maxCells = 16) {
  const session = makeSession();
  session.questions.push({
    id: "t1", kind: "table", prompt: "填表", test_input: null, explanation: "表格解析",
    source_file: "main.cpp", line: 30, anchor: { source_file: "main.cpp", line: 30 },
    position: 2, state: "ready", opened_at: null, closed_at: null,
    answer_count: 0, correct_count: 0, table_spec: { var_hint: "dp", max_cells: maxCells }
  } as any);
  return session;
}

function tableEngine(maxCells = 16): LiveQuizEngine {
  tick = 0;
  return createEngine(tableSession(maxCells), () => `t${++tick}`);
}

function openTable(engine: LiveQuizEngine, table: any = TABLE, hint = "dp") {
  return engine.trigger("t1", "main.cpp", 30, { table, var_hint: hint });
}

describe("liveQuizEngine 填表題", () => {
  it("trigger 填表題要帶 capture，維度與格數受 max_cells 限制", () => {
    const engine = tableEngine(4);
    const bad: any[] = [
      undefined,
      { table: null, var_hint: "dp" },
      { table: [], var_hint: "dp" },
      { table: { ...TABLE, extra: 1 }, var_hint: "dp" },
      { table: { ...TABLE, rows: 0, values: [] , row_labels: []}, var_hint: "dp" },
      { table: { ...TABLE, rows: true }, var_hint: "dp" },
      { table: { ...TABLE, rows: 1.5 }, var_hint: "dp" },
      { table: { rows: 3, cols: 2, row_labels: ["a", "b", "c"], col_labels: ["x", "y"], values: [["1", "2"], ["3", "4"], ["5", "6"]] }, var_hint: "dp" },
      { table: { ...TABLE, values: [["1", "2"]] }, var_hint: "dp" },
      { table: { ...TABLE, values: [["1", "2"], ["3"]] }, var_hint: "dp" },
      { table: { ...TABLE, values: [["1", "2"], ["3", 4]] }, var_hint: "dp" },
      { table: { ...TABLE, values: [["1", "x".repeat(33)], ["3", "4"]] }, var_hint: "dp" },
      { table: { ...TABLE, row_labels: ["r0"] }, var_hint: "dp" },
      { table: { ...TABLE, col_labels: ["c0", 1] }, var_hint: "dp" },
      { table: { ...TABLE, col_labels: ["c0", "x".repeat(33)] }, var_hint: "dp" },
      { table: TABLE, var_hint: "h".repeat(129) }
    ];
    for (const capture of bad) {
      expect(thrownStatus(() => engine.trigger("t1", "main.cpp", 30, capture))).toBe(400);
    }
    // 失敗的 trigger 不能留下 open 狀態或半套 capture
    expect(engine.teacherSession().active_question).toBeNull();
    expect(engine.teacherSession().questions[2].rows).toBeUndefined();
    const session = openTable(engine);
    expect(session.active_question.id).toBe("t1");
    expect(session.active_question.rows).toBe(2);
    expect(session.active_question.cell_stats).toEqual([0, 0, 0, 0]);
  });

  it("填表題 trigger 後 var_hint 以老師送來的為準", () => {
    const engine = tableEngine();
    expect(openTable(engine, TABLE, "dp[i][j]").active_question.table_spec).toEqual({
      var_hint: "dp[i][j]",
      max_cells: 16
    });
  });

  it("填表題 trigger 受上一題未收卷限制", () => {
    const engine = tableEngine();
    engine.trigger("q1", "main.cpp", 10);
    expect(thrownStatus(() => openTable(engine))).toBe(409);
  });

  it("逐格 trim 後比對，空字串算錯", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    openTable(engine);
    engine.answerTable("d1", "t1", [
      [" 1 ", "2"],
      ["3", ""]
    ]);
    engine.close("t1");
    const result = engine.studentState("d1")!.active_question.result;
    expect(result.correct_cells).toBe(3);
    expect(result.total_cells).toBe(4);
    // 正解與答案都是空字串也不算對
    const engine2 = tableEngine();
    engine2.hello("d1", "小明");
    engine2.trigger("t1", "main.cpp", 30, {
      table: { ...TABLE, values: [["", "2"], ["3", "4"]] },
      var_hint: "dp"
    });
    engine2.answerTable("d1", "t1", [["", "2"], ["3", "4"]]);
    engine2.close("t1");
    expect(engine2.studentState("d1")!.active_question.result.correct_cells).toBe(3);
  });

  it("每格超過 32 字會被截斷", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    const long = "y".repeat(32);
    engine.trigger("t1", "main.cpp", 30, {
      table: { ...TABLE, values: [[long, "2"], ["3", "4"]] },
      var_hint: "dp"
    });
    const state = engine.answerTable("d1", "t1", [
      [long + "zzzzzzzz", "2"],
      ["3", "4"]
    ]);
    expect(state.active_question.answer[0][0]).toBe(long);
    engine.close("t1");
    expect(engine.studentState("d1")!.active_question.result.correct_cells).toBe(4);
    // 以 code point 截斷，不拆開 surrogate pair
    const engine2 = tableEngine();
    engine2.hello("d1", "小明");
    openTable(engine2);
    const emoji = engine2.answerTable("d1", "t1", [["😀".repeat(40), "2"], ["3", "4"]]);
    expect(emoji.active_question.answer[0][0]).toBe("😀".repeat(32));
  });

  it("答錯的格子在 cell_stats 加一；收卷前重送時先扣掉舊答案的錯格再累加", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    openTable(engine);
    engine.answerTable("d1", "t1", [["x", "2"], ["3", "x"]]);
    expect(engine.stats()!.cell_stats).toEqual([1, 0, 0, 1]);
    engine.answerTable("d2", "t1", [["x", "2"], ["3", "4"]]);
    expect(engine.stats()!.cell_stats).toEqual([2, 0, 0, 1]);
    // d1 改答案：只剩第二列第一格錯
    engine.answerTable("d1", "t1", [["1", "2"], ["x", "4"]]);
    const stats = engine.stats()!;
    expect(stats.cell_stats).toEqual([1, 0, 1, 0]);
    expect(stats.answer_count).toBe(2);
    expect(stats.correct_count).toBe(0);
    expect(stats.option_counts).toBeUndefined();
    // 改成全對：correct_count 加一；再改回有錯：減一
    engine.answerTable("d2", "t1", [["1", "2"], ["3", "4"]]);
    expect(engine.stats()!.correct_count).toBe(1);
    engine.answerTable("d2", "t1", [["x", "2"], ["3", "4"]]);
    expect(engine.stats()!.correct_count).toBe(0);
  });

  it("填表題作答格式錯誤被拒絕且狀態不變", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    expect(thrownStatus(() => engine.answerTable("d1", "t1", [["1", "2"], ["3", "4"]]))).toBe(409);
    openTable(engine);
    const before = JSON.stringify(engine.teacherSession());
    expect(thrownStatus(() => engine.answerTable("d1", "t1", [["1", "2"]]))).toBe(400);
    expect(thrownStatus(() => engine.answerTable("d1", "t1", [["1", "2"], ["3"]]))).toBe(400);
    expect(thrownStatus(() => engine.answerTable("d1", "t1", [["1", "2"], ["3", 4 as any]]))).toBe(400);
    expect(thrownStatus(() => engine.answerTable("d1", "t1", "x" as any))).toBe(400);
    expect(thrownStatus(() => engine.answerTable("d1", "q1", [["1", "2"], ["3", "4"]]))).toBe(400);
    expect(thrownStatus(() => engine.answerTable("nobody", "t1", [["1", "2"], ["3", "4"]]))).toBe(409);
    expect(thrownStatus(() => engine.answerTable("d1", "__proto__", [["1", "2"], ["3", "4"]]))).toBe(404);
    expect(JSON.stringify(engine.teacherSession())).toBe(before);
    // 選擇題 API 不能答填表題
    expect(thrownStatus(() => engine.answerChoice("d1", "t1", "a"))).toBe(400);
  });

  it("收卷後作答被拒絕；已作答者拿到舊答案", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    openTable(engine);
    engine.answerTable("d1", "t1", [["1", "2"], ["3", "4"]]);
    engine.close("t1");
    const before = JSON.stringify(engine.teacherSession());
    expect(thrownStatus(() => engine.answerTable("d2", "t1", [["1", "2"], ["3", "4"]]))).toBe(409);
    const state = engine.answerTable("d1", "t1", [["x", "x"], ["x", "x"]]);
    expect(state.active_question.answer).toEqual([["1", "2"], ["3", "4"]]);
    expect(JSON.stringify(engine.teacherSession())).toBe(before);
  });

  it("收卷前學生狀態不含 correct_values，也不含別人的答案", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    openTable(engine);
    engine.answerTable("d1", "t1", [["SECRET1", "2"], ["3", "4"]]);
    engine.answerTable("d2", "t1", [["mine", "2"], ["3", "4"]]);
    const own = engine.studentState("d2")!;
    const text = JSON.stringify(own);
    expect(text).not.toContain("correct_values");
    expect(text).not.toContain("SECRET1");
    expect(text).not.toContain("表格解析");
    expect(text).not.toContain("result");
    expect(own.active_question.answer[0][0]).toBe("mine");
    expect(Object.keys(own.active_question).sort()).toEqual(
      [
        "answer", "col_labels", "cols", "id", "kind", "line", "prompt", "row_labels",
        "rows", "source_file", "state", "test_input"
      ].sort()
    );
  });

  it("收卷後學生狀態含 correct_values 與 result.correct_cells、total_cells、explanation", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    openTable(engine);
    engine.answerTable("d1", "t1", [["1", "x"], ["3", "4"]]);
    engine.close("t1");
    const q = engine.studentState("d1")!.active_question;
    expect(q.state).toBe("closed");
    expect(q.result).toEqual({ correct_cells: 3, total_cells: 4, explanation: "表格解析" });
    expect(q.correct_values).toEqual(TABLE.values);
    expect(Object.keys(q).sort()).toEqual(
      [
        "answer", "col_labels", "cols", "correct_values", "id", "kind", "line", "prompt",
        "result", "row_labels", "rows", "source_file", "state", "test_input"
      ].sort()
    );
    // 沒作答：answer 與計分都是 null
    const none = engine.studentState("d2")!.active_question;
    expect(none.answer).toBeNull();
    expect(none.result).toEqual({ correct_cells: null, total_cells: null, explanation: "表格解析" });
  });

  it("老師端填表題 payload 含完整欄位", () => {
    const engine = tableEngine();
    const ready = engine.teacherSession().questions[2];
    expect(Object.keys(ready).sort()).toEqual(
      [
        "id", "kind", "prompt", "test_input", "explanation", "source_file", "line", "anchor",
        "position", "state", "opened_at", "closed_at", "answer_count", "correct_count", "table_spec"
      ].sort()
    );
    const open = openTable(engine).questions[2];
    expect(Object.keys(open).sort()).toEqual(
      [
        "id", "kind", "prompt", "test_input", "explanation", "source_file", "line", "anchor",
        "position", "state", "opened_at", "closed_at", "answer_count", "correct_count", "table_spec",
        "rows", "cols", "row_labels", "col_labels", "cell_stats", "correct_values"
      ].sort()
    );
    expect(open.correct_values).toEqual(TABLE.values);
  });

  it("responses 只在收卷後提供，依 correct_cells、nickname 排序", () => {
    const engine = tableEngine();
    engine.hello("d1", "乙");
    engine.hello("d2", "甲");
    engine.hello("d3", "丙");
    openTable(engine);
    engine.answerTable("d1", "t1", [["1", "2"], ["3", "4"]]);
    engine.answerTable("d2", "t1", [["1", "2"], ["3", "4"]]);
    engine.answerTable("d3", "t1", [["x", "x"], ["3", "4"]]);
    expect(thrownStatus(() => engine.responses("t1"))).toBe(409);
    engine.close("t1");
    const list = engine.responses("t1").responses;
    // 丙 答對最少排最前；其餘同分，依 nickname 排（乙 U+4E59 < 甲 U+7532）
    expect(list.map(r => r.nickname)).toEqual(["丙", "乙", "甲"]);
    expect(list[0]).toEqual({
      nickname: "丙",
      answer: [["x", "x"], ["3", "4"]],
      correct_cells: 2,
      total_cells: 4
    });
    expect(thrownStatus(() => engine.responses("q1"))).toBe(409);
    expect(thrownStatus(() => engine.responses("nope"))).toBe(404);
    expect(thrownStatus(() => engine.responses("__proto__"))).toBe(404);
  });

  it("stats 在收卷後仍回傳最近開過的題（填表題帶 cell_stats）", () => {
    const engine = tableEngine();
    expect(engine.stats()).toBeNull();
    engine.hello("d1", "小明");
    openTable(engine);
    engine.answerTable("d1", "t1", [["x", "2"], ["3", "4"]]);
    engine.close("t1");
    expect(engine.stats()).toEqual({
      joined_count: 1,
      question_id: "t1",
      state: "closed",
      answer_count: 1,
      correct_count: 0,
      cell_stats: [1, 0, 0, 0]
    });
    // 之後開的選擇題成為最近的一題；收卷後 stats 仍在
    engine.trigger("q1", "main.cpp", 10);
    expect(engine.stats()!.question_id).toBe("q1");
    engine.close("q1");
    const closed = engine.stats()!;
    expect(closed.question_id).toBe("q1");
    expect(closed.state).toBe("closed");
    expect(closed.option_counts).toEqual({ a: 0, b: 0, c: 0 });
  });

  it("exportSession 的頂層欄位與 export_session 相同", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    engine.hello("d2", "小華");
    engine.trigger("q1", "main.cpp", 10);
    engine.answerChoice("d1", "q1", "b");
    engine.close("q1");
    openTable(engine);
    engine.answerTable("d2", "t1", [["1", "x"], ["3", "4"]]);
    engine.close("t1");
    const data: any = engine.exportSession();
    expect(Object.keys(data).sort()).toEqual(
      ["exported_at", "session", "participants", "questions", "responses"].sort()
    );
    expect(Object.keys(data.session).sort()).toEqual(
      ["id", "title", "state", "created_at", "ended_at"].sort()
    );
    expect(Object.keys(data.participants[0]).sort()).toEqual(
      ["nickname", "joined_at", "last_seen_at"].sort()
    );
    const questionKeys = [
      "question_key", "kind", "prompt", "position", "state", "opened_at", "closed_at",
      "answer_count", "correct_count", "correct_option_id", "option_counts", "table_spec",
      "correct_table", "cell_stats"
    ].sort();
    expect(data.questions.length).toBe(3);
    for (const q of data.questions) expect(Object.keys(q).sort()).toEqual(questionKeys);
    const [choice, , table] = data.questions;
    expect(choice.correct_option_id).toBe("b");
    expect(choice.option_counts).toEqual({ a: 0, b: 1, c: 0 });
    expect(choice.table_spec).toBeNull();
    expect(choice.cell_stats).toBeNull();
    expect(table.correct_option_id).toBeNull();
    expect(table.option_counts).toBeNull();
    expect(table.table_spec).toEqual({ var_hint: "dp", max_cells: 16 });
    expect(table.correct_table).toEqual(TABLE);
    expect(table.cell_stats).toEqual([0, 1, 0, 0]);
    // 沒開過的題：capture 與 cell_stats 為 null
    expect(data.questions[1].correct_table).toBeNull();
    const responseKeys = [
      "question_key", "kind", "nickname", "answered_at", "selected_option_id", "is_correct",
      "answer", "correct_cells", "total_cells"
    ].sort();
    expect(data.responses.length).toBe(2);
    for (const r of data.responses) expect(Object.keys(r).sort()).toEqual(responseKeys);
    expect(data.responses[0]).toMatchObject({
      question_key: "q1", nickname: "小明", selected_option_id: "b", is_correct: 1, answer: null
    });
    expect(data.responses[1]).toMatchObject({
      question_key: "t1", nickname: "小華", selected_option_id: null,
      answer: [["1", "x"], ["3", "4"]], correct_cells: 3, total_cells: 4
    });
  });

  it("endedSummary 帶出每題的聚合與填表題的 var_hint", () => {
    const engine = tableEngine();
    engine.hello("d1", "小明");
    openTable(engine, TABLE, "dp[i][j]");
    engine.answerTable("d1", "t1", [["x", "2"], ["3", "4"]]);
    engine.close("t1");
    const summary = engine.endedSummary();
    expect(summary.questions[2]).toEqual({
      question_key: "t1",
      opened_at: "t2",
      closed_at: "t4",
      answer_count: 1,
      correct_count: 0,
      cell_stats: [1, 0, 0, 0],
      var_hint: "dp[i][j]",
      rows: 2,
      cols: 2
    });
    // 選擇題不帶填表欄位；沒開過的填表題沒有 rows/cols/cell_stats
    expect(summary.questions[0].var_hint).toBeUndefined();
    expect(summary.questions[0].rows).toBeUndefined();
    const fresh = tableEngine().endedSummary().questions[2];
    expect(fresh.var_hint).toBe("dp");
    expect(fresh.rows).toBeUndefined();
    expect(fresh.cell_stats).toBeUndefined();
  });
});
