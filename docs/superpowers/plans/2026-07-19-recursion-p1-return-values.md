# P1 — 回傳值上樹 + 點節點跳行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 呼叫樹節點在返回時顯示 `⇒ 回傳值`（F1），點節點跳到對應原始碼行（F4-1），並交付前兩個教案 `rec_sum.cpp` / `rec_sum_tail.cpp`。

**Architecture:** 回傳值採「教案約定 result 變數」：`Locals.save_locals` 收到 locals 時，把名為 `result` 的變數值記到目前選取 frame 對應的呼叫樹節點（`lastResult` 緩存）；`ingestStack` 在節點由 live 轉 returned 的那一刻，把緩存定格成 `retValue` 並回報 `justReturned` 清單。CallGraph 據此渲染綠色 `⇒ v` 與邊上的暫時 `↑v`。跳行重用既有的 `gdbgui_navigate_to_error(line, col)`。

**Tech Stack:** TypeScript + React（class components）、statorgfc store、Jest。無新依賴。

**Spec:** `docs/superpowers/specs/2026-07-19-recursion-coverage-roadmap-design.md`（F1、F4-1、教案 #1 #2）

## Global Constraints

- 教學場景 ≤ ~30 次呼叫；不做摺疊/虛擬化。
- 顏色走 design token / spec 既定值：綠 `#3AA76D`、琥珀 `var(--highlight)`、靛藍 `var(--accent)`。
- 無 `result` 變數的程式碼必須完全不受影響（retValue 維持 undefined，只變淡）。
- 不新增 npm 依賴。
- commit 走既有 conventional style（`feat(callgraph): ...`）；pre-commit hook 會自動跑 jest。
- 註解語法見 `AUTHORING_GUIDE.md` §1.1：行尾單一 `//@`，欄位 `@guide` `@tts` `@layout` 可省略、順序任意。

---

### Task 1: callTree — retValue 定格與 justReturned

**Files:**
- Modify: `gdbgui/src/js/callTree.ts`
- Test: `gdbgui/src/js/tests/callTree.jest.ts`（追加 describe 區塊）

**Interfaces:**
- Produces:
  - `CallNode` 增加 `lastResult?: string`（緩存）與 `retValue?: string`（定格後的回傳值）
  - `IngestResult` 增加 `justReturned: number[]`（本次快照剛轉 returned 的 invId）
  - `recordResultLocal(tree: CallTree, invId: number | null, locals: Array<{ name: string; value: any }>): void`
  - `resolveSelectedInvId(activePath: number[], selectedFrameNum: number): number | null`

- [ ] **Step 1: 追加失敗測試**

`gdbgui/src/js/tests/callTree.jest.ts` **檔頭既有的 import 擴充**（不要新增第二行 import，把 `recordResultLocal`、`resolveSelectedInvId` 加進既有大括號；`Frame` 型別若未 import 也一併補上），然後在檔尾追加：

