import { parseCompileDiagnostics } from "../compileDiag";

describe("parseCompileDiagnostics", () => {
  test("單一 error：位置與訊息正確，原始碼摘錄與插入點被略過", () => {
    const stderr = [
      "main.cpp:2:33: error: use of undeclared identifier 'cnt'",
      "    2 |   for (int i = 0; i < 3; i++) { cnt += i; }",
      "      |                                 ^",
      "1 error generated.",
    ].join("\n");
    expect(parseCompileDiagnostics(stderr)).toEqual([
      { severity: "error", file: "main.cpp", line: 2, col: 33, message: "use of undeclared identifier 'cnt'", notes: [] },
    ]);
  });

  test("note 掛在前一個 error 之下", () => {
    const stderr = [
      "main.cpp:2:5: error: redefinition of 'x'",
      "    2 | int x = 2;",
      "main.cpp:1:5: note: previous definition is here",
      "    1 | int x = 1;",
      "1 error generated.",
    ].join("\n");
    const [d] = parseCompileDiagnostics(stderr);
    expect(d.message).toBe("redefinition of 'x'");
    expect(d.notes).toEqual([
      { severity: "note", file: "main.cpp", line: 1, col: 5, message: "previous definition is here", notes: [] },
    ]);
  });

  test("多個 error 依順序保留", () => {
    const stderr = [
      "main.cpp:2:12: error: expected ';' at end of declaration",
      "main.cpp:3:12: error: expected ';' at end of declaration",
      "2 errors generated.",
    ].join("\n");
    const ds = parseCompileDiagnostics(stderr);
    expect(ds.map((d) => d.line)).toEqual([2, 3]);
  });

  test("warning 也會被解析，嚴重度為 warning", () => {
    const d = parseCompileDiagnostics("main.cpp:4:1: warning: unused variable 'a'")[0];
    expect(d.severity).toBe("warning");
  });

  test("無法解析的文字與空字串不丟出例外，回傳空陣列", () => {
    expect(parseCompileDiagnostics("")).toEqual([]);
    expect(parseCompileDiagnostics("garbage line\n    1 | x\n")).toEqual([]);
    expect(parseCompileDiagnostics(undefined as unknown as string)).toEqual([]);
  });

  test("孤立的 note（前面沒有診斷）略過", () => {
    expect(parseCompileDiagnostics("main.cpp:1:1: note: orphan")).toEqual([]);
  });
});
