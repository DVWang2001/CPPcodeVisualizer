import { loadDraft, saveDraft } from "../tableDraft";

jest.mock("../../css/studentQuiz.css", () => ({}));

import { submitTableAnswer, tableResultClass } from "../studentQuiz";

const answer = [["0", "1"], ["1", "2"]];

beforeEach(() => {
  localStorage.clear();
});

test("successful table submission applies the snapshot before clearing its draft", async () => {
  saveDraft("table-1", answer);
  const snapshot = { active_question: { id: "table-1", kind: "table", answer } };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(snapshot)
  });
  (global as any).fetch = fetchMock;
  let applied: any = null;

  await submitTableAnswer("table-1", answer, value => {
    expect(loadDraft("table-1", 2, 2)).toEqual(answer);
    applied = value;
  });

  expect(applied).toBe(snapshot);
  expect(loadDraft("table-1", 2, 2)).toEqual([["", ""], ["", ""]]);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/live-quiz/guest/answers");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    question_id: "table-1",
    answer
  });
});

test("409 table submission refreshes state and retains its draft", async () => {
  saveDraft("table-1", answer);
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: () => Promise.resolve({ message: "任意文案" })
  });

  let refreshed = false;
  await submitTableAnswer("table-1", answer, jest.fn(), async () => { refreshed = true; });

  expect(refreshed).toBe(true);
  expect(loadDraft("table-1", 2, 2)).toEqual(answer);
});

test("non-conflict table submission errors retain the draft", async () => {
  saveDraft("table-1", answer);
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: "伺服器忙碌" })
  });

  await expect(submitTableAnswer("table-1", answer, jest.fn())).rejects.toMatchObject({ status: 500 });
  expect(loadDraft("table-1", 2, 2)).toEqual(answer);
});

test("unanswered table result stays neutral instead of comparing null counts equal", () => {
  expect(tableResultClass({ correct_cells: null, total_cells: null, explanation: "" })).toBe("");
  expect(tableResultClass({ correct_cells: 0, total_cells: 4, explanation: "" })).toBe("is-wrong");
  expect(tableResultClass({ correct_cells: 4, total_cells: 4, explanation: "" })).toBe("is-correct");
});
