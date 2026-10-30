import { parseCompileDiagnostics } from "../compileDiag";
import type { Diagnostic } from "../compileDiag";
import { classifyDiagnostic, classifyDiagnostics, toViewItems } from "../compileFamily";

// 訊息文字與 tests/compile-diag/expected.json（實測的 clang 輸出）一致。
const diag = (message: string, file = "main.cpp", notes: Diagnostic[] = [], line = 1): Diagnostic => ({
  severity: "error", file, line, col: 1, message, notes,
});
const note = (message: string, file = "main.cpp", line = 1): Diagnostic => ({
  severity: "note", file, line, col: 1, message, notes: [],
});

describe("classifyDiagnostic：第一期（家族 1–3）", () => {
  test.each([
    ["use of undeclared identifier 'cnt'", "", 1, "undeclared"],
    ["use of undeclared identifier 'std'", "", 1, "missing-include"],
    ["redefinition of 'x'", "", 1, "redefinition"],
    ["cannot initialize a variable of type 'int' with an lvalue of type 'const char[3]'", "", 2, "init-type"],
    ["cannot initialize a variable of type 'int *' with an lvalue of type 'int'", "", 2, "ptr-value"],
    ["cannot initialize return object of type 'int' with an lvalue of type 'const char[7]'", "", 2, "return-type"],
    ["non-constant-expression cannot be narrowed from type 'int' to 'char' in initializer list [-Wc++11-narrowing]", "", 2, "narrowing"],
    ["expected ';' at end of declaration", "", 3, "missing-semicolon"],
    ["expected ';' after top level declarator", "", 3, "missing-semicolon"],
    ["expected ')'", "", 3, "missing-paren"],
    ["missing 'typename' prior to dependent type name 'C::iterator'", "", 3, "missing-typename"],
    ["cannot jump from switch statement to this case label", "", 3, "case-jump"],
  ])("%s → family %p %s", (message, source, family, kind) => {
    expect(classifyDiagnostic(diag(message), source)).toEqual({ family, kind });
  });

  test("未宣告的名稱：原始碼中有同名變數宣告 → out-of-scope，否則 undeclared", () => {
    const src = "int main() {\n  for (int i = 0; i < 3; i++) {}\n  return i;\n}\n";
    expect(classifyDiagnostic(diag("use of undeclared identifier 'i'"), src).kind).toBe("out-of-scope");
    expect(classifyDiagnostic(diag("use of undeclared identifier 'cnt'"), src).kind).toBe("undeclared");
  });
});

describe("classifyDiagnostic：第二期（家族 4–6）", () => {
  test.each([
    ["no matching function for call to 'add'", "main.cpp", [], 4, "no-matching-call"],
    ["call to 'f' is ambiguous", "main.cpp", [], 4, "ambiguous-call"],
    ["no member named 'length' in 'Box'", "main.cpp", [], 4, "no-member"],
    ["no matching constructor for initialization of 'Point'", "main.cpp", [], 4, "no-matching-ctor"],
    ["declaration of variable 'x' with deduced type 'auto' requires an initializer", "main.cpp", [], 5, "auto-no-init"],
    ["invalid operands to binary expression ('Card' and 'Card')", "main.cpp", [], 5, "binary-operator"],
    ["cannot assign to variable 'N' with const-qualified type 'const int'", "main.cpp", [], 6, "const-assign"],
    ["'this' argument to member function 'bump' has type 'const Counter', but function is not marked const", "main.cpp", [], 6, "discards-qualifiers"],
    ["'balance' is a private member of 'Account'", "main.cpp", [], 6, "private-access"],
    ["call to non-static member function without an object argument", "main.cpp", [], 6, "static-context"],
  ])("%s → family %p %s", (message, file, notes, family, kind) => {
    expect(classifyDiagnostic(diag(message, file, notes))).toEqual({ family, kind });
  });

  test("多載找不到：附註說明模板參數無法推導 → deduction-failed（家族 5），否則 no-matching-call", () => {
    const deduce = diag("no matching function for call to 'make'", "main.cpp", [
      note("candidate template ignored: couldn't infer template argument 'T'"),
    ]);
    expect(classifyDiagnostic(deduce)).toEqual({ family: 5, kind: "deduction-failed" });
    const arity = diag("no matching function for call to 'add'", "main.cpp", [
      note("candidate function not viable: requires 2 arguments, but 1 was provided"),
    ]);
    expect(classifyDiagnostic(arity)).toEqual({ family: 4, kind: "no-matching-call" });
  });

  test("同一句 invalid operands：位於標頭檔 → template-operator，位於使用者檔案 → binary-operator", () => {
    const msg = "invalid operands to binary expression ('const Card' and 'const Card')";
    expect(classifyDiagnostic(diag(msg, "/include/c++/v1/__algorithm/comp.h")).kind).toBe("template-operator");
    expect(classifyDiagnostic(diag(msg, "main.cpp")).kind).toBe("binary-operator");
  });
});