```ts
describe("return values — recordResultLocal + retValue", () => {
  const f = (func: string, addr: string, line: number, args: Frame["args"] = []): Frame =>
    ({ func, addr, line, args });

  test("cached result is stamped as retValue when the node returns", () => {
    const tree = createCallTree();
    ingestStack(tree, [f("sum", "0x2", 12, [{ name: "n", value: "2" }]), f("main", "0x1", 20)]);
    const r1 = ingestStack(tree, [f("sum", "0x2", 13, [{ name: "n", value: "2" }]), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "result", value: "3" }]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]);
    const sum = r2.nodes.find(n => n.func === "sum")!;
    expect(sum.returned).toBe(true);
    expect(sum.retValue).toBe("3");
    expect(r2.justReturned).toEqual([sum.invId]);
  });

  test("no `result` local → retValue stays undefined, node just dims", () => {
    const tree = createCallTree();
    const r1 = ingestStack(tree, [f("g", "0x2", 5), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "x", value: "9" }]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]);
    const g = r2.nodes.find(n => n.func === "g")!;
    expect(g.returned).toBe(true);
    expect(g.retValue).toBeUndefined();
  });

  test("justReturned lists only nodes flipped in this snapshot", () => {
    const tree = createCallTree();
    ingestStack(tree, [f("a", "0x2", 5), f("main", "0x1", 20)]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]); // a returns
    expect(r2.justReturned.length).toBe(1);
    const r3 = ingestStack(tree, [f("main", "0x1", 21)]); // nothing new returns
    expect(r3.justReturned).toEqual([]);
  });

  test("recordResultLocal tolerates null/unknown invId", () => {
    const tree = createCallTree();
    expect(() => recordResultLocal(tree, null, [{ name: "result", value: "1" }])).not.toThrow();
    expect(() => recordResultLocal(tree, 999, [{ name: "result", value: "1" }])).not.toThrow();
  });

  test("re-activated same-sig node (loop call) clears stale retValue", () => {
    const tree = createCallTree();
    const r1 = ingestStack(tree, [f("h", "0x2", 5), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "result", value: "7" }]);
    ingestStack(tree, [f("main", "0x1", 20)]);           // h returns, retValue=7
    const r3 = ingestStack(tree, [f("h", "0x2", 5), f("main", "0x1", 20)]); // same call site again
    const h = r3.nodes.find(n => n.func === "h")!;
    expect(h.returned).toBe(false);
    expect(h.retValue).toBeUndefined();
  });
});

describe("resolveSelectedInvId", () => {
  test("frame 0 (top) maps to last element of activePath", () => {
    expect(resolveSelectedInvId([1, 2, 3], 0)).toBe(3);
  });
  test("deeper selected frame walks toward the root", () => {
    expect(resolveSelectedInvId([1, 2, 3], 2)).toBe(1);
  });
  test("empty path or out-of-range returns null", () => {
    expect(resolveSelectedInvId([], 0)).toBeNull();
    expect(resolveSelectedInvId([1], 5)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest callTree -t "return values"`
Expected: FAIL — `recordResultLocal is not a function` / type errors。

- [ ] **Step 3: 實作 callTree.ts**

`CallNode` 型別加兩個欄位：

```ts
export type CallNode = {
    invId: number;
    sig: string;
    func: string;
    args: Array<{ name: string; value: any }>;
    line: string | number;
    parentInvId: number | null;
    returned: boolean;
    lastResult?: string;   // result 變數的最新緩存（活著時持續覆寫）
    retValue?: string;     // 返回瞬間定格的回傳值
};
```

`IngestResult` 加 `justReturned: number[]`（空堆疊 early-return 也要帶 `justReturned: []`）。

`ingestStack` 內兩處修改。upsert 的 else 分支（節點已存在）開頭加重新活化清理：

```ts
        } else {
            if (node.returned) {
                // Same call site invoked again (loop) — stale value must not leak.
                node.retValue = undefined;
                node.lastResult = undefined;
            }
            node.line = frame.line ?? node.line;
            if (frame.args && frame.args.length > 0) node.args = frame.args;
        }
```

returned 標記迴圈改為轉移偵測：

```ts
    const justReturned: number[] = [];
    for (const node of tree.bySig.values()) {
        const nowReturned = !liveInvIds.has(node.invId);
        if (nowReturned && !node.returned) {
            node.retValue = node.lastResult;
            justReturned.push(node.invId);
        }
        node.returned = nowReturned;
    }
```

`justReturned` 放進回傳物件。檔尾加兩個新函式：

```ts
/**
 * Cache the teaching-convention `result` local onto one invocation. Called
 * whenever fresh locals arrive; the value is frozen into `retValue` at the
 * moment the invocation returns (see ingestStack).
 */
export function recordResultLocal(
    tree: CallTree,
    invId: number | null,
    locals: Array<{ name: string; value: any }>
): void {
    if (invId == null || !locals) return;
    const local = locals.find(l => l.name === "result");
    if (!local) return;
    for (const node of tree.bySig.values()) {
        if (node.invId === invId) {
            node.lastResult = String(local.value);
            return;
        }
    }
}

/** Map gdbgui's selected_frame_num (0 = top) onto the activePath (root → top). */
export function resolveSelectedInvId(
    activePath: number[],
    selectedFrameNum: number
): number | null {
    if (!activePath || activePath.length === 0) return null;
    const idx = activePath.length - 1 - (selectedFrameNum || 0);
    return idx >= 0 && idx < activePath.length ? activePath[idx] : null;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx jest callTree`
