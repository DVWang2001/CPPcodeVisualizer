# UML 物件圖 P1（單框 + 即時值）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@guide uml:變數名` → 在新面板把該物件畫成一個 UML 框，顯示 `類別名` 標頭與每個欄位 `名稱 = 即時值`（隨執行更新）。

**Architecture:** 沿用現有容器管線：`VisualizerHelper` 解析 `uml:` 指令、建 GDB varobj、抓 children（欄位），寫成純資料 payload 到 `global_variable.__latest_uml`；一個新的 `UMLVisualizer` 面板每秒 poll、把 payload 畫成 UML 框。P1 只做「單一物件、無指標展開、無 ptype/可見性」——那些是 P2/P3。

**Tech Stack:** TypeScript/React（class component）、statorgfc store、GDB varobj（`GdbVariable`）、Jest。無新依賴。

**Spec:** `docs/superpowers/specs/2026-07-23-uml-object-diagram-design.md`（P1 里程碑）

## Global Constraints

- 純資料 payload 形狀（Task 1 定義，後續 P2/P3 會擴充，不可破壞）：
  `{ name: string; className: string; fields: Array<{ name: string; value: string }> }`
- 存放 key：`global_variable.__latest_uml`（`Map<string, UmlPayload>`，key = 變數名），與現有 `__latest_containers` 平行。
- `uml:` 指令語法與 `{container}` 同層（寫在 `@guide` 內），在 `VisualizerHelper.processing_guide` 解析。
- 顏色 token：標頭 `--hdr`（若不存在則用 `var(--accent-soft)`）、accent `var(--accent)`、值變動閃 `var(--highlight-soft)`。
- 面板每秒 poll（沿用 `ContainerVisualizer` 的 `setInterval(1000)` 模式）。
- 不新增 npm 依賴；conventional commits；pre-commit hook 跑 jest。

---

### Task 1: UML payload 資料模型 + 純建構函式

**Files:**
- Create: `gdbgui/src/js/umlPayload.ts`
- Test: `gdbgui/src/js/tests/umlPayload.jest.ts`

**Interfaces:**
- Produces:
  - `type UmlField = { name: string; value: string }`
  - `type UmlPayload = { name: string; className: string; fields: UmlField[] }`
  - `buildUmlPayload(varName: string, varType: string, children: Array<{ expression?: string; name?: string; value?: any }>): UmlPayload`
    - `className` = `varType`（原樣；P2 再正規化）
    - 每個 child → field：`name` = child.expression 的最後一段（`obj.field` → `field`；若無 `.` 或無 expression 則用 child.name ?? "?"），`value` = `String(child.value ?? "?")`
    - 過濾掉 child.name 以 `<` 開頭者（gdb 的 base-class 子物件如 `<Animal>`；P2 才處理繼承）

- [ ] **Step 1: 失敗測試**

```ts
import { buildUmlPayload } from "../umlPayload";

test("maps children to name=value fields, stripping the expression prefix", () => {
    const p = buildUmlPayload("head", "Node *", [
        { expression: "head->data", value: "5" },
        { expression: "head->next", value: "0x61f0" },
    ]);
    expect(p.name).toBe("head");
    expect(p.className).toBe("Node *");
    expect(p.fields).toEqual([
        { name: "data", value: "5" },
        { name: "next", value: "0x61f0" },
    ]);
});

test("falls back to child.name when no dotted/arrow expression", () => {
    const p = buildUmlPayload("n", "Node", [{ name: "x", value: "3" }]);
    expect(p.fields).toEqual([{ name: "x", value: "3" }]);
});

test("skips gdb base-class subobject children (name starts with '<')", () => {
    const p = buildUmlPayload("d", "Dog", [
        { name: "<Animal>", value: "..." },
        { expression: "d.breed", value: "\"Corgi\"" },
    ]);
    expect(p.fields).toEqual([{ name: "breed", value: "\"Corgi\"" }]);
});

test("undefined value becomes '?'", () => {
    const p = buildUmlPayload("n", "Node", [{ expression: "n.x" }]);
    expect(p.fields[0].value).toBe("?");
});
```

- [ ] **Step 2:** Run `npx jest umlPayload` — Expected: FAIL（module 不存在）。