describe("classifyDiagnostics", () => {
  test("兩處缺分號分組為 syntax-chain", () => {
    const stderr = [
      "main.cpp:2:12: error: expected ';' at end of declaration",
      "main.cpp:3:12: error: expected ';' at end of declaration",
    ].join("\n");
    const out = classifyDiagnostics(parseCompileDiagnostics(stderr));
    expect(out.map((c) => c.kind)).toEqual(["syntax-chain", "syntax-chain"]);
  });

  test("只有一處缺分號仍是 missing-semicolon", () => {
    const out = classifyDiagnostics(parseCompileDiagnostics("main.cpp:2:12: error: expected ';' at end of declaration"));
    expect(out[0].kind).toBe("missing-semicolon");
  });

  test("warning 不分類為家族，回傳 other", () => {
    const w: Diagnostic = { severity: "warning", file: "main.cpp", line: 4, col: 1, message: "unused variable 'a'", notes: [] };
    expect(classifyDiagnostics([w])[0]).toEqual({ family: "other", kind: "other" });
  });

  test("未知訊息歸為 other，原文保留（分類不丟棄）", () => {
    expect(classifyDiagnostic(diag("some message nobody has seen before"))).toEqual({ family: "other", kind: "other" });
  });
});

describe("toViewItems：錨點規則（第二期）", () => {
  // 形狀與 tests/compile-diag/family5/template-operator.cpp 的實測輸出相同：
  // 標頭內有兩個 invalid operands，各自的附註最後都指向使用者檔案第 6 行。
  const headerErr = (line: number) => ({
    severity: "error" as const, file: "/include/c++/v1/__algorithm/comp.h", line, col: 12,
    message: "invalid operands to binary expression ('const Card' and 'const Card')",
    notes: [
      { severity: "note" as const, file: "/include/c++/v1/__algorithm/sift_down.h", line: 47, col: 3,
        message: "in instantiation of function template specialization 'std::__less<>::operator()<Card, Card>' requested here", notes: [] },
      { severity: "note" as const, file: "main.cpp", line: 6, col: 8,
        message: "in instantiation of function template specialization 'std::sort<Card *>' requested here", notes: [] },
    ],
  });
  const headerNoise = {
    severity: "error" as const, file: "/include/c++/v1/__algorithm/sift_down.h", line: 54, col: 7,
    message: "no matching function for call to object of type 'std::__less<void, void>'", notes: [],
  };

  test("標頭內的模板錯誤：只畫一個畫面，位置換成使用者檔案的錨點（第 6 行）", () => {
    const items = toViewItems([headerErr(40), headerErr(41), headerNoise]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("template-operator");
    expect(items[0].family).toBe(5);
    expect(items[0].diag.file).toBe("main.cpp");
    expect(items[0].diag.line).toBe(6);
  });

  test("使用者檔案中的錯誤各自一個畫面，不被錨點吃掉", () => {
    const user = diag("use of undeclared identifier 'cnt'", "main.cpp", [], 2);
    const items = toViewItems([user, headerErr(40)]);
    expect(items.map((i) => i.kind)).toEqual(["undeclared", "template-operator"]);
  });

  test("找不到錨點的標頭錯誤：退回 other 保留，不丟掉", () => {
    const orphan = { ...headerErr(40), notes: [] };
    const items = toViewItems([orphan]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("other");
  });
});
