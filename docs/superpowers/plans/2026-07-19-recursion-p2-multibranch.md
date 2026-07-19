# P2 — 多分支遞迴（配對、呼叫點、深度、fib 教案）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 樹狀遞迴的教學重點可視化：重複子問題配對（×N 徽章 + hover 同伴 + 停駐自動亮）、邊上呼叫點標示、目前節點顯示遞迴深度，交付 fib(4) 全自動教案。

**Architecture:** 配對與深度完全在 CallGraph render 現算（無新狀態儲存，僅一個 `hoverKey` UI state）；呼叫點資訊在 `ingestStack` 建節點時從父 frame 快照取得（父停駐行 = 呼叫行）。教案採拆行寫法（每個遞迴呼叫獨立成行）。

**Tech Stack:** TypeScript + React、Jest。無新依賴。

**Spec:** `docs/superpowers/specs/2026-07-19-recursion-coverage-roadmap-design.md`（F2、F4-2、F4-3 修正版；「修正紀錄」節有 P1 實測守則）

## Global Constraints

- 顏色 token：警示紅 `#DC5B5B`、琥珀 `var(--highlight)`、靛藍 `var(--accent)`、綠 `#3AA76D`、淡墨 `var(--ink-faint)`。
- 教學場景 ≤ ~30 呼叫；配對索引每次 render 現算即可。
- e2e 合約屬性保留並新增：node div 加 `data-argkey`。
- 無 `result`／非教案程式碼行為完全不變。
- 教案硬規則（全部）：全自動播放（§1.3）；`result` 函式最外層宣告一次；賦值行不自引用 `{變數}`；main 呼叫行 `@2` 門檻分出發/返回；多分支呼叫行訊息方向中性。
- 不新增 npm 依賴；commit conventional style；pre-commit hook 跑 jest。

---

### Task 1: callTree — 呼叫點欄位

**Files:**
- Modify: `gdbgui/src/js/callTree.ts`
- Test: `gdbgui/src/js/tests/callTree.jest.ts`（追加 describe）

**Interfaces:**
- Produces: `CallNode` 增加 `callSiteLine?: string | number`、`callSiteAddr?: string`（建立時定格，之後不更新；root 節點兩者 undefined）。

- [ ] **Step 1: 追加失敗測試**（檔尾）

```ts
describe("call-site fields", () => {
    const f = (func: string, addr: string, line: number, args: Frame["args"] = []): Frame =>
        ({ func, addr, line, args });

    test("child node captures parent's line/addr at creation; root has none", () => {
        const tree = createCallTree();
        const r = ingestStack(tree, [f("fib", "0x30", 5), f("main", "0x10", 16)]);
        const root = r.nodes.find(n => n.func === "main")!;
        const child = r.nodes.find(n => n.func === "fib")!;
        expect(root.callSiteLine).toBeUndefined();
        expect(root.callSiteAddr).toBeUndefined();
        expect(child.callSiteLine).toBe(16);
        expect(child.callSiteAddr).toBe("0x10");
    });

    test("same-line siblings share callSiteLine but differ in callSiteAddr", () => {
        const tree = createCallTree();
        // fib(3) at line 11 calls fib(2) [ret addr 0xa1]
        ingestStack(tree, [f("fib", "0x30", 5, [{ name: "n", value: "2" }]), f("fib", "0xa1", 11), f("main", "0x10", 16)]);
        ingestStack(tree, [f("fib", "0xa1", 11), f("main", "0x10", 16)]);
        // same source line 11, second call instruction [ret addr 0xa2]
        const r = ingestStack(tree, [f("fib", "0x30", 5, [{ name: "n", value: "1" }]), f("fib", "0xa2", 11), f("main", "0x10", 16)]);
        const sibs = r.nodes.filter(n => n.callSiteLine === 11 && n.func === "fib" && n.parentInvId != null && n.callSiteAddr !== "0x10");
        expect(sibs.length).toBe(2);
        expect(new Set(sibs.map(s => s.callSiteAddr))).toEqual(new Set(["0xa1", "0xa2"]));
    });

    test("call-site fields do not change on later snapshots of the same invocation", () => {
        const tree = createCallTree();
        ingestStack(tree, [f("g", "0x30", 5), f("main", "0x10", 16)]);
        const r = ingestStack(tree, [f("g", "0x30", 6), f("main", "0x10", 16)]);
        expect(r.nodes.find(n => n.func === "g")!.callSiteLine).toBe(16);
    });
});
```