Expected: 全部 PASS（含既有的 ingestStack 測試 — 若既有測試因 `justReturned` 欄位新增而壞，只能是斷言整個物件形狀的測試，改斷言容忍新欄位，不可改產品碼遷就）。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/callTree.ts gdbgui/src/js/tests/callTree.jest.ts
git commit -m "feat(callgraph): capture teaching-convention result value into call tree"
```

---

### Task 2: Locals → 呼叫樹的接線

**Files:**
- Modify: `gdbgui/src/js/Locals.tsx`（`save_locals`，約 79–86 行）

**Interfaces:**
- Consumes: Task 1 的 `recordResultLocal`、`resolveSelectedInvId`；global `gdbgui_global_variable.__call_tree` / `__active_path`（`Threads.tsx:251-258` 設定）；store `selected_frame_num`。
- Produces: 無新介面 — 副作用接線。

- [ ] **Step 1: 修改 save_locals**

`Locals.tsx` 頂部加 import：

```ts
import { recordResultLocal, resolveSelectedInvId } from "./callTree";
```

`save_locals` 在 `store.set("locals", locals_with_meta);` 之後追加：

```ts
    // Teaching convention (spec F1): a local named `result` is this frame's
    // eventual return value — cache it on the matching call-tree invocation.
    const gv = (window as any).gdbgui_global_variable;
    if (gv && gv.__call_tree) {
      const invId = resolveSelectedInvId(
        gv.__active_path || [],
        parseInt(store.get("selected_frame_num")) || 0
      );
      recordResultLocal(gv.__call_tree, invId, locals_with_meta);
    }
```

- [ ] **Step 2: 全套測試 + type check**

Run: `npx jest && npx tsc --noEmit`
Expected: jest 全 PASS；tsc 無新錯誤（若 repo 原本就有既存 tsc 錯誤，只要求不新增）。

- [ ] **Step 3: Commit**

```bash
git add gdbgui/src/js/Locals.tsx
git commit -m "feat(callgraph): wire locals result variable into call tree cache"
```

---

### Task 3: CallGraph 渲染 — 綠色 ⇒ 值、邊上 ↑值、e2e 資料屬性

**Files:**
- Modify: `gdbgui/src/js/CallGraph.tsx`（`resolveLabel` 約 62–91 行、node JSX 約 217–240 行、svg 約 174–199 行）
- Modify: `gdbgui/src/js/Threads.tsx`（`update_stack` 約 254–261 行）

**Interfaces:**
- Consumes: `CallNode.retValue`、`IngestResult.justReturned`（Task 1）。
- Produces: global `gdbgui_global_variable.__just_returned: number[]`；node DOM 屬性 `data-invid`、`data-state`（`current|active|returned|live`）、`data-ret`（e2e 合約用）。

- [ ] **Step 1: Threads.tsx 曝露 justReturned**

`update_stack` 中 `global_variable.__active_path = result.activePath;` 之後加一行：

```ts
      global_variable.__just_returned = result.justReturned;
```

- [ ] **Step 2: resolveLabel 回傳 ret 欄位**

`resolveLabel` 簽名改為回傳 `{ lines: string[]; color: string | null; ret: string | null }`；在 `return { lines, color };` 前加：

```ts
        const ret = node.returned && node.retValue !== undefined ? `⇒ ${node.retValue}` : null;
```

並改為 `return { lines, color, ret };`（呼叫端解構同步加 `ret`）。

- [ ] **Step 3: node JSX 渲染 ⇒ 值與 data 屬性**

節點 div 的解構改 `const { lines, color, ret } = this.resolveLabel(node, isCurrent);`。div 屬性追加：

```tsx
                                    data-invid={node.invId}
                                    data-state={isCurrent ? "current" : onPath ? "active" : node.returned ? "returned" : "live"}
                                    data-ret={node.retValue}
```

`{lines.map(...)}` 之後追加：

```tsx
                                    {ret && (
                                        <span style={{ color: "#3AA76D", fontWeight: 700, fontSize: "0.9em", whiteSpace: "nowrap" }}>
                                            {ret}
                                        </span>
                                    )}
```

- [ ] **Step 4: svg 邊上渲染剛返回的 ↑值**

`{edges.map(...)}` 之後（仍在 `<svg>` 內）追加：

```tsx
                            {((gv.__just_returned as number[]) || []).map(id => {
                                const n = posById.get(id);
                                if (!n || n.parentInvId == null || n.retValue === undefined) return null;
                                const p = posById.get(n.parentInvId);
                                if (!p) return null;
                                const mx = (n.x + p.x) / 2 + NODE_W / 2 + 6;
                                const my = (n.y + p.y + NODE_H) / 2 + 4;
                                return (
                                    <text key={`ret-${id}`} x={mx} y={my} fill="#3AA76D"
                                        fontWeight={700} fontSize={12} fontFamily="var(--font-mono)">
                                        {`↑${n.retValue}`}
                                    </text>
                                );
                            })}