- [ ] **Step 3: 實作 `umlPayload.ts`**

```ts
export type UmlField = { name: string; value: string };
export type UmlPayload = { name: string; className: string; fields: UmlField[] };

function fieldName(child: { expression?: string; name?: string }): string {
    const expr = child.expression;
    if (expr) {
        // last segment after the final '.' or '->'
        const m = expr.split(/->|\./).pop();
        if (m) return m.trim();
    }
    return (child.name ?? "?").trim();
}

export function buildUmlPayload(
    varName: string,
    varType: string,
    children: Array<{ expression?: string; name?: string; value?: any }>,
): UmlPayload {
    const fields: UmlField[] = [];
    for (const c of children || []) {
        if ((c.name ?? "").startsWith("<")) continue; // gdb base-class subobject → P2
        fields.push({ name: fieldName(c), value: String(c.value ?? "?") });
    }
    return { name: varName, className: varType, fields };
}
```

- [ ] **Step 4:** Run `npx jest umlPayload` — Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/umlPayload.ts gdbgui/src/js/tests/umlPayload.jest.ts
git commit -m "feat(uml): UML payload data model + buildUmlPayload"
```

---

### Task 2: `uml:` 指令解析（建 varobj、抓 children、寫 payload）

**Files:**
- Modify: `gdbgui/src/js/VisualizerHelper.js`（`processing_guide`，約 :194；`graphics_instruction` 建 varobj 的模式在 :586、抓 children 的 `resolveChildValues` 用法在 :747）

**Interfaces:**
- Consumes: Task 1 的 `buildUmlPayload`；`GdbVariable.create_variable(expr, "expr", displayKey)`（現有）；`store.get("expressions")` 找回建好的 varObj（含 `.type`、`.children`）。
- Produces: `global_variable.__latest_uml: Map<string, UmlPayload>`（key = 變數名）。

- [ ] **Step 1: 在 processing_guide 攔截 `uml:` 前綴**

在 `processing_guide`（VisualizerHelper.js:194）開頭、`[speed:N]` 處理之後，加入：guide 內容用正則 `/(?:^|\s)uml:([A-Za-z_][A-Za-z0-9_]*)/g` 掃出所有 `uml:名稱`，對每個名稱呼叫新的 `VisualizerHelper.processUml(name, funcName)`；並把 `uml:名稱` token 從 guideContent 移除（不進 graphics_instruction / 不顯示在 guide 面板）。

```js
// 在 guideContentNoSpeed 之後：
const umlRegex = /(?:^|\s)uml:([A-Za-z_][A-Za-z0-9_]*)/g;
let umlMatch;
while ((umlMatch = umlRegex.exec(guideContentNoSpeed)) !== null) {
    VisualizerHelper.processUml(umlMatch[1], funcName);
}
const guideNoUml = guideContentNoSpeed.replace(/(?:^|\s)uml:[A-Za-z_][A-Za-z0-9_]*/g, "").trim();
// 後續用 guideNoUml 取代 guideContentNoSpeed 繼續原流程（label / graphics）
```

- [ ] **Step 2: 實作 `processUml`（新 static 方法，放在 graphics_instruction 附近）**

沿用 `{container}` 的 varobj 建立/抓值模式（VisualizerHelper.js:586、:707、:747）：以 `funcName::name`（或 name）為 displayKey，刪舊 varobj、`GdbVariable.create_variable(name, "expr", displayKey)`，等 children 就緒後 `buildUmlPayload(name, varObj.type, varObj.children)` 寫入 `global_variable.__latest_uml`。抓 children 用現有 `resolveChildValues("__struct__", varObj, {...})` 觸發 `-var-list-children`（若 children 尚未載入），或直接讀 `varObj.children`（已載入時）。實作者請比照 :707–:757 的 async 輪詢（等 `__gdbgui_changelist_version` 更新再讀值）。

```js
static processUml(name, funcName) {
    const displayKey = (funcName && name.indexOf("::") === -1) ? `${funcName}::${name}` : name;
    const expressions = store.get("expressions");
    const existing = expressions.find(o => o.expression === displayKey && o.in_scope === "true");
    if (existing) GdbVariable.delete_gdb_variable(existing.name);
    GdbVariable.create_variable(name, "expr", displayKey);
    // 輪詢 varObj + children 就緒（比照 graphics_instruction 的 checkStore 模式），
    // 就緒後：
    //   const v = store.get("expressions").find(o => o.expression === displayKey && o.in_scope === "true");
    //   if (!global_variable.__latest_uml) global_variable.__latest_uml = new Map();
    //   global_variable.__latest_uml.set(name, buildUmlPayload(name, v.type || "?", v.children || []));
    //   if (window.gdbgui_request_render) window.gdbgui_request_render();
}
```
（`import { buildUmlPayload } from "./umlPayload";` 加到檔案頂部。）

- [ ] **Step 3: 手動驗證（容器內，Task 5 有完整教案；此步先煙霧測試）**

先跳過端到端（需前端）；確認 `npx jest`（不因本改動壞）+ `NODE_OPTIONS=--openssl-legacy-provider npm run build` 成功、無 TS/語法錯誤。

- [ ] **Step 4:** Run `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: jest 綠、build 成功。

