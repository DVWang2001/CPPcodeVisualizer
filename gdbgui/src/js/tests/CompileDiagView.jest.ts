import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { CompileDiagView, candidateNotes, CANDIDATE_LIMIT } from "../CompileDiagView";
import type { Diagnostic } from "../compileDiag";

const d = (message: string, notes: Diagnostic[] = [], line = 2): Diagnostic => ({
  severity: "error", file: "main.cpp", line, col: 5, message, notes,
});
const cand = (message: string, line: number): Diagnostic => ({
  severity: "note", file: "main.cpp", line, col: 1, message, notes: [],
});

function render(diag: Diagnostic, family: 1 | 2 | 3 | 4 | 5 | 6 | "other", kind: string, source?: string): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    ReactDOM.render(React.createElement(CompileDiagView, { diag, family, kind, source }), host);
  });
  return host;
}

const KINDS: [string, 1 | 2 | 3 | 4 | 5 | 6, string][] = [
  ["undeclared", 1, "未宣告的名稱（undeclared）"],
  ["out-of-scope", 1, "超出作用域（out-of-scope）"],
  ["redefinition", 1, "重複定義（redefinition）"],
  ["missing-include", 1, "缺少標頭（missing-include）"],
  ["init-type", 2, "初始化型別不符（init-type）"],
  ["ptr-value", 2, "指標與值（ptr-value）"],
  ["return-type", 2, "回傳型別不符（return-type）"],
  ["narrowing", 2, "窄化轉換（narrowing）"],
  ["missing-semicolon", 3, "缺少分號（missing-semicolon）"],
  ["missing-paren", 3, "缺少右括號（missing-paren）"],
  ["syntax-chain", 3, "語法連鎖（syntax-chain）"],
  ["missing-typename", 3, "缺少 typename（missing-typename）"],
  ["case-jump", 3, "跨越 case 初始化（case-jump）"],
  ["no-matching-call", 4, "參數不符（no-matching-call）"],
  ["ambiguous-call", 4, "二義性呼叫（ambiguous-call）"],
  ["no-member", 4, "沒有這個成員（no-member）"],
  ["no-matching-ctor", 4, "建構子參數不符（no-matching-ctor）"],
  ["deduction-failed", 5, "模板推導失敗（deduction-failed）"],
  ["template-operator", 5, "模板實例化失敗（template-operator，錨點）"],
  ["auto-no-init", 5, "auto 沒有初始值（auto-no-init）"],
  ["binary-operator", 5, "運算子不支援（binary-operator）"],
  ["const-assign", 6, "修改常數（const-assign）"],
  ["discards-qualifiers", 6, "const 物件呼叫非 const 方法（discards-qualifiers）"],
  ["private-access", 6, "存取私有成員（private-access）"],
  ["static-context", 6, "靜態上下文（static-context）"],
];

