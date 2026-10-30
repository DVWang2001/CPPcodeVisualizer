import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { CompileDiagView } from "../CompileDiagView";
import type { Diagnostic } from "../compileDiag";

const d = (message: string, notes: Diagnostic[] = [], line = 2): Diagnostic => ({
  severity: "error", file: "main.cpp", line, col: 5, message, notes,
});
const note = (message: string, line: number): Diagnostic => ({
  severity: "note", file: "main.cpp", line, col: 1, message, notes: [],
});

function render(diag: Diagnostic, family: 7 | 8, kind: string, source?: string): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    ReactDOM.render(React.createElement(CompileDiagView, { diag, family, kind, source }), host);
  });
  return host;
}

const KINDS: [string, 7 | 8, string, string][] = [
  ["incomplete-type", 7, "不完整型別（incomplete-type）", "variable has incomplete type 'Node'"],
  ["abstract-class", 7, "抽象類別（abstract-class）", "variable type 'Shape' is an abstract class"],
  ["override-mismatch", 7, "覆寫不符（override-mismatch）", "'paint' marked 'override' but does not override any member functions"],
  ["lambda-capture", 8, "lambda 捕捉（lambda-capture）", "variable 'n' cannot be implicitly captured in a lambda with no capture-default specified"],
  ["lambda-return", 8, "lambda 回傳型別衝突（lambda-return）", "return type 'const char *' must match previous return type 'int' when lambda expression has unspecified explicit return type"],
  ["goto-jump", 8, "goto 跨越初始化（goto-jump）", "cannot jump from this goto statement to its label"],
  ["vla-file-scope", 8, "全域非常數陣列（vla-file-scope）", "variable length array declaration not allowed at file scope"],
];

describe("CompileDiagView：第三期", () => {
  test.each(KINDS)("%s：渲染中文標題、家族與原始訊息", (kind, family, title, message) => {
    const host = render(d(message), family, kind);
    const root = host.querySelector('[data-testid="compile-diag-view"]') as HTMLElement;
    expect(root.getAttribute("data-kind")).toBe(kind);
    expect(root.textContent).toContain(title);
    expect(root.textContent).toContain(`家族 ${family}`);
    expect(root.textContent).toContain(message);
    ReactDOM.unmountComponentAtNode(host);
  });

  test("lambda 捕捉：畫面只列出 declared here 與 begins here 兩條附註，capture 建議不在畫面上", () => {
    const notes = [
      note("'n' declared here", 2),
      note("lambda expression begins here", 3),
      note("capture 'n' by value", 3),
      note("default capture by reference", 3),
    ];
    const src = "int main() {\n  int n = 1;\n  auto f = []() { return n; };\n}";
    const host = render(d("variable 'n' cannot be implicitly captured in a lambda with no capture-default specified", notes, 3), 8, "lambda-capture", src);
    const visible = host.querySelector('[data-testid="compile-diag-view"]')!.textContent ?? "";
    expect(visible).toContain("'n' declared here（第 2 行）");
    expect(visible).toContain("lambda expression begins here（第 3 行）");
    expect(visible).not.toContain("capture 'n' by value（第");
    expect(visible).not.toContain("default capture by reference（第");
    ReactDOM.unmountComponentAtNode(host);
  });

  test("全域非常數陣列：大小來源的變數名取自附註", () => {
    const notes = [note("read of non-const variable 'n' is not allowed in a constant expression", 2)];
    const host = render(d("variable length array declaration not allowed at file scope", notes), 8, "vla-file-scope");
    expect(host.textContent).toContain("n（執行時才有值）");
    ReactDOM.unmountComponentAtNode(host);
  });
});
