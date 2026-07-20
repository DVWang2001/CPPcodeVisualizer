# P3 — 幽靈預跑（Ghost Pre-run）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run 時後端隱形預跑一次拿完整呼叫樹，前端以最終樹形固定佈局：節點出現時直接落在最終位置（永不平移），未實現節點以淡虛線空框預告。

**Architecture:** 新後端 endpoint `/api/prerun_calltree`（只讀 session、gdb --batch + Python 腳本、jail + timeout）回傳堆疊快照序列；前端 `ghostTree.ts` 用既有 `ingestStack` 重建幽靈樹 + 抽出的共用 `layoutTree` 算最終佈局；CallGraph 以 sig 對號入座，匹配率過低則整體回退 live 佈局。

**Tech Stack:** Flask Blueprint（`gdbgui/server/http_routes.py` 慣例）、gdb Python API、TypeScript/React、Jest、pytest。無新依賴。

**Spec:** `docs/superpowers/specs/2026-07-19-recursion-coverage-roadmap-design.md` §F7

## Global Constraints

- **安全（最高優先）**：endpoint 完全不使用 client 提供的任何參數 — binary/原始檔/輸入/wrapper 一律取自 session（`uploaded_binary`、`real_src_path`、`exec_wrapper`、`uploaded_input`，見 http_routes.py:541/468/549/570）；驗證 binary 位於 upload_folder 內且屬於本 session prefix；`@authenticate` 裝飾；subprocess timeout ≤ 15s；快照上限 300、stdout 上限 2MB；錯誤回應不回顯任何伺服器路徑。
- 預跑失敗的一切情況（timeout、gdb 錯誤、無 binary、程式等 stdin）→ 回 `{ok:false}`，前端靜默回退，**現行為完全不受影響**。
- Sig 位址正規化不得改變既有樹重建行為（jest 全綠）。
- e2e 合約屬性：幽靈框帶 `data-ghost="1"`。
- 不新增 npm/pip 依賴；conventional commits；pre-commit hook 跑 jest。

---

### Task 1: 後端 `/api/prerun_calltree`（security-sensitive）

**Files:**
- Create: `gdbgui/server/prerun.py`（純函式：gdb 腳本產生、輸出解析 — 可單元測試）
- Modify: `gdbgui/server/http_routes.py`（新增 route，仿 `/api/generate_lesson` 於 :1004 的 Blueprint + `@authenticate` 慣例）
- Test: `tests/test_prerun.py`

**Interfaces:**
- Produces: `POST /api/prerun_calltree`（無 request body 參數）→
  `{"ok": true, "snapshots": [[{"func","addr","line","args":[{"name","value"}]}...（innermost first）], ...]}`
  或 `{"ok": false, "reason": "<分類字串，無路徑>"}`。
- `prerun.py` 純函式：
  - `build_gdb_script(src_basename: str, exec_wrapper: str | None, input_path: str | None, max_snapshots: int = 300) -> str`
  - `parse_prerun_output(stdout: str) -> list | None`（抓 `PRERUN_JSON_BEGIN/END` 哨兵之間的 JSON；缺哨兵/壞 JSON → None）

- [ ] **Step 1: 失敗測試**（`tests/test_prerun.py`，仿 `tests/test_lesson_gen.py` 的純函式測試風格）

```python
from gdbgui.server.prerun import build_gdb_script, parse_prerun_output

def test_script_contains_rbreak_and_sentinels():
    s = build_gdb_script("lesson.cpp", "/jails/x/run.sh", None)
    assert "rbreak lesson.cpp:." in s
    assert "PRERUN_JSON_BEGIN" in s and "PRERUN_JSON_END" in s
    assert "set exec-wrapper /jails/x/run.sh" in s

def test_script_feeds_input_when_present():
    s = build_gdb_script("a.cpp", None, "/uploads/p_input.in")
    assert "run < /uploads/p_input.in" in s

def test_script_plain_run_without_input():
    s = build_gdb_script("a.cpp", None, None)
    assert 'gdb.execute("run"' in s or "\nrun\n" in s

def test_parse_extracts_json_between_sentinels():
    out = "noise\nPRERUN_JSON_BEGIN\n[[{\"func\":\"main\",\"addr\":\"0x1\",\"line\":16,\"args\":[]}]]\nPRERUN_JSON_END\ntail"
    snaps = parse_prerun_output(out)
    assert snaps and snaps[0][0]["func"] == "main"

def test_parse_returns_none_on_missing_sentinel_or_bad_json():
    assert parse_prerun_output("no sentinels") is None
    assert parse_prerun_output("PRERUN_JSON_BEGIN\n{oops\nPRERUN_JSON_END") is None
```