describe("CompileDiagView", () => {
  test.each(KINDS)("%s：渲染中文標題、家族與原始訊息", (kind, family, title) => {
    const host = render(d("raw clang text"), family, kind);
    const root = host.querySelector('[data-testid="compile-diag-view"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute("data-kind")).toBe(kind);
    expect(root.textContent).toContain(title);
    expect(root.textContent).toContain(`家族 ${family}`);
    expect(root.textContent).toContain("raw clang text");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("顯示錯誤行的原始碼片段（取自編輯器內容）", () => {
    const src = "int main() {\n  int x = \"hi\";\n  return x;\n}";
    const host = render(d("cannot initialize a variable of type 'int' with an lvalue of type 'const char[3]'"), 2, "init-type", src);
    expect(host.querySelector("pre")?.textContent).toContain('int x = "hi";');
    ReactDOM.unmountComponentAtNode(host);
  });

  test("未宣告的名稱：畫面中的名稱取自 clang 訊息（cnt），不是寫死的", () => {
    const host = render(d("use of undeclared identifier 'cnt'"), 1, "undeclared");
    expect(host.textContent).toContain("沒有 cnt");
    expect(host.textContent).toContain("編譯器從內往外找 cnt");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("缺少標頭：根因區塊存在，std 寫成「標準函式庫（std）」", () => {
    const host = render(d("use of undeclared identifier 'std'"), 1, "missing-include");
    expect(host.textContent).toContain("根因");
    expect(host.textContent).toContain("標準函式庫（std）");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("窄化轉換：位元條有 9 格（300 = 1 0010 1100）", () => {
    const host = render(d("non-constant-expression cannot be narrowed from type 'int' to 'char' in initializer list [-Wc++11-narrowing]"), 2, "narrowing");
    expect(host.textContent).toContain("1 0010 1100");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("附註會出現在原始訊息區（例如 redefinition 的 previous definition）", () => {
    const note: Diagnostic = { severity: "note", file: "main.cpp", line: 1, col: 5, message: "previous definition is here", notes: [] };
    const host = render(d("redefinition of 'x'", [note]), 1, "redefinition");
    expect(host.textContent).toContain("previous definition is here");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("參數不符：說明列出需要與實際給的參數數量", () => {
    const note = cand("candidate function not viable: requires 2 arguments, but 1 was provided", 1);
    const host = render(d("no matching function for call to 'add'", [note]), 4, "no-matching-call", "void add(int a, int b) { }");
    expect(host.textContent).toContain("1 個參數");
    expect(host.textContent).toContain("2 個參數");
    expect(host.querySelector('[data-testid="candidate-list"]')).not.toBeNull();
    ReactDOM.unmountComponentAtNode(host);
  });

  test("模板錨點：說明的型別名稱取自訊息（Card）", () => {
    const host = render(d("invalid operands to binary expression ('const Card' and 'const Card')"), 5, "template-operator");
    expect(host.textContent).toContain("根因：Card 沒有 operator<");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("const 物件呼叫非 const 方法：方法名與物件型別取自訊息", () => {
    const msg = "'this' argument to member function 'bump' has type 'const Counter', but function is not marked const";
    const host = render(d(msg), 6, "discards-qualifiers");
    expect(host.textContent).toContain("bump() 的宣告");
    expect(host.textContent).toContain("const Counter");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("未知子類型退回 other 畫面，不丟例外", () => {
    const host = render(d("mystery"), "other", "other");
    expect(host.textContent).toContain("其他");
    expect(host.textContent).toContain("mystery");
    ReactDOM.unmountComponentAtNode(host);
  });
});

describe("候選清單", () => {
  test("隱含的複製與移動建構子不算候選（與使用者的錯誤無關）", () => {
    const notes = [
      cand("candidate constructor (the implicit copy constructor) not viable: no known conversion", 1),
      cand("candidate constructor (the implicit move constructor) not viable: no known conversion", 1),
      cand("candidate constructor not viable: requires 2 arguments, but 1 was provided", 2),
    ];
    expect(candidateNotes(notes)).toHaveLength(1);
  });

  test("超過上限時只顯示前 5 個，並註明還有幾個", () => {
    const notes = Array.from({ length: 8 }, (_, i) => cand(`candidate function ${i}`, i + 1));
    const host = render(d("call to 'f' is ambiguous", notes), 4, "ambiguous-call", "x");
    const list = host.querySelector('[data-testid="candidate-list"]') as HTMLElement;
    expect(list.querySelectorAll('[data-testid="candidate-item"]').length).toBe(CANDIDATE_LIMIT);
    expect(list.textContent).toContain("還有 3 個候選");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("候選數量在上限以內時不顯示「還有…」", () => {
    const notes = [cand("candidate function a", 1), cand("candidate function b", 2)];
    const host = render(d("call to 'f' is ambiguous", notes), 4, "ambiguous-call", "x");
    expect(host.textContent).not.toContain("還有");
    ReactDOM.unmountComponentAtNode(host);
  });
});
