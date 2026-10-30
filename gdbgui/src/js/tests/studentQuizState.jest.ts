import {
  initialStudentState,
  markReconnecting,
  markSubmitted,
  reduceStudentState
} from "../studentQuizState";

const openSnapshot = () => ({
  participant_id: 1,
  session_id: 7,
  session_title: "迴圈課堂",
  nickname: "小明",
  state: "active",
  active_question: {
    id: "q2",
    prompt: "下一題",
    options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    source_file: "main.cpp",
    line: 4,
    state: "open",
    selected_option_id: null
  }
});

const closedSnapshot = () => ({
  ...openSnapshot(),
  active_question: {
    ...openSnapshot().active_question,
    id: "q1",
    state: "closed",
    selected_option_id: "b",
    result: {
      is_correct: true,
      correct_option_id: "b",
      explanation: "i++ 會遞增。"
    }
  }
});

const tableSnapshot = (state: "open" | "closed" = "open") => ({
  participant_id: 1,
  session_id: 7,
  session_title: "DP 課堂",
  nickname: "小明",
  state: "active",
  active_question: {
    id: "table-1",
    kind: "table",
    prompt: "填完 dp",
    rows: 2,
    cols: 2,
    row_labels: ["i=0", "i=1"],
    col_labels: ["j=0", "j=1"],
    source_file: "main.cpp",
    line: 8,
    state,
    answer: null
  }
});

test("open state never invents or retains a previous answer key", () => {
  const closed = reduceStudentState(initialStudentState("迴圈課堂"), closedSnapshot());
  const openWithUnexpectedSecrets = {
    ...openSnapshot(),
    active_question: {
      ...openSnapshot().active_question,
      correct_option_id: "b",
      result: closedSnapshot().active_question.result
    }
  };
  const next = reduceStudentState(closed, openWithUnexpectedSecrets);

  expect((next.active_question as any).correct_option_id).toBeUndefined();
  expect((next.active_question as any).result).toBeUndefined();
  expect(next.selected_option_id).toBeNull();
  expect(next.status).toBe("open");
});

test("submitted answer stays locked until a server full-state update", () => {
  const open = reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot());
  const next = markSubmitted(open, "b");

  expect(next.status).toBe("answered");
  expect(next.selected_option_id).toBe("b");
  expect(open.selected_option_id).toBeNull();
});

test("waiting, closed and ended are derived from complete server snapshots", () => {
  const initial = initialStudentState("迴圈課堂");
  const waiting = reduceStudentState(initial, { ...openSnapshot(), active_question: null });
  const closed = reduceStudentState(waiting, closedSnapshot());
  const ended = reduceStudentState(closed, { state: "ended" });
  const closedQuestion = closed.active_question;

  expect(waiting.status).toBe("waiting");
  expect(closed.status).toBe("closed");
  if (!closedQuestion || closedQuestion.kind !== "choice") throw new Error("expected choice question");
  expect(closedQuestion.result!.correct_option_id).toBe("b");
  expect(ended).toMatchObject({ status: "ended", active_question: null });
});

test("socket loss keeps an HTTP-loaded open question answerable", () => {
  const open = reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot());
  const reconnecting = markReconnecting(open);

  expect(reconnecting.status).toBe("open");
  expect(reconnecting.active_question!.id).toBe("q2");
  expect(reconnecting.selected_option_id).toBeNull();
  expect(reconnecting.reconnecting).toBe(true);
});

test("open table snapshot is normalized without leaked answers", () => {
  const snapshot = tableSnapshot();
  snapshot.active_question = {
    ...snapshot.active_question,
    correct_values: [["0", "1"], ["1", "2"]],
    result: { correct_cells: 0, total_cells: 4, explanation: "偷渡" }
  } as any;

  const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);
  const question = next.active_question as any;

  expect(next.status).toBe("open");
  expect(question).toMatchObject({
    kind: "table",
    rows: 2,
    cols: 2,
    row_labels: ["i=0", "i=1"],
    col_labels: ["j=0", "j=1"],
    answer: null
  });
  expect(question.correct_values).toBeUndefined();
  expect(question.result).toBeUndefined();
});