- [ ] **Step 2:** `python -m pytest tests/test_prerun.py -q` — Expected: FAIL（module 不存在）。

- [ ] **Step 3: 實作 prerun.py**

`build_gdb_script` 回傳一份 **gdb Python** 腳本字串（將由 `gdb --batch -nx -x <file> <binary>` 執行）。腳本邏輯（實作者可微調細節，但下列行為必須都在）：

```python
import gdb, json
gdb.execute("set pagination off"); gdb.execute("set confirm off")
# exec_wrapper 若提供： gdb.execute("set exec-wrapper <wrapper>")
gdb.execute("rbreak <src_basename>:.")   # 使用者原始檔內全部函式
snaps = []
try:
    gdb.execute("run" 或 "run < <input_path>", to_string=True)
    while len(snaps) < MAX:
        inf = gdb.selected_inferior()
        if not inf or not inf.threads(): break
        frames = []
        f = gdb.newest_frame()
        while f is not None:
            args = []
            try:
                blk = f.block()
                for sym in blk:
                    if sym.is_argument:
                        try: args.append({"name": sym.name, "value": str(f.read_var(sym))})
                        except Exception: pass
            except Exception: pass
            sal = f.find_sal()
            frames.append({"func": f.name() or "??",
                           "addr": hex(f.pc()),
                           "line": (sal.line if sal and sal.line else ""),
                           "args": args})
            f = f.older()
        snaps.append(frames)
        try: gdb.execute("continue", to_string=True)
        except gdb.error: break
except gdb.error:
    pass
print("PRERUN_JSON_BEGIN"); print(json.dumps(snaps)); print("PRERUN_JSON_END")
```

`parse_prerun_output`：以哨兵切出中段、`json.loads`、失敗回 None；另做基本形狀驗證（list of list of dict 且 dict 有 func/addr）。

- [ ] **Step 4: route**（http_routes.py，Blueprint + `@authenticate`）

```python
@blueprint.route("/api/prerun_calltree", methods=["POST"])
@authenticate
def prerun_calltree():
    binary = session.get("uploaded_binary")
    src = session.get("real_src_path")
    upload_dir = current_app.config.get("upload_folder") or os.path.join(current_app.root_path, "uploads")
    prefix = session.get("uploaded_prefix", "")
    # 驗證：binary 存在、realpath 在 upload_dir 內、檔名以本 session prefix 開頭
    if (not binary or not src or not prefix
            or not os.path.isfile(binary)
            or not os.path.realpath(binary).startswith(os.path.realpath(upload_dir) + os.sep)
            or not os.path.basename(binary).startswith(prefix + "_")):
        return jsonify({"ok": False, "reason": "no_binary"}), 200
    script = build_gdb_script(os.path.basename(src),
                              session.get("exec_wrapper"),
                              session.get("uploaded_input") if os.path.isfile(session.get("uploaded_input") or "") else None)
    # NamedTemporaryFile 寫入 script → subprocess.run([gdb 執行檔, "--batch", "-nx", "-x", tmp, binary],
    #   capture_output=True, timeout=15, text=True)；gdb 執行檔沿用專案現有取得方式（搜 "gdb" 常數/設定）
    # TimeoutExpired / 非零 return / stdout > 2MB → {"ok": False, "reason": "prerun_failed"}
    snaps = parse_prerun_output(proc.stdout[:2_000_000])
    if snaps is None:
        return jsonify({"ok": False, "reason": "parse_failed"}), 200
    return jsonify({"ok": True, "snapshots": snaps})
```

