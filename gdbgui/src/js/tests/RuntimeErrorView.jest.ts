// 執行錯誤圖解（P2）的畫面：每一種錯誤一個畫面，結構照設計稿（docs/superpowers/designs/runtime-errors-p2/）。
// 值全部來自 fixtures/runtimeRuns.json（lab-david 上 P1 引擎的真實執行）經過 runtimeDiag.diagnose。
import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { RuntimeErrorView } from "../RuntimeErrorView";
import { diagnose, RtRun, RtDiag, RtWhich } from "../runtimeDiag";

const FIX = require("./fixtures/runtimeRuns.json");

function runOf(id: string): RtRun {
  const r = FIX.runs[id];
  const steps: any[] = new Array(r.nSteps);
  r.steps.forEach((p: [number, any]) => {
    steps[p[0]] = p[1];
  });
  return { errors: r.runtimeErrors, exit: r.exit, steps, source: r.src, functions: r.functions, decls: r.decls, classes: r.classes };
}

const hosts: HTMLDivElement[] = [];
function render(
  diag: RtDiag,
  stepNow: number | null = null,
  onJump: (step: number) => void = () => undefined,
  status?: "paused" | "ended" | "stopped"
): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  act(() => {
    ReactDOM.render(React.createElement(RuntimeErrorView, { diag, stepNow, onJump, status }), host);
  });
  return host;
}
afterEach(() => {
  while (hosts.length) {
    const h = hosts.pop() as HTMLDivElement;
    ReactDOM.unmountComponentAtNode(h);
    h.remove();
  }
});
const q = (h: HTMLElement, sel: string) => h.querySelector(sel) as HTMLElement;
const qa = (h: HTMLElement, sel: string) => Array.prototype.slice.call(h.querySelectorAll(sel)) as HTMLElement[];

const CASES: [string, RtWhich, string, string][] = [
  ["div0_input", 0, "div-by-zero", "整數除以零"],
  ["ex_err_int_overflow", 0, "signed-overflow", "有號整數溢位"],
  ["ex_err_array_oob", 0, "array-bounds", "陣列索引超出範圍"],
  ["vec_oob", 0, "container-index", "vector 索引超出範圍"],
  ["stack_empty_top", 0, "empty-container", "對空的 stack 呼叫 top()"],
  ["ex_err_null_deref", 0, "null-deref", "透過空指標存取成員"],
  ["missing_return", 0, "missing-return", "函式走到結尾都沒有 return"],
  ["inf_recursion", "stack-overflow", "stack-overflow", "遞迴停不下來，堆疊用完了"],
  ["intmin_div", 0, "other", "執行錯誤"],
];