- [ ] **Step 2:** Run `npx jest callTree -t "call-site"` — Expected: FAIL（欄位 undefined 斷言不符）。

- [ ] **Step 3: 實作** — `CallNode` 型別加：

```ts
    callSiteLine?: string | number;  // 父 frame 建立當下停駐的行 = 呼叫行
    callSiteAddr?: string;           // 呼叫指令的返回位址（同行多呼叫的排序鍵）
```

`ingestStack` 建立節點的物件字面值（`returned: false,` 之後）加：

```ts
                callSiteLine: i < L - 1 ? stack[i + 1].line : undefined,
                callSiteAddr: i < L - 1 ? stack[i + 1].addr : undefined,
```

- [ ] **Step 4:** Run `npx jest callTree` — Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/callTree.ts gdbgui/src/js/tests/callTree.jest.ts
git commit -m "feat(callgraph): record call-site line/addr on each invocation"
```

---

### Task 2: CallGraph — 配對（×N/hover/停駐亮）+ 深度上樹

**Files:**
- Modify: `gdbgui/src/js/CallGraph.tsx`

**Interfaces:**
- Consumes: `CallNode.args`、`gv.__active_path`。
- Produces: node div 新增 `data-argkey`；模組層函式 `argKey(node)`；`CallGraphState` 增 `hoverKey: string | null`。

- [ ] **Step 1: argKey 與 state**

模組層（`CUSTOM_COLORS` 之後）加：

```ts
// Same function + same argument values = the same subproblem.
function argKey(node: CallNode): string {
    return `${node.func}(${(node.args || []).map(a => String(a.value)).join(",")})`;
}
```

`CallGraphState` 加 `hoverKey: string | null;`；constructor 初始 state 加 `hoverKey: null`（注意 `store.connectComponentState` 只接 store 鍵，`hoverKey` 純本地 state，放進初始物件即可）。

- [ ] **Step 2: render 內預計算**（`const posById = ...` 之後、edges 渲染之前）

```ts
        // Repeated-subproblem index and recursion depth — recomputed per render (≤30 nodes).
        const keyCounts = new Map<string, number>();
        placed.forEach(p => keyCounts.set(argKey(p), (keyCounts.get(argKey(p)) || 0) + 1));
        const currentKey = activeNode ? argKey(activeNode) : null;
        const recDepth = activeNode
            ? ((gv.__active_path as number[]) || []).filter(id => posById.get(id)?.func === activeNode.func).length
            : 0;
```

（`activeNode` 已存在於 render 上方的 locals 區段；若其宣告位於此段之後，把該宣告上移到此段之前，不改其內容。）

- [ ] **Step 3: 節點 map 內的配對判定**（`const { lines, color, ret } = ...` 之後）

```ts
                            const k = argKey(node);
                            const twins = (keyCounts.get(k) || 0) > 1;
                            const isTwin = this.state.hoverKey === k && twins;
                            const isRepeatHit = twins && !isCurrent && node.returned && currentKey === k;
```

- [ ] **Step 4: div 屬性與樣式**

div 屬性追加（`data-ret` 之後）：

```tsx
                                    data-argkey={k}
                                    onMouseEnter={() => this.setState({ hoverKey: k })}
                                    onMouseLeave={() => this.setState({ hoverKey: null })}
```

style 物件在 `...style,` **之後**追加（讓它蓋過各狀態樣式）：

```tsx
                                        ...(isTwin ? { outline: "2px dashed var(--highlight)", outlineOffset: 2 } : {}),
                                        ...(isRepeatHit ? { outline: "2px solid #DC5B5B", outlineOffset: 2, boxShadow: "0 0 6px rgba(220,91,91,0.5)" } : {}),
```

- [ ] **Step 5: ×N 徽章與深度小字**（`{ret && (...)}` 區塊之後）

```tsx
                                    {twins && (
                                        <span style={{
                                            position: "absolute", top: 1, right: 3, background: "#DC5B5B",
                                            color: "#fff", fontSize: 10, fontWeight: 700,
                                            borderRadius: 8, padding: "0 5px", lineHeight: "15px",
                                        }}>
                                            ×{keyCounts.get(k)}
                                        </span>
                                    )}
                                    {isCurrent && recDepth > 1 && (
                                        <span style={{ fontSize: "0.78em", color: "var(--ink-soft)" }}>
                                            第 {recDepth} 層
                                        </span>
                                    )}