```

（`↑值` 只存在於返回發生的那一個快照 — 下次 ingest 覆寫 `__just_returned` 自然消失，不需計時器。）

- [ ] **Step 5: 測試 + build**

Run: `npx jest && npm run build`
Expected: jest 全 PASS；webpack build 成功無 TS 錯誤。

- [ ] **Step 6: Commit**

```bash
git add gdbgui/src/js/CallGraph.tsx gdbgui/src/js/Threads.tsx
git commit -m "feat(callgraph): render return values on returned nodes and edges"
```

---

### Task 4: 點節點跳到原始碼行（F4-1）

**Files:**
- Modify: `gdbgui/src/js/CallGraph.tsx`（node div，Task 3 之後約 217 行起）

**Interfaces:**
- Consumes: `window.gdbgui_navigate_to_error(line: number, col: number)`（`SourceCode.tsx:242-247` — reveal + 游標 + focus；名稱歷史遺留，行為就是跳行）。

- [ ] **Step 1: node div 加 onClick**

節點 div 屬性追加：

```tsx
                                    onClick={() => {
                                        const line = Number(node.line);
                                        const nav = (window as any).gdbgui_navigate_to_error;
                                        if (line > 0 && typeof nav === "function") nav(line, 1);
                                    }}
```

並在該 div 的 style 物件加 `cursor: "pointer"`。

- [ ] **Step 2: 測試 + build**

Run: `npx jest && npm run build`
Expected: 全 PASS、build 成功。

- [ ] **Step 3: Commit**

```bash
git add gdbgui/src/js/CallGraph.tsx
git commit -m "feat(callgraph): click a node to jump to its source line"
```

---

### Task 5: 教案 #1 #2 + result 約定文件化

**Files:**
- Create: `examples/cpp/rec_sum.cpp`
- Create: `examples/cpp/rec_sum_tail.cpp`
- Modify: `AUTHORING_GUIDE.md`（追加 result 約定小節；注意工作樹已有未 commit 的使用者修改 — 只 append，勿動既有內容，commit 時只 add 自己的 hunk 或先與使用者確認）
- Modify: `gdbgui/src/js/LessonGenPanel.tsx`（生成 prompt 補約定一行；先 `grep -n "prompt" gdbgui/src/js/LessonGenPanel.tsx` 找到 system prompt 字串）

**Interfaces:**
- Consumes: `//@` 註解語法（`AUTHORING_GUIDE.md` §1.1）；F1 的 result 約定。

- [ ] **Step 1: 建立 rec_sum.cpp（線性遞迴，值逐層上冒）**

```cpp
// 教案 #1：線性遞迴 — sum(4) = 4 + 3 + 2 + 1
// 約定：回傳值先存入 result 再 return，呼叫樹會顯示 ⇒ 值。
#include <iostream>

int sum(int n) {                       //@ @guide 進入 sum(n={n}) @tts 呼叫 sum，n 是 {n} @layout sidebar:45 open:callgraph
    if (n <= 1) {
        int result = 1;                //@ @guide [base case] n=1，答案是 1 @tts 到底了，這一層直接回傳 1
        return result;
    }
    int rest = sum(n - 1);             //@ @guide 先算 sum({n}-1)，這一層等它 @tts 這一層先暫停，往下呼叫 sum n 減 1
    int result = n + rest;             //@ @guide result = {n} + {rest} = {result} @tts 下層算完了，{n} 加 {rest} 得到 {result}
    return result;                     //@ @tts 把 {result} 交回給上一層
}

int main() {
    int total = sum(4);                //@ @guide 從 main 呼叫 sum(4) @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total}
    return 0;
}
```

- [ ] **Step 2: 建立 rec_sum_tail.cpp（尾遞迴對照組，同值直通到頂）**

