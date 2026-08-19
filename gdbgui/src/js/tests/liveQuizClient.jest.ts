jest.mock("socket.io-client", () => ({ connect: jest.fn() }));

import { triggerLiveQuestion } from "../liveQuizClient";

beforeEach(() => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ id: 7 })
  });
});

test("choice trigger keeps the original two-field request", async () => {
  await triggerLiveQuestion(7, "choice/1", "main.cpp", 3);

  expect(JSON.parse((global as any).fetch.mock.calls[0][1].body)).toEqual({
    source_file: "main.cpp",
    line: 3
  });
});

test("table trigger adds the captured table and selected variable", async () => {
  const table = {
    rows: 1, cols: 1, row_labels: ["0"], col_labels: ["0"], values: [["8"]]
  };

  await triggerLiveQuestion(7, "table/1", "main.cpp", 3, { table, var_hint: "dp" });

  expect(JSON.parse((global as any).fetch.mock.calls[0][1].body)).toEqual({
    source_file: "main.cpp",
    line: 3,
    table,
    var_hint: "dp"
  });
});