test("server table answer keeps an open full snapshot answered", () => {
  const snapshot = tableSnapshot();
  snapshot.active_question.answer = [["0", "1"], ["1", "2"]] as any;

  const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

  expect(next.status).toBe("answered");
  expect((next.active_question as any).answer).toEqual([["0", "1"], ["1", "2"]]);
});

test("closed table snapshot exposes only its own answer and per-cell comparison data", () => {
  const snapshot = tableSnapshot("closed");
  snapshot.active_question = {
    ...snapshot.active_question,
    answer: [["0", "9"], ["1", "2"]],
    correct_values: [["0", "1"], ["1", "2"]],
    result: { correct_cells: 0, total_cells: 4, explanation: "看轉移式。" }
  } as any;

  const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

  expect(next.status).toBe("closed");
  expect(next.active_question).toMatchObject({
    kind: "table",
    answer: [["0", "9"], ["1", "2"]],
    correct_values: [["0", "1"], ["1", "2"]],
    result: { correct_cells: 0, total_cells: 4, explanation: "看轉移式。" }
  });
});

test("marking a table submitted does not invent a choice selection", () => {
  const open = reduceStudentState(initialStudentState("DP 課堂"), tableSnapshot());
  const next = markSubmitted(open);

  expect(next.status).toBe("answered");
  expect(next.selected_option_id).toBeNull();
  expect((next.active_question as any).kind).toBe("table");
});

test("malformed table dimensions fall back without allocating an unsafe grid", () => {
  const dimensions = [
    [0, 2],
    [1.5, 2],
    [20, 20],
    [Number.MAX_SAFE_INTEGER, 2]
  ];

  for (const [rows, cols] of dimensions) {
    const snapshot = tableSnapshot();
    snapshot.active_question.rows = rows;
    snapshot.active_question.cols = cols;
    const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

    expect(next.status).toBe("open");
    expect(next.active_question).toMatchObject({
      kind: "table",
      rows: 0,
      cols: 0,
      row_labels: [],
      col_labels: [],
      answer: null
    });
  }
});

test("malformed table labels and oversized cells use safe fallbacks", () => {
  const snapshot = tableSnapshot();
  snapshot.active_question = {
    ...snapshot.active_question,
    rows: 1,
    cols: 2,
    row_labels: [7],
    col_labels: ["x".repeat(33), "j=1"],
    answer: [["x".repeat(33), "2"]]
  } as any;

  const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

  expect(next.status).toBe("open");
  expect(next.active_question).toMatchObject({
    kind: "table",
    row_labels: ["0"],
    col_labels: ["0", "1"],
    answer: null
  });

  const closedSnapshotWithLongCorrectValue = tableSnapshot("closed");
  closedSnapshotWithLongCorrectValue.active_question = {
    ...closedSnapshotWithLongCorrectValue.active_question,
    answer: [["0", "1"], ["1", "2"]],
    correct_values: [["x".repeat(33), "1"], ["1", "2"]],
    result: { correct_cells: 4, total_cells: 4, explanation: "" }
  } as any;
  const closed = reduceStudentState(
    initialStudentState("DP 課堂"),
    closedSnapshotWithLongCorrectValue
  );
  expect((closed.active_question as any).correct_values).toBeUndefined();
});

test("malformed table result objects and inconsistent counts are discarded", () => {
  const malformedResults = [
    "not an object",
    { correct_cells: 5, total_cells: 4, explanation: "too many" },
    { correct_cells: 3, total_cells: 3, explanation: "wrong total" },
    { correct_cells: 3, total_cells: 4, explanation: 7 }
  ];

  for (const result of malformedResults) {
    const snapshot = tableSnapshot("closed");
    snapshot.active_question = {
      ...snapshot.active_question,
      answer: [["0", "1"], ["1", "2"]],
      correct_values: [["0", "1"], ["1", "2"]],
      result
    } as any;
    const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

    expect((next.active_question as any).correct_values).toEqual([["0", "1"], ["1", "2"]]);
    expect((next.active_question as any).result).toBeUndefined();
  }
});