- [ ] **Step 5:** `python -m pytest tests/test_prerun.py tests/test_lesson_gen.py -q` — Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add gdbgui/server/prerun.py gdbgui/server/http_routes.py tests/test_prerun.py
git commit -m "feat(prerun): session-scoped gdb batch pre-run endpoint returning call-tree snapshots"
```

---

### Task 2: sig 位址正規化 + layoutTree 抽出

**Files:**
- Modify: `gdbgui/src/js/callTree.ts`
- Create: `gdbgui/src/js/callGraphLayout.ts`
- Modify: `gdbgui/src/js/CallGraph.tsx`（layout 改用共用函式）
- Test: `gdbgui/src/js/tests/callTree.jest.ts`、`gdbgui/src/js/tests/callGraphLayout.jest.ts`

**Interfaces:**
- Produces:
  - `normalizeAddr(addr?: string): string | undefined` — 小寫、`0x` 後去前導零（`"0x0000555A"` → `"0x555a"`；非 `0x` 開頭原樣小寫）。sig 組字串時對 callSite 套用；`CallNode.callSiteAddr` 儲存值**照舊不動**（排序用 parseInt 不受影響）。
  - `layoutTree(nodes: CallNode[]): { placed: Array<CallNode & {x:number;y:number}>; width: number; height: number }` — 從 CallGraph.layout **原樣搬出**（含 NODE_W/NODE_H/GAP 常數一併搬到新檔並 export），CallGraph 改 import 使用，行為零改變。

- [ ] **Step 1: 失敗測試** — callTree.jest.ts 追加：

```ts
describe("normalizeAddr in sig", () => {
    const f = (func: string, addr: string, line: number): Frame => ({ func, addr, line, args: [] });
    test("MI-padded and python-hex addrs produce the same invocation identity", () => {
        const t1 = createCallTree();
        ingestStack(t1, [f("fib", "0x0000555555550a10", 5), f("main", "0x0000555555550b20", 16)]);
        const t2 = createCallTree();
        ingestStack(t2, [f("fib", "0x555555550a10", 5), f("main", "0x555555550b20", 16)]);
        const sig1 = [...t1.bySig.keys()].sort();
        const sig2 = [...t2.bySig.keys()].sort();
        expect(sig1).toEqual(sig2);
    });
});
```

`callGraphLayout.jest.ts` 新檔：

```ts
import { layoutTree } from "../callGraphLayout";
import type { CallNode } from "../callTree";

const n = (invId: number, parentInvId: number | null): CallNode =>
    ({ invId, sig: String(invId), func: "f", args: [], line: "", parentInvId, returned: false });

test("linear chain lays out as one vertical column", () => {
    const { placed } = layoutTree([n(1, null), n(2, 1), n(3, 2)]);
    const xs = new Set(placed.map(p => p.x));
    expect(xs.size).toBe(1);
    expect(placed[0].y).toBeLessThan(placed[2].y);
});

test("two children spread horizontally, parent centered", () => {
    const { placed } = layoutTree([n(1, null), n(2, 1), n(3, 1)]);
    const p = placed.find(q => q.invId === 1)!;
    const a = placed.find(q => q.invId === 2)!;
    const b = placed.find(q => q.invId === 3)!;
    expect(a.x).not.toBe(b.x);
    expect(p.x).toBeCloseTo((a.x + b.x) / 2, 5);
});
```

- [ ] **Step 2:** `npx jest callGraphLayout callTree` — Expected: FAIL。

- [ ] **Step 3: 實作** — callTree.ts 加：

```ts
/** MI 給零填充位址、gdb Python 給短 hex — 身分計算前先正規化。 */
export function normalizeAddr(addr?: string): string | undefined {
    if (!addr) return undefined;
    const a = String(addr).toLowerCase();
    return a.startsWith("0x") ? "0x" + (a.slice(2).replace(/^0+/, "") || "0") : a;
}
```

`ingestStack` 的 sig 組合處改為：

```ts
            const callSite = normalizeAddr(parent.addr) ?? parent.line ?? "";
```

`callGraphLayout.ts`：把 CallGraph.tsx 的 `NODE_W/NODE_H/GAP_X/GAP_Y/COL/ROW/PAD` 常數與 `layout` 方法內容原樣搬出成 `layoutTree(nodes)`（`Placed` 型別一併移入並 export）；CallGraph.tsx 刪除自己的 layout 方法與常數，改 `import { layoutTree, NODE_W, NODE_H } from "./callGraphLayout";`（render 內 `this.layout(nodes)` → `layoutTree(nodes)`；svg/節點用到的 NODE_W/NODE_H 取自 import）。

- [ ] **Step 4:** `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: 全 PASS + build 成功。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/callTree.ts gdbgui/src/js/callGraphLayout.ts gdbgui/src/js/CallGraph.tsx gdbgui/src/js/tests/callTree.jest.ts gdbgui/src/js/tests/callGraphLayout.jest.ts
git commit -m "refactor(callgraph): normalize addrs in sig; extract shared layoutTree"
```

---

### Task 3: ghostTree 建構模組

**Files:**
- Create: `gdbgui/src/js/ghostTree.ts`
- Test: `gdbgui/src/js/tests/ghostTree.jest.ts`

**Interfaces:**
- Consumes: `createCallTree`/`ingestStack`/`Frame`（callTree.ts）、`layoutTree`（callGraphLayout.ts）。
- Produces:

```ts
export type Ghost = {
    posBySig: Map<string, { x: number; y: number }>;
    nodes: CallNode[];        // 完整幽靈樹節點（含 sig/parentInvId）
    edges: { from: number; to: number; id: string }[];
    width: number;
    height: number;
};
export function buildGhostFromSnapshots(snapshots: Frame[][] | null | undefined): Ghost | null;
```

- [ ] **Step 1: 失敗測試**（ghostTree.jest.ts）

```ts
import { buildGhostFromSnapshots } from "../ghostTree";
import type { Frame } from "../callTree";

