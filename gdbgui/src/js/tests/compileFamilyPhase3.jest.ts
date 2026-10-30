import { parseCompileDiagnostics } from "../compileDiag";
import type { Diagnostic } from "../compileDiag";
import { classifyDiagnostic, classifyDiagnostics } from "../compileFamily";

// 訊息文字與 tests/compile-diag/expected.json（實測的 clang 輸出，第三期）一致。
const diag = (message: string, file = "main.cpp", notes: Diagnostic[] = []): Diagnostic => ({
  severity: "error", file, line: 1, col: 1, message, notes,
});

describe("使用者檔案的路徑（瀏覽器引擎的 /workspace/main.cpp）", () => {
  test("/workspace/main.cpp 是使用者檔案，不是標頭；/include/… 才是標頭", () => {
    const { isHeaderFile } = require("../compileFamily");
    expect(isHeaderFile("/workspace/main.cpp")).toBe(false);
    expect(isHeaderFile("main.cpp")).toBe(false);
    expect(isHeaderFile("/include/c++/v1/algorithm")).toBe(true);
  });

  test("/workspace/main.cpp 的 invalid operands 歸為 binary-operator（不是錨點）", () => {
    const d = { severity: "error" as const, file: "/workspace/main.cpp", line: 4, col: 1, message: "invalid operands to binary expression ('Card' and 'Card')", notes: [] };
    expect(classifyDiagnostic(d).kind).toBe("binary-operator");
  });
});

describe("classifyDiagnostic：第三期（家族 7–8）", () => {
  test.each([
    ["variable has incomplete type 'Node'", 7, "incomplete-type"],
    ["variable type 'Shape' is an abstract class", 7, "abstract-class"],
    ["'paint' marked 'override' but does not override any member functions", 7, "override-mismatch"],
    ["only virtual member functions can be marked 'override'", 7, "override-mismatch"],
    ["variable 'n' cannot be implicitly captured in a lambda with no capture-default specified", 8, "lambda-capture"],
    ["return type 'const char *' must match previous return type 'int' when lambda expression has unspecified explicit return type", 8, "lambda-return"],
    ["cannot jump from this goto statement to its label", 8, "goto-jump"],
    ["variable length array declaration not allowed at file scope", 8, "vla-file-scope"],
  ])("%s → family %p %s", (message, family, kind) => {
    expect(classifyDiagnostic(diag(message))).toEqual({ family, kind });
  });

  test("缺少回傳與函式內的 VLA 是警告，不分類（不顯示）", () => {
    const stderr = [
      "main.cpp:4:1: warning: non-void function does not return a value in all control paths [-Wreturn-type]",
      "main.cpp:3:9: warning: variable length arrays in C++ are a Clang extension [-Wvla-cxx-extension]",
    ].join("\n");
    const out = classifyDiagnostics(parseCompileDiagnostics(stderr));
    expect(out.map((c) => c.family)).toEqual(["other", "other"]);
  });
});