test("unanswered closed table keeps null counts for a neutral result", () => {
  const snapshot = tableSnapshot("closed");
  snapshot.active_question = {
    ...snapshot.active_question,
    correct_values: [["0", "1"], ["1", "2"]],
    result: { correct_cells: null, total_cells: null, explanation: "看轉移式。" }
  } as any;

  const next = reduceStudentState(initialStudentState("DP 課堂"), snapshot);

  expect((next.active_question as any).result).toEqual({
    correct_cells: null,
    total_cells: null,
    explanation: "看轉移式。"
  });
});

// ---- 中繼：全班廣播不帶個人欄位，套用時不能洗掉學生自己的選擇／答案／結果 ----

const broadcastOpen = (id = "q2") => ({
  state: "active",
  session_id: 7,
  session_title: "迴圈課堂",
  active_question: {
    id,
    kind: "choice",
    prompt: "下一題",
    options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    source_file: "main.cpp",
    line: 4,
    state: "open"
  }
});

test("全班廣播（同一題、無個人欄位）不會洗掉自己的選擇與暱稱", () => {
  const answered = markSubmitted(
    reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot()),
    "b"
  );
  const next = reduceStudentState(answered, broadcastOpen());

  expect(next.status).toBe("answered");
  expect(next.selected_option_id).toBe("b");
  expect(next.nickname).toBe("小明");
});

test("廣播換了一題時不沿用上一題的選擇", () => {
  const answered = markSubmitted(
    reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot()),
    "b"
  );
  const next = reduceStudentState(answered, broadcastOpen("q3"));

  expect(next.status).toBe("open");
  expect(next.selected_option_id).toBeNull();
});

test("關題廣播只有全班結果：選擇題依自己保留的選擇算出對錯，未作答則為 null", () => {
  const closedBroadcast = (selectedBefore: string | null) => {
    const base = reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot());
    const mine = selectedBefore ? markSubmitted(base, selectedBefore) : base;
    return reduceStudentState(mine, {
      ...broadcastOpen(),
      active_question: {
        ...broadcastOpen().active_question,
        state: "closed",
        result: { correct_option_id: "b", explanation: "解釋" }
      }
    });
  };

  const right = closedBroadcast("b");
  const wrong = closedBroadcast("a");
  const none = closedBroadcast(null);

  expect(right.status).toBe("closed");
  expect((right.active_question as any).result).toEqual({
    is_correct: true, correct_option_id: "b", explanation: "解釋"
  });
  expect((wrong.active_question as any).result.is_correct).toBe(false);
  expect((none.active_question as any).result.is_correct).toBeNull();
});

test("填表題廣播保留自己已送出的答案；關題廣播用保留的答案算格數", () => {
  const myAnswer = [["0", "9"], ["1", "2"]];
  const answered = markSubmitted(
    reduceStudentState(initialStudentState("DP 課堂"), tableSnapshot()),
    undefined,
    myAnswer
  );
  expect((answered.active_question as any).answer).toEqual(myAnswer);

  const tableBroadcast = (state: "open" | "closed") => {
    const { answer, ...rest } = tableSnapshot(state).active_question as any;
    return {
      state: "active",
      session_id: 7,
      session_title: "DP 課堂",
      active_question: state === "closed"
        ? { ...rest, correct_values: [["0", "1"], ["1", "2"]], result: { explanation: "看轉移式。" } }
        : rest
    };
  };

  const open = reduceStudentState(answered, tableBroadcast("open"));
  expect(open.status).toBe("answered");
  expect((open.active_question as any).answer).toEqual(myAnswer);

  const closed = reduceStudentState(answered, tableBroadcast("closed"));
  expect(closed.status).toBe("closed");
  expect((closed.active_question as any).result).toEqual({
    correct_cells: 3, total_cells: 4, explanation: "看轉移式。"
  });
});

test("完整個人狀態（帶 selected_option_id: null）仍然可以清掉選擇", () => {
  const answered = markSubmitted(
    reduceStudentState(initialStudentState("迴圈課堂"), openSnapshot()),
    "b"
  );
  const next = reduceStudentState(answered, openSnapshot());

  expect(next.status).toBe("open");
  expect(next.selected_option_id).toBeNull();
});
