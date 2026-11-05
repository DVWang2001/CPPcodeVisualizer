import { describeLineAfter, fmtValue, fmtOutput, LineAfterPayload } from "../lineAfterText";

const base = (over: Partial<LineAfterPayload>): LineAfterPayload => ({
  line: 5,
  fn: "main",
  depth: 1,
  after: { kind: "stop", line: 6, changed: [] },
  stdout: "",
  stderr: null,
  ...over,
} as LineAfterPayload);

describe("fmtValue / fmtOutput", () => {
  test("undefined means the variable is not declared yet", () => {
    expect(fmtValue(undefined)).toBe("（尚未宣告）");
    expect(fmtValue(2)).toBe("2");
    expect(fmtValue([1, 2])).toBe("[1,2]");
  });
  test("line breaks in output are made visible", () => {
    expect(fmtOutput("one\ntwo")).toBe("one⏎two");
  });
});

describe("describeLineAfter", () => {
  test("a declaration line shows the variable going from not-declared to its value", () => {
    const lines = describeLineAfter(
      base({ after: { kind: "stop", line: 6, changed: [{ name: "b", from: undefined, to: 2, existed: false }] } })
    );
    expect(lines[0]).toBe("第 5 行執行後");
    expect(lines[1]).toBe("變數 b：（尚未宣告） → 2");
  });

  test("a line that changes nothing says so", () => {
    const lines = describeLineAfter(base({ after: { kind: "stop", line: 6, changed: [] } }));
    expect(lines[1]).toBe("這一行沒有改變任何變數。");
  });

  test("output the line printed, with its newline made visible", () => {
    const lines = describeLineAfter(base({ stdout: "one\n" }));
    expect(lines).toContain("輸出：「one⏎」");
  });

  test("no output says so; unknown output (null) is not presented as empty", () => {
    expect(describeLineAfter(base({ stdout: "" }))).toContain("輸出：（這一行沒有印出文字）");
    expect(describeLineAfter(base({ stdout: null }))).toContain("輸出：（無法對應到這一行）");
  });

  test("frame exit, program end and an unfinished run are stated plainly", () => {
    expect(describeLineAfter(base({ after: { kind: "frame-exit", changed: [] } }))).toContain(
      "這個函式在此結束，控制權回到呼叫它的地方。"
    );
    expect(describeLineAfter(base({ after: { kind: "program-end", changed: [] } }))).toContain("程式在此結束。");
    expect(describeLineAfter(base({ after: { kind: "unfinished", reason: "trap", changed: [] } }))).toContain(
      "程式在這一行中止（trap），之後的狀態不可用。"
    );
  });

  test("stderr is shown only when the line wrote to it", () => {
    expect(describeLineAfter(base({ stderr: "warn\n" }))).toContain("錯誤輸出：「warn⏎」");
    expect(describeLineAfter(base({ stderr: null })).some((l) => l.startsWith("錯誤輸出"))).toBe(false);
  });
});