describe("RuntimeErrorView", () => {
  test.each(CASES)("%s：標題、狀態標籤、錯誤行與底線、原始訊息", (id, which, kind, title) => {
    const d = diagnose(runOf(id), which);
    const host = render(d);
    const root = q(host, '[data-testid="rt-view"]');
    expect(root).not.toBeNull();
    expect(root.getAttribute("data-kind")).toBe(kind);
    expect(q(root, '[data-testid="rt-title"]').textContent).toContain(title);
    expect(q(root, '[data-testid="rt-chip"]').textContent).toBe(d.fatal ? "程式在這裡結束" : "已暫停，可以按「繼續」");
    expect(q(root, '[data-testid="rt-code"]').textContent).toContain(String(d.line));
    if (d.bad) expect(q(root, '[data-testid="rt-bad"]').textContent).toBe(d.code.slice(d.bad[0], d.bad[1]));
    expect(q(root, '[data-testid="rt-raw"]').textContent).toContain(d.raw);
    const heads = qa(root, '[data-testid="rt-sec-head"]').map((e) => e.textContent);
    if (kind === "other") expect(heads).toEqual([]);
    else expect(heads).toEqual(["1發生了什麼", "2值從哪裡來", "3怎麼改"]);
  });

  test("值從哪裡來：點「跳到那一步」用那一步的索引呼叫 onJump", () => {
    const onJump = jest.fn();
    const host = render(diagnose(runOf("ex_err_int_overflow"), 0), null, onJump);
    const links = qa(host, '[data-testid="rt-jump"]');
    expect(links.length).toBe(2);
    act(() => {
      links[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledWith(46);
  });

  test("有號溢位（階乘）：正確答案 33 格，切掉 1 格；存進去 32 格，第一格是正負號；有數線", () => {
    const host = render(diagnose(runOf("ex_err_int_overflow"), 0));
    expect(qa(host, '[data-testid="rt-bits-exact"] .rt-bit').length).toBe(33);
    expect(qa(host, '[data-testid="rt-bits-exact"] .rt-bit-cut').length).toBe(1);
    const stored = qa(host, '[data-testid="rt-bits-stored"] .rt-bit');
    expect(stored.length).toBe(32);
    expect(stored[0].className).toContain("rt-bit-sign");
    expect(stored[0].className).not.toContain("rt-bit-neg");
    expect(q(host, '[data-testid="rt-numline"]')).not.toBeNull();
  });

  test("有號溢位（加法）：沒有被切掉的位，正負號那一格是 1，標成變成負數", () => {
    const host = render(diagnose(runOf("ovf_add"), 0));
    expect(qa(host, '[data-testid="rt-bits-exact"] .rt-bit-cut').length).toBe(0);
    const stored = qa(host, '[data-testid="rt-bits-stored"] .rt-bit');
    expect(stored[0].className).toContain("rt-bit-neg");
    expect(host.textContent).toContain("負數");
  });

  test("陣列越界：框外格；停在錯誤那一步時還沒有記憶體排列圖，繼續之後才有", () => {
    const d = diagnose(runOf("ex_err_array_oob"), 0);
    const before = render(d, 11);
    expect(q(before, '[data-testid="rt-out-cell"]').textContent).toBe("？");
    expect(q(before, '[data-testid="rt-after"]')).toBeNull();
    const after = render(d, 12);
    const pic = q(after, '[data-testid="rt-after"]');
    expect(pic.textContent).toContain("示意");
    expect(pic.textContent).toContain("b.guard");
    expect(pic.textContent).toContain("42");
  });

  test("程式跑完了（回到編輯模式）：陣列越界畫出記憶體排列，標籤「程式已經結束」，沒有「跳到」按鈕", () => {
    const host = render(diagnose(runOf("ex_err_array_oob"), 0), null, () => undefined, "ended");
    expect(q(host, '[data-testid="rt-after"]').textContent).toContain("b.guard");
    expect(q(host, '[data-testid="rt-chip"]').textContent).toBe("程式已經結束");
    expect(qa(host, '[data-testid="rt-jump"]').length).toBe(0);
    expect(q(host, '[data-testid="rt-nojump"]').textContent).toContain("重新執行");
  });

  test("停在錯誤那一步就按「編輯」（程式停止、沒有跑完）：標籤「程式已經停止」，沒有「跳到」按鈕，還沒有記憶體排列", () => {
    const host = render(diagnose(runOf("ex_err_array_oob"), 0), 11, () => undefined, "stopped");
    expect(q(host, '[data-testid="rt-chip"]').textContent).toBe("程式已經停止");
    expect(q(host, '[data-testid="rt-after"]')).toBeNull();
    expect(qa(host, '[data-testid="rt-jump"]').length).toBe(0);
    expect(host.textContent).toContain("重新執行");
  });

  test("溢位：程式結束後不再叫人按「繼續」", () => {
    const host = render(diagnose(runOf("ex_err_int_overflow"), 0), null, () => undefined, "ended");
    expect(host.textContent).not.toContain("按「繼續」");
    expect(host.textContent).toContain("這一行執行完");
  });

  test("溢位：停在錯誤那一行，但畫面顯示的是這一行執行後（stepNow 在錯誤那一步之後）：說存進去的值，不叫人按「繼續」", () => {
    const d = diagnose(runOf("ex_err_int_overflow"), 0);
    const atStop = render(d, d.step, () => undefined, "paused");
    expect(atStop.textContent).toContain("按「繼續」之後");
    const shownAfter = render(d, d.step + 1, () => undefined, "paused");
    expect(shownAfter.textContent).not.toContain("按「繼續」之後"); // 狀態標籤「已暫停，可以按「繼續」」照舊
    expect(shownAfter.textContent).toContain("這一行執行完");
  });

  test("會讓程式結束的錯誤：程式結束後標籤仍是「程式在這裡結束」", () => {
    const host = render(diagnose(runOf("div0_input"), 0), null, () => undefined, "ended");
    expect(q(host, '[data-testid="rt-chip"]').textContent).toBe("程式在這裡結束");
  });

  test("vector 越界：size 邊界線與框外格", () => {
    const host = render(diagnose(runOf("vec_oob"), 0));
    expect(q(host, '[data-testid="rt-size-edge"]').textContent).toBe("size = 5");
    expect(qa(host, '[data-testid="rt-cells"] .rt-cell').length).toBe(5);
    expect(q(host, '[data-testid="rt-out-cell"]')).not.toBeNull();
  });

  test("空指標：沒有箭頭的物件圖，nullptr 的欄位標紅", () => {
    const host = render(diagnose(runOf("ex_err_null_deref"), 0));
    expect(qa(host, '[data-testid="rt-obj"]').length).toBe(3); // b、a 兩個物件與指標 cur
    expect(qa(host, '[data-null="1"]').length).toBe(1);
    expect(host.querySelector("[marker-end]")).toBeNull();
  });

  test("程式碼只在空白處換行：cur->next->val 整段不斷行（程式碼那一行與「怎麼改」）", () => {
    const host = render(diagnose(runOf("ex_err_null_deref"), 0));
    const runs = (sel: string) => qa(q(host, sel), ".rt-nobr").map((e) => e.textContent || "");
    expect(runs('[data-testid="rt-code"]')).toContain("cur->next->val");
    expect(runs(".rt-fix")).toContain("cur->next->val");
    expect(runs(".rt-fix").every((t) => !/\s/.test(t))).toBe(true);
    expect(q(host, '[data-testid="rt-code"]').textContent).toContain("cur->next->val");
  });

  test("遞迴的「怎麼改」：註解自己一行，不和程式擠在同一行", () => {
    const host = render(diagnose(runOf("inf_recursion"), "stack-overflow"));
    const lines = qa(q(host, ".rt-fix"), "div").map((e) => e.textContent || "");
    const at = lines.findIndex((t) => /^\s*if \(n == 0\) return 0;\s*$/.test(t));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toMatch(/^\s*\/\/ /);
  });

  test("無窮遞迴：塔的上 3 層與下 6 層，中間省略 62119 層", () => {
    const host = render(diagnose(runOf("inf_recursion"), "stack-overflow"));
    expect(qa(host, '[data-testid="rt-frame"]').length).toBe(9);
    expect(q(host, '[data-testid="rt-gap"]').textContent).toContain("62119");
  });

  test("堆疊用完但有停止條件：列出兩種可能，並說明 n 永遠不會等於 0", () => {
    const host = render(diagnose(runOf("rec_cond"), "stack-overflow"));
    const text = host.textContent || "";
    expect(text).toContain("呼叫太多層，堆疊用完了");
    expect(text).toContain("停止條件");
    expect(text).toContain("瀏覽器");
    expect(text).toContain("永遠不會剛好等於 0");
  });
});