```

（徽章放**節點內**右上角 — 外掛負座標會被容器 `overflow: hidden` 裁掉。深度只在 ≥2 層時顯示，main／第一層不標。）

- [ ] **Step 6:** Run `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: 191 PASS、build 成功。

- [ ] **Step 7: Commit**

```bash
git add gdbgui/src/js/CallGraph.tsx
git commit -m "feat(callgraph): repeated-subproblem pairing (badge/hover/dwell) and depth on current node"
```

---

### Task 3: CallGraph — 邊上呼叫點標籤

**Files:**
- Modify: `gdbgui/src/js/CallGraph.tsx`

**Interfaces:**
- Consumes: Task 1 的 `callSiteLine`/`callSiteAddr`。

- [ ] **Step 1: 預計算標籤**（Task 2 Step 2 的區塊之後）

```ts
        // Call-site labels: L<line>, with ①② ordinals when siblings share a line.
        const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];
        const siteLabels = new Map<string, string>();
        {
            const kidsByParent = new Map<number, Placed[]>();
            placed.forEach(p => {
                if (p.parentInvId == null) return;
                if (!kidsByParent.has(p.parentInvId)) kidsByParent.set(p.parentInvId, []);
                kidsByParent.get(p.parentInvId)!.push(p);
            });
            kidsByParent.forEach(children => {
                const byLine = new Map<string, Placed[]>();
                children.forEach(c => {
                    if (c.callSiteLine == null || c.callSiteLine === "") return;
                    const L = String(c.callSiteLine);
                    if (!byLine.has(L)) byLine.set(L, []);
                    byLine.get(L)!.push(c);
                });
                byLine.forEach((sibs, L) => {
                    sibs.sort((a, b) =>
                        parseInt(String(a.callSiteAddr ?? "0"), 16) - parseInt(String(b.callSiteAddr ?? "0"), 16));
                    sibs.forEach((c, i) => {
                        siteLabels.set(`${c.parentInvId}->${c.invId}`,
                            sibs.length > 1 ? `L${L}${CIRCLED[i] ?? i + 1}` : `L${L}`);
                    });
                });
            });
        }
```

- [ ] **Step 2: edges.map 渲染標籤** — 現有回傳的 `<line ... />` 改包成 `<g key={e.id}>`（`key` 從 line 移到 g），line 保持原樣（移除其 key 屬性），之後加：

```tsx
                                        {siteLabels.get(e.id) && (
                                            <text
                                                x={x1 + (x2 - x1) * 0.35 + 5}
                                                y={y1 + (y2 - y1) * 0.35}
                                                fill="var(--ink-faint)" fontSize={10}
                                                fontFamily="var(--font-mono)"
                                            >
                                                {siteLabels.get(e.id)}
                                            </text>
                                        )}
```

- [ ] **Step 3:** Run `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: 全 PASS、build 成功。

- [ ] **Step 4: Commit**

```bash
git add gdbgui/src/js/CallGraph.tsx
git commit -m "feat(callgraph): call-site labels on edges with same-line ordinals"
```

---

### Task 4: fib(4) 教案 + §1.4 守則 + prompt 規則 7

**Files:**
- Create: `examples/cpp/rec_fib.cpp`
- Create: `examples/cpp/rec_fib.gdbgui.json`（由腳本產生）
- Modify: `AUTHORING_GUIDE.md`（§1.3 之後插入 §1.4；**工作樹有使用者未 commit 修改 — 該檔只改工作樹、不 stage、不 commit**，與既有 §1.2/§1.3 同狀態）
- Modify: `gdbgui/server/lesson_gen.py`（`_SYSTEM_TEMPLATE` 加規則 7）

- [ ] **Step 1: rec_fib.cpp**（遵守全部硬規則：入口斷點、單一 result、方向中性呼叫行、main @2 門檻、賦值行不自引用）

```cpp
// 教案 #3：樹狀遞迴 — fib(4)（全自動播放）
// 重點：一個問題分成兩個子問題；相同的子問題會被重複計算（注意 ×N 徽章）。
#include <iostream>

