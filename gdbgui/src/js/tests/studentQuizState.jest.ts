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

  expect(waiting.status).toBe("waiting");
  expect(closed.status).toBe("closed");
  expect(closed.active_question!.result!.correct_option_id).toBe("b");
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