- [ ] **Step 5: Commit**

```bash
git add gdbgui/src/js/VisualizerHelper.js
git commit -m "feat(uml): parse uml: directive, build UML payload from varobj children"
```

---

### Task 3: UMLVisualizer 面板元件（渲染 UML 框）

**Files:**
- Create: `gdbgui/src/js/UMLVisualizer.tsx`

**Interfaces:**
- Consumes: `global_variable.__latest_uml: Map<string, UmlPayload>`（Task 2）；`UmlPayload`（Task 1）。
- Produces: default export React class `UMLVisualizer`（供 Task 4 掛到 RightSidebar）。

- [ ] **Step 1: 實作元件**（自足；每秒 poll，畫每個 payload 成 UML 框）

```tsx
import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import type { UmlPayload } from "./umlPayload";

class UMLVisualizer extends React.Component<{}, {}> {
    private timer: any;
    componentDidMount() {
        this.timer = setInterval(() => this.forceUpdate(), 1000);
        // @ts-expect-error statorgfc augmentation
        store.connectComponentState(this, ["inferior_program"]);
    }
    componentWillUnmount() { clearInterval(this.timer); }

    render() {
        const map = (global_variable as any).__latest_uml as Map<string, UmlPayload> | undefined;
        const payloads = map ? [...map.values()] : [];
        if (payloads.length === 0) {
            return <div style={{ padding: "10px", color: "var(--ink-soft)", fontStyle: "italic", fontSize: "0.9em" }}>
                在教案行尾寫 <code>uml:變數名</code> 後執行，這裡會畫出該物件的 UML 圖。
            </div>;
        }
        return (
            <div style={{ padding: "8px", display: "flex", flexWrap: "wrap", gap: "14px" }}>
                {payloads.map(p => (
                    <div key={p.name} style={{
                        border: "1.5px solid var(--accent)", borderRadius: "8px", background: "var(--surface)",
                        fontFamily: "var(--font-mono, monospace)", minWidth: "160px", overflow: "hidden",
                    }}>
                        <div style={{
                            background: "var(--hdr, var(--accent-soft))", fontWeight: 700, fontSize: "13px",
                            padding: "5px 10px", textAlign: "center", borderBottom: "1.5px solid var(--line)",
                        }}>
                            {p.className}<span style={{ color: "var(--ink-faint)", fontWeight: 400, fontSize: "11px" }}> {p.name}</span>
                        </div>
                        <div style={{ padding: "5px 10px", display: "flex", flexDirection: "column", gap: "2px" }}>
                            {p.fields.map((f, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12px" }}>
                                    <span style={{ color: "var(--ink-soft)" }}>{f.name}</span>
                                    <span style={{ fontWeight: 700, color: "var(--ink)" }}>{f.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }
}
export default UMLVisualizer;
```