const f = (func: string, addr: string, line: number): Frame => ({ func, addr, line, args: [] });

test("null/empty snapshots give null", () => {
    expect(buildGhostFromSnapshots(null)).toBeNull();
    expect(buildGhostFromSnapshots([])).toBeNull();
});

test("fib-like snapshots build the complete tree with positions per sig", () => {
    const main = f("main", "0x100", 16);
    const snaps: Frame[][] = [
        [main],
        [f("fib", "0xa1", 5), main],                          // fib(4) via site a1
        [f("fib", "0xa1", 5), f("fib", "0xa1", 11), main],    // 左子
        [f("fib", "0xa2", 5), f("fib", "0xa1", 11), main],    // 右子（同層不同呼叫點）
        [f("fib", "0xa2", 5), main],                          // fib(4) 的右子
    ];
    const g = buildGhostFromSnapshots(snaps)!;
    expect(g).not.toBeNull();
    expect(g.nodes.length).toBe(5); // main + fib + 左 + 右 + 右2
    expect(g.posBySig.size).toBe(5);
    expect(g.width).toBeGreaterThan(0);
    // 每個節點的 sig 都有位置
    g.nodes.forEach(n => expect(g.posBySig.has(n.sig)).toBe(true));
});

test("malformed snapshot entries are skipped, not fatal", () => {
    const g = buildGhostFromSnapshots([[{ func: "main" } as any], "junk" as any]);
    expect(g === null || g.nodes.length >= 1).toBe(true);
});
```

- [ ] **Step 2:** `npx jest ghostTree` — Expected: FAIL。

- [ ] **Step 3: 實作**

```ts
import { createCallTree, ingestStack } from "./callTree";
import type { CallNode, Frame } from "./callTree";
import { layoutTree } from "./callGraphLayout";

export function buildGhostFromSnapshots(snapshots: Frame[][] | null | undefined): Ghost | null {
    if (!snapshots || !Array.isArray(snapshots) || snapshots.length === 0) return null;
    const tree = createCallTree();
    let last: ReturnType<typeof ingestStack> | null = null;
    for (const snap of snapshots) {
        if (!Array.isArray(snap) || snap.length === 0) continue;
        try { last = ingestStack(tree, snap); } catch { /* skip malformed */ }
    }
    if (!last || tree.bySig.size === 0) return null;
    const nodes = [...tree.bySig.values()];
    const { placed, width, height } = layoutTree(nodes);
    const posBySig = new Map<string, { x: number; y: number }>();
    placed.forEach(p => posBySig.set(p.sig, { x: p.x, y: p.y }));
    const edges = last.edges;
    return { posBySig, nodes, edges, width, height };
}
```

- [ ] **Step 4:** `npx jest` — Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/ghostTree.ts gdbgui/src/js/tests/ghostTree.jest.ts
git commit -m "feat(callgraph): build ghost tree + final layout from pre-run snapshots"
```

---

### Task 4: 前端接線 — 預跑觸發與幽靈渲染

**Files:**
- Modify: `gdbgui/src/js/GdbApi.tsx`（compile success callback，「Compilation successful」處 ~:477，在 `run_gdb_command` 之前發 fetch — 不阻塞）
- Modify: `gdbgui/src/js/CallGraph.tsx`

**Interfaces:**
- Consumes: Task 1 endpoint、Task 3 `buildGhostFromSnapshots`。
- Produces: global `gdbgui_global_variable.__ghost: Ghost | null`；幽靈框 DOM 帶 `data-ghost="1"`。

- [ ] **Step 1: GdbApi 觸發**（import `buildGhostFromSnapshots`；compile success callback 內、啟動命令前）

```ts
        // Ghost pre-run: fetch the complete call tree so layout never shifts (spec F7).
        const gv0 = (window as any).gdbgui_global_variable;
        if (gv0) gv0.__ghost = null;
        fetch("/api/prerun_calltree", { method: "POST", credentials: "same-origin" })
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const gv = (window as any).gdbgui_global_variable;
                if (!gv || !data || !data.ok) return;
                const ghost = buildGhostFromSnapshots(data.snapshots);
                if (ghost) {
                    gv.__ghost = ghost;
                    store.set("call_graph_updated", Date.now());
                }
            })
            .catch(() => { /* graceful fallback: live layout */ });
```