int fib(int n) {                       //@ @guide 進入 fib(n={n}) @tts [next] 呼叫 fib，這一層的 n 是 {n} @layout sidebar:45 open:callgraph
    int result;
    if (n <= 1) {                      //@ @tts [next] 判斷 {n} 是不是 0 或 1
        result = n;                    //@ @guide [base case] fib({n}) = {n} @tts [next] 到底了，fib {n} 就是 {n}
        return result;                 //@ @tts [next] 把 {result} 交回上一層
    }
    int a = fib(n - 1);                //@ @guide 左子問題 fib({n}-1) @tts [step-in] 處理左邊的子問題 fib {n} 減 1
    int b = fib(n - 2);                //@ @guide 右子問題 fib({n}-2)，左邊已得 {a} @tts [step-in] 左邊是 {a}，處理右邊的子問題 fib {n} 減 2
    result = a + b;                    //@ @guide result = {a} + {b} @tts [next] 左邊 {a} 加右邊 {b}
    return result;                     //@ @guide 得到 {result} @tts [next] 得到 {result}，交回上一層
}                                      //@ @tts [next] 這一層結束，沿呼叫樹往上歸
int main() {
    int total = fib(4);                //@ @guide 從 main 呼叫 fib(4) @tts [next] 從 main 出發，呼叫 fib(4) | @2 [next] 遞迴全部結束，回到 main @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total} @tts [next] 印出最終答案 {total}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
```

- [ ] **Step 2: 產生 bundle** — 把 scratchpad 的 `make-bundles.js` 加一行 `makeBundle("rec_fib.cpp", "int fib(int n)");` 後執行（或等價地手動依 v2 格式產生，斷點 = `int fib(int n)` 所在行）。
Run: `node <scratchpad>/make-bundles.js` → Expected: `rec_fib.gdbgui.json: breakpoint line 5, ... round-trip OK`。

- [ ] **Step 3: 編譯驗證** — Run: `g++ -g -O0 examples/cpp/rec_fib.cpp -o $TEMP/rf && $TEMP/rf` — Expected: 輸出 `3`。

- [ ] **Step 4: AUTHORING_GUIDE §1.4**（§1.3 結尾「任何一個停駐點缺少自動播放指令即為不合格。」之後插入）

```markdown
### 1.4 多分支（樹狀）遞迴

- **每個遞迴呼叫獨立成行**，存入具名變數：`int a = fib(n - 1);`、`int b = fib(n - 2);`。
  不要寫 `return fib(n-1) + fib(n-2);` — 單行雙呼叫無法逐呼叫註解與自動播放。
- **斷點設在遞迴函式入口行**。自動播放的「下降」靠它：呼叫行不論寫 `[next]` 或
  `[step-in]`，入口斷點都會攔住進入下一層。
- 呼叫行一律用 `[step-in]`（回程再次停駐該行時，呼叫已完成，step 等同 next，安全）。
- **呼叫行的訊息必須方向中性**：樹狀遞迴的呼叫行「去程／回程」交錯出現、無法用
  `@N` 門檻區分，訊息要寫成兩種情境都通（例：「處理左邊的子問題」），
  不要寫「往下呼叫」或「回來了」這種單向敘述。
```

- [ ] **Step 5: lesson_gen 規則 7**（規則 6 之後）

```python
    "7. 多分支遞迴：每個遞迴呼叫獨立成行、存入具名變數（不得單行多個遞迴呼叫）；"
    "呼叫行一律用 [step-in]；呼叫行的訊息必須方向中性（去程與回程都說得通）。\n"
```

- [ ] **Step 6:** Run `python -m pytest tests/test_lesson_gen.py -q && npx jest` — Expected: 全 PASS。

- [ ] **Step 7: Commit**（不含 AUTHORING_GUIDE.md）

```bash
git add examples/cpp/rec_fib.cpp examples/cpp/rec_fib.gdbgui.json gdbgui/server/lesson_gen.py
git commit -m "feat(lessons): fib(4) tree-recursion lesson with split call lines; prompt rule 7"
```

---

### Task 5: 部署 + 驗收（controller 執行）

- [ ] Run `docker compose down; docker compose up -d --build`；確認 HTTP 200、容器內有 rec_fib。
- [ ] 使用者驗收 checklist（Import `rec_fib.gdbgui.json` → Run → 全自動播放）：
  - 樹長成二元樹（9 節點），`fib(2)` ×2、`fib(1)` ×3、`fib(0)` ×2 徽章。
  - 播放中段：執行停在第二個 `fib(2)` 子樹時，第一個 `fib(2)`（已返回）紅框亮起。
  - hover 任一 `fib(1)`：三個 `fib(1)` 一起虛線亮。
  - 邊上有 `L10`／`L11` 標籤（拆行後各自一行，無 ①②；①② 留待進階單行教案）。
  - 目前節點顯示「第 N 層」；九個節點播完各有 `⇒ 值`（1,0,1,1,2,1,0,1,3）。
  - 全程免手動、TTS 無亂碼、`[continue]` 收尾跑完。