- [ ] **Step 2:** Run `NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: build 成功（元件編譯過；尚未掛載）。

- [ ] **Step 3: Commit**

```bash
git add gdbgui/src/js/UMLVisualizer.tsx
git commit -m "feat(uml): UMLVisualizer panel renders object as a UML box"
```

---

### Task 4: 掛進 RightSidebar 面板

**Files:**
- Modify: `gdbgui/src/js/RightSidebar.tsx`（import + render 內加 `<Collapser>`，約 :203–291）

**Interfaces:**
- Consumes: Task 3 的 `UMLVisualizer` default export。

- [ ] **Step 1: import + 加面板**

頂部 `import UMLVisualizer from "./UMLVisualizer";`。在 `render()` 的面板清單中（比照現有 `ContainerVisualizer` 的 `<Collapser>`，約 :203–291）加入：

```tsx
<Collapser id="uml_visualizer" title="UML 物件圖" collapsed={false}>
    <UMLVisualizer />
</Collapser>
```
（`id`/`title` 屬性名與收合預設比照相鄰 Collapser；若 Collapser 用不同的 prop 名，沿用該檔既有寫法。）

- [ ] **Step 2:** Run `npx jest && NODE_OPTIONS=--openssl-legacy-provider npm run build` — Expected: 全 PASS + build 成功。

- [ ] **Step 3: Commit**

```bash
git add gdbgui/src/js/RightSidebar.tsx
git commit -m "feat(uml): add UML object diagram panel to right sidebar"
```

---

### Task 5: Demo 教案 + bundle + 部署驗收

**Files:**
- Create: `examples/cpp/uml_node.cpp`（一個簡單自訂 class）
- Create: `examples/cpp/uml_node.gdbgui.json`（bundle）

**Interfaces:**
- Consumes: `uml:` 指令；`//@` 註解語法（AUTHORING_GUIDE §1）。

- [ ] **Step 1: 建立 uml_node.cpp**

```cpp
// 教案：UML 物件圖 P1 — 顯示一個自訂 class 物件的欄位即時值
#include <iostream>
#include <string>

class Point {
public:
    int x;
    int y;
    std::string label;
};

int main() {
    Point p;                //@ @tts [next] 宣告一個 Point 物件 p
    p.x = 3;                //@ @guide uml:p @tts [next] 設定 p.x = 3，看 UML 圖裡 x 變成 3
    p.y = 7;                //@ @guide uml:p @tts [next] 設定 p.y = 7
    p.label = "origin";     //@ @guide uml:p @tts [next] 設定 p.label
    std::cout << p.x + p.y << std::endl;  //@ @guide uml:p @tts [continue] 教案播放完畢
    return 0;
}
```

- [ ] **Step 2: 編譯驗證** — Run: `g++ -g -O0 examples/cpp/uml_node.cpp -o $TEMP/uml_node && $TEMP/uml_node` — Expected: 輸出 `10`。

- [ ] **Step 3: 產生 bundle** — 在 scratchpad 的 `make-bundles.js` 加一行 `makeBundle("uml_node.cpp", "int main()");`（斷點設在 main）後執行 `node <scratchpad>/make-bundles.js`，確認 `uml_node.gdbgui.json ... round-trip OK`。

- [ ] **Step 4: 部署** — Run: `docker compose down; docker compose up -d --build`；確認 HTTP 200。

- [ ] **Step 5: 使用者驗收 checklist**（Import `uml_node.gdbgui.json` → Run → 逐步）：
  - 右側出現「UML 物件圖」面板。
  - 走到 `p.x = 3` 之後，面板出現一個框：標頭 `Point p`，欄位 `x = 3`、`y = ...`、`label = ...`。
  - 逐步設定 x/y/label 時，框內對應值即時更新。
  - 未寫 `uml:` 的教案：面板顯示提示文字、不畫框。

- [ ] **Step 6: Commit**

```bash
git add examples/cpp/uml_node.cpp examples/cpp/uml_node.gdbgui.json
git commit -m "feat(uml): demo lesson for UML object diagram P1"
```

---

## Self-Review 註記

- P1 只涵蓋 spec 的「P1 單框 + 即時值」里程碑；可見性/方法/繼承（P2）、跟指標展開（P3）另立計畫。
- 唯一風險點：Task 2 的 async children 輪詢——實作者必須比照 `graphics_instruction`（VisualizerHelper.js:707–757）等 `__gdbgui_changelist_version` 更新再讀 `varObj.children`，否則第一次可能拿到空 children。驗收 checklist 的「即時更新」會抓到這個。
- `gdbgui.css` 若無 `--hdr` token，`var(--hdr, var(--accent-soft))` 的 fallback 已處理。