（若 `/api/generate_lesson` 的呼叫端有帶 csrf header/token，這裡照抄同樣的 header 慣例。）

- [ ] **Step 2: CallGraph 佈局對號入座**（render 內，取得 `placed` 之後）

```ts
        // Ghost layout override: pin live nodes to their final positions (spec F7).
        const ghost = gv.__ghost as (import("./ghostTree").Ghost | null);
        let liveW = width, liveH = height, usingGhost = false;
        if (ghost) {
            const matched = placed.filter(p => ghost.posBySig.has(p.sig)).length;
            if (matched / placed.length >= 0.6) {
                usingGhost = true;
                placed.forEach(p => {
                    const pos = ghost.posBySig.get(p.sig);
                    if (pos) { p.x = pos.x; p.y = pos.y; }
                });
                liveW = Math.max(width, ghost.width);
                liveH = Math.max(height, ghost.height);
            }
        }
```

（後續使用 `liveW`/`liveH` 取代原 `width`/`height` 於畫布尺寸；`posById` 在覆寫**之後**建立，確保邊線用新座標。）

- [ ] **Step 3: 幽靈占位渲染** — svg 內（edges 之前，墊底）加幽靈邊；節點層（`{placed.map(...)}` 之前）加幽靈框：

```tsx
                            {usingGhost && ghost!.edges.map(e => {
                                const gn = ghost!.nodes;
                                const a = gn.find(n => n.invId === e.from);
                                const b = gn.find(n => n.invId === e.to);
                                if (!a || !b) return null;
                                const liveHasBoth = placedSigSet.has(a.sig) && placedSigSet.has(b.sig);
                                if (liveHasBoth) return null;
                                const pa = ghost!.posBySig.get(a.sig)!, pb = ghost!.posBySig.get(b.sig)!;
                                return (
                                    <line key={`ghost-${e.id}`}
                                        x1={pa.x + NODE_W / 2} y1={pa.y + NODE_H}
                                        x2={pb.x + NODE_W / 2} y2={pb.y}
                                        stroke="var(--struct-border)" strokeWidth={1}
                                        strokeDasharray="4 4" opacity={0.35} />
                                );
                            })}
```

```tsx
                        {usingGhost && ghost!.nodes.filter(n => !placedSigSet.has(n.sig)).map(n => {
                            const pos = ghost!.posBySig.get(n.sig)!;
                            return (
                                <div key={`ghost-${n.sig}`} data-ghost="1"
                                    style={{
                                        position: "absolute", left: `${pos.x}px`, top: `${pos.y}px`,
                                        width: `${NODE_W}px`, minHeight: `${NODE_H}px`, boxSizing: "border-box",
                                        borderRadius: "8px", border: "1.5px dashed var(--struct-border)",
                                        opacity: 0.4, background: "transparent", pointerEvents: "none",
                                    }} />
                            );
                        })}
```

（`placedSigSet = new Set(placed.map(p => p.sig))` 在覆寫段之後宣告。幽靈框無文字 — 預告形狀、不爆雷內容。）

- [ ] **Step 4:** `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: 全 PASS + build 成功。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/GdbApi.tsx gdbgui/src/js/CallGraph.tsx
git commit -m "feat(callgraph): ghost pre-run wiring - fixed final layout with dashed placeholders"
```

---

### Task 5: 部署 + 驗收（controller 執行）

- [ ] `docker compose down; docker compose up -d --build`；HTTP 200。
- [ ] **容器內煙霧測試 endpoint**：無法直接模擬 session，改為容器內手動執行預跑腳本等價命令驗證 gdb python 路徑可用：
  `docker exec ... gdb --batch -nx -ex "python import json; print('py-ok')" /bin/true` → 印出 `py-ok`。
- [ ] 使用者驗收（Import `rec_fib.gdbgui.json` → Run）：
  - Run 後樹面板**一開始就出現整棵淡虛線骨架**（9 個空框 + 虛線邊）。
  - 每個節點實現時直接落在虛線框位置，**全程沒有任何節點平移**。
  - 播放到右子樹時左半邊完全不動（上次的痛點）。
  - rec_sum：垂直鏈骨架，同樣穩定。
  - 拔掉網路/後端錯誤情境不易手測 — 只驗證正常路徑；降級路徑由 Task 1 單元測試覆蓋。