```cpp
// 教案 #2：尾遞迴 — 和教案 #1 對照：答案在「遞」的路上就算好，
// 「歸」的路上同一個值直通到頂（每層 ⇒ 10）。
#include <iostream>

int sumTail(int n, int acc) {          //@ @guide 進入 sumTail(n={n}, acc={acc}) @tts 呼叫 sumTail，累加器已經是 {acc} @layout sidebar:45 open:callgraph
    if (n == 0) {
        int result = acc;              //@ @guide [base case] 答案就是 acc={acc} @tts 到底了，答案早就算好，是 {acc}
        return result;
    }
    int result = sumTail(n - 1, acc + n); //@ @guide 把 {n} 先加進 acc 再往下 @tts 先把 {n} 加進累加器，答案會原封不動傳回來
    return result;                     //@ @tts 下層的答案 {result} 直接轉交，不再計算
}

int main() {
    int total = sumTail(4, 0);         //@ @guide 對照教案 #1：這次答案在下坡路上算 @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total}
    return 0;
}
```

- [ ] **Step 3: 編譯驗證兩個教案**

Run: `g++ -g -O0 examples/cpp/rec_sum.cpp -o /tmp/rec_sum && /tmp/rec_sum`
Expected: 輸出 `10`。
Run: `g++ -g -O0 examples/cpp/rec_sum_tail.cpp -o /tmp/rec_sum_tail && /tmp/rec_sum_tail`
Expected: 輸出 `10`。
（Windows 環境用 `$env:TEMP` 路徑取代 /tmp。）

- [ ] **Step 4: AUTHORING_GUIDE.md 追加 result 約定**

在第一章末尾（`## 二、` 之前）追加：

```markdown
### 1.2 回傳值約定（`result` 變數）

呼叫樹要顯示「這一層算出什麼」（節點上的綠色 `⇒ 值`），教案函式必須把回傳值
先存進名為 `result` 的區域變數再 return：

    int result = n + rest;
    return result;      // 呼叫樹返回時顯示 ⇒ 值

直接 `return n + rest;` 不會壞，只是該節點返回時沒有 `⇒ 值`（僅變淡）。
AI 生成遞迴教案時一律採用此寫法。
```

- [ ] **Step 5: LessonGenPanel prompt 補約定**

先 `grep -n "遞迴\|prompt\|system" gdbgui/src/js/LessonGenPanel.tsx` 找到生成 prompt 的字串常數，在其教案撰寫規則段落追加一行（措辭配合該 prompt 既有格式）：

```
函式的回傳值必須先存入名為 result 的區域變數再 return（呼叫樹據此顯示回傳值）。
```

- [ ] **Step 6: 測試 + commit**

Run: `npx jest`
Expected: 全 PASS。

```bash
git add examples/cpp/rec_sum.cpp examples/cpp/rec_sum_tail.cpp AUTHORING_GUIDE.md gdbgui/src/js/LessonGenPanel.tsx
git commit -m "feat(lessons): rec_sum + rec_sum_tail lessons; document result convention"
```

（若 `AUTHORING_GUIDE.md` 內有使用者未 commit 的其他修改，改用 `git add -p AUTHORING_GUIDE.md` 只 stage 本任務的 hunk。）

---

### Task 6: 端到端手動驗收（Docker）

**Files:** 無程式修改。

**Interfaces:**
- Consumes: 全部前置任務；memory 的部署程序 — live app 在 :5000，容器是 `cppcodevisualizer-gdbgui`。

- [ ] **Step 1: 重建部署**

Run: `docker compose down; docker compose up -d --build`
Expected: 容器啟動，:5000 可開。

- [ ] **Step 2: 驗收 checklist（載入 rec_sum.cpp 逐步執行）**

- 逐步走到 `sum(1)` 返回：該節點變淡且顯示綠色 `⇒ 1`，父邊出現 `↑1`，再步進一次 `↑1` 消失、`⇒ 1` 保留。
- 走完全程：四個 sum 節點各顯示 `⇒ 1 / ⇒ 3 / ⇒ 6 / ⇒ 10`。
- 點任一節點：Monaco 跳到該行且游標落點正確。
- 載入 rec_sum_tail.cpp 走完：每層節點都顯示 `⇒ 10`（對照效果成立）。
- 載入不含 result 變數的舊教案（examples/cpp/hello.cpp 或既有 BST 教案）：行為與改動前相同，返回節點僅變淡。

- [ ] **Step 3: 若驗收全過，回報完成**

驗收發現的問題開回 Task 1–5 修復，不在此任務內寫新功能。
