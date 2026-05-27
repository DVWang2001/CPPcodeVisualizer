# CPPcodeVisualizer — 專案快速上手文件

> 供 AI 模型或新對話階段快速理解此專案的架構、關鍵檔案與修改方式。
> 最後更新：2026-05-19（Develop 分支）

---

## 目錄

1. [專案定位](#1-專案定位)
2. [技術堆疊與建置方式](#2-技術堆疊與建置方式)
3. [目錄結構](#3-目錄結構)
4. [前端狀態系統](#4-前端狀態系統)
5. [資料流全覽：程式暫停到畫面更新](#5-資料流全覽程式暫停到畫面更新)
6. [VisualizerHelper.js — 核心協調器](#6-visualizerhelperjs--核心協調器)
7. [GdbVariable.tsx — GDB 變數管理與 changelist](#7-gdbvariabletsx--gdb-變數管理與-changelist)
8. [ContainerVisualizer.tsx — 容器形狀渲染](#8-containervisualizertsx--容器形狀渲染)
9. [Visualizer.tsx — 步驟追蹤表格](#9-visualizertsx--步驟追蹤表格)
10. [JSON 課程檔格式](#10-json-課程檔格式)
11. [教學語法速查](#11-教學語法速查)
12. [已知問題與修復記錄](#12-已知問題與修復記錄)
13. [常見修改場景與對應檔案](#13-常見修改場景與對應檔案)

---

## 1. 專案定位

CPPcodeVisualizer 是以 [gdbgui](https://github.com/cs01/gdbgui)（瀏覽器版 GDB 前端）為基礎擴充的 **C++ 互動式教學除錯器**。

核心功能：
- 程式單步執行時，同步顯示 STL 容器的動態圖形（vector、stack、queue 等）
- 播放 TTS 語音講解每一步驟
- 教師可事先為每一行程式碼設定「導覽文字 / 語音 / 版面佈局」，存成 JSON 課程檔
- 學生載入課程檔後，按「播放」即可全自動逐步學習

**不是** 通用 debugger — 著重教學演示，非 bug 排查工具。

---

## 2. 技術堆疊與建置方式

| 層次 | 技術 |
|------|------|
| 前端框架 | React 16.8 + TypeScript 3.3 |
| 狀態管理 | statorgfc（輕量 observable store） |
| 程式碼編輯器 | Monaco Editor |
| 模組打包 | Webpack 4（注意：**不是** Webpack 5） |
| 後端伺服器 | Python Flask + Flask-SocketIO |
| GDB 介面 | GDB/MI（Machine Interface） |
| 終端機 | xterm.js + PTY |

### 建置前端

```powershell
# Windows 上 Node.js v20 需要此環境變數
$env:NODE_OPTIONS="--openssl-legacy-provider"
npm run build
```

輸出：`gdbgui/static/js/main.js`

> **重要**：`tsconfig.json` 設定 `"target": "es5"`，`ts-loader` 處理所有 `.js` 和 `.tsx` 檔案（含 `VisualizerHelper.js`）。`const`/`let` 都被編譯成 `var`，因此 `.js` 檔中 `const` 看似可被重新賦值是正常的。

### 啟動後端

```bash
python -m gdbgui
```

---

## 3. 目錄結構

```
CPPcodeVisualizer/
├── gdbgui/
│   ├── server/              # Python Flask 後端
│   │   ├── http_routes.py   # API 端點（/compile, /tts_audio, /upload 等）
│   │   ├── app.py           # Flask app 初始化
│   │   └── sessionmanager.py# GDB session 管理
│   ├── src/js/              # ★ 前端原始碼（主要修改區域）
│   │   ├── VisualizerHelper.js   # ★ 最核心：TTS + 容器資料抓取
│   │   ├── ContainerVisualizer.tsx # ★ 容器圖形渲染
│   │   ├── Visualizer.tsx        # 步驟追蹤表格
│   │   ├── GdbVariable.tsx       # GDB 變數管理（含 changelist 處理）
│   │   ├── process_gdb_response.tsx # GDB 回應分派
│   │   ├── Actions.ts            # 全域動作中心
│   │   ├── RightSidebar.tsx      # 右側面板佈局
│   │   ├── SourceCode.tsx        # 原始碼編輯器（含 Guide/TTS/Layout 欄位）
│   │   ├── global_variable.js    # window.gdbgui_global_variable 掛載點
│   │   ├── GdbApi.tsx            # Socket.IO → GDB/MI 通訊
│   │   └── constants.ts         # 常數定義
│   └── static/js/main.js    # 建置輸出（勿手動編輯）
├── webpack.config.js
├── tsconfig.json
├── SYSTEM_PRINCIPLES.md     # 原始詳細系統說明文件
└── 10個經典案例/             # 範例課程 JSON 檔
```

---

## 4. 前端狀態系統

### 兩種狀態儲存

**A. statorgfc store**（`store.get` / `store.set`）

結構化的全域狀態，React 元件可訂閱特定 key 自動重新渲染：

```typescript
store.connectComponentState(this, ["expressions", "inferior_program"]);
// 元件會在這些 key 變動時重新渲染
```

關鍵 key：

| Key | 型別 | 說明 |
|-----|------|------|
| `expressions` | 物件陣列 | GDB varobj 物件（含 name、expression、value、children、numchild 等） |
| `inferior_program` | 字串 | `running` / `paused` / `exited` |
| `breakpoints` | 陣列 | 斷點清單 |
| `locals` | 陣列 | 目前作用域本地變數 |
| `edit_mode` | 布林 | 是否為教師編輯模式 |
| `tts_subtitle` | 字串 | 目前朗讀字幕 |

**B. global_variable**（`window.gdbgui_global_variable`）

教學用非 React 即時狀態，命名均以雙底線開頭：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `__guide` | `Map<string, any[]>` | 每行的導覽步驟值（`行號 → [步驟1, 步驟2, ...]`） |
| `__line` | `Record<number, string>` | 每行導覽文字模板 |
| `__tts` | `Record<number, string>` | 每行 TTS 文字模板 |
| `__layout` | `Record<number, string>` | 每行版面指令 |
| `__latest_containers` | `Map<string, ContainerPayload>` | ★ 最新容器資料，`ContainerVisualizer` 每秒讀取 |
| `__latest_highlights` | `Map<string, HighlightEntry[]>` | ★ 高亮索引，`ContainerVisualizer` 讀取 |
| `__containers_guide` | `Map<number, ContainerPayload[]>` | 歷史容器資料（Visualizer 表格用） |
| `__line_visit_count` | `Record<number, number>` | 每行被執行幾次（TTS 多段語法用） |
| `__source_text` | 字串 | 目前原始碼內容 |

### ContainerPayload 結構

```typescript
{
  name: string;         // 容器名稱（和 guide 語法中的名稱一致）
  type: string;         // "vector" | "stack" | "queue" | "deque" | "list" | "set" | "map" | ...
  values: any[];        // 元素值陣列（map 為 {key, value} 陣列）
  isContainer: true;
  capacity?: number;    // 僅 vector 有
}
```

### HighlightEntry 結構

```typescript
type HighlightEntry = { index: number; color: string };
// color === 'default' → 黃色高亮
// color 為任意 CSS 色彩字串
```

---

## 5. 資料流全覽：程式暫停到畫面更新

```
GDB *stopped 回應
    ↓
process_gdb_response.tsx
    ↓
Actions.inferior_program_paused(frame)
    ↓
VisualizerHelper.processing_guide(frame.line, frame.func)
    │
    ├─ 套用 Layout 指令（開關面板、sidebar 寬度）
    │
    ├─ graphics_instruction(guideText, lineNumber)
    │   │
    │   ├─ extractBalancedBraces() 提取所有 {token}
    │   ├─ 對每個 token：
    │   │   ├─ {arr[i]}         → 記錄高亮到 __latest_highlights
    │   │   ├─ {arr}            → GDB -var-create → checkStore 輪詢
    │   │   └─ {i}              → GDB -var-create → 等待值
    │   │
    │   └─ 所有 Promise 完成後 → 寫入 __latest_containers
    │
    └─ play_tts(line, func)
        ├─ 替換 {varName}
        ├─ POST /tts_audio
        ├─ 播放 + 顯示字幕
        └─ 播完後執行 [next]/[continue] 等指令

ContainerVisualizer（1 秒輪詢）
    └─ 讀取 __latest_containers + __latest_highlights → 渲染
```

---

## 6. VisualizerHelper.js — 核心協調器

**這是最重要的修改檔案**，幾乎所有教學功能都在此。

### graphics_instruction() — 容器資料抓取

從 guide 文字提取 `{expr}` 後，對每個容器：

1. 呼叫 `GdbVariable.create_variable(expr)` 建立 GDB varobj
2. `checkStore()` 每 50–200ms 輪詢 `store.get("expressions")` 等待值就位
3. 依型別建立 ContainerPayload
4. 寫入 `__latest_containers`

### checkStore() — 容器元素同步邏輯（易出 bug 之處）

```javascript
// 在 varObj.numchild > 0 的分支裡：
const _newNch = (varObj.new_num_children !== undefined)
  ? parseInt(String(varObj.new_num_children)) : NaN;
const _expectedSize = (!isNaN(_newNch)) ? _newNch : varObj.numchild;

if (varObj.children && varObj.children.length !== _expectedSize) {
  // children 與預期不符（push/pop 後），強制清空並重新 fetch
  varObj.children = [];
  if (varObj.numchild !== _expectedSize) varObj.numchild = _expectedSize;
  store.set("expressions", expressions);
  GdbVariable.fetch_and_show_children_for_var(varObj.name);
  setTimeout(checkStore, 200);
  return;
}
```

> **為何這樣設計**：`fetch_and_show_children_for_var()` 只在 `children.length === 0` 時才真的送 GDB 命令。要強制重新 fetch，必須先清空 `children`。

> **`new_num_children` vs `numchild`**：dynamic varobj（GDB pretty-printer 啟用）的 pop 事件，changelist 用 `new_num_children` 而非 `numchild`，後者不會被 `-var-update` 更新。

### 高亮語法處理（索引解析）

```javascript
// 支援負數索引（如 {arr[-1]} = 最後一個元素）
if (/^-?\d+$/.test(indexExpr)) {
  hl0.push({ index: parseInt(indexExpr), color: highlightColor });
}
```

負數索引在 `ContainerVisualizer.tsx` 的 `getHighlight()` 解析：
```typescript
const resolved = (e.index < 0 && len !== undefined) ? len + e.index : e.index;
```

---

## 7. GdbVariable.tsx — GDB 變數管理與 changelist

### varobj 結構（expressions 陣列中的元素）

```typescript
{
  name: string;           // GDB 內部名稱，如 "var1"
  expression: string;     // 使用者表達式，如 "train"
  type: string;           // C++ 型別，如 "std::stack<int, ...>"
  value: string;          // 當前值字串，如 "size = 4"
  numchild: number;       // 子節點數（fetch 後與 children.length 相等）
  children: any[];        // 子節點陣列（需要呼叫 fetch 才會填入）
  in_scope: "true" | "false";
  new_num_children?: string; // dynamic varobj（pretty-printer）size 變化時出現
  has_more?: string;      // "1" = 還有更多子節點未 fetch（push 時出現）
  dynamic?: string;       // "1" = dynamic varobj（pretty-printer）
}
```

### handle_changelist() — 關鍵修改點

當 GDB 回傳 `-var-update` changelist 時，此函式處理每個變更：

```typescript
// 原始邏輯（行 741）：push 時 has_more=1 觸發重新 fetch
if (parseInt(changelist["has_more"]) === 1 && "name" in changelist) {
  ChildVarFetcher.fetch_children(changelist["name"], obj.expr_type);
}

// 新增邏輯（修復 pop 後 children 不更新的問題）：
if ("new_num_children" in changelist && obj.children) {
  const _newCount = parseInt(String(changelist["new_num_children"]));
  if (!isNaN(_newCount) && obj.children.length > _newCount) {
    // pop：children 比 new_num_children 多 → 清空，讓 checkStore 重新 fetch
    obj.children = [];
    obj.numchild = _newCount;
  }
}
```

### fetch_and_show_children_for_var() — 陷阱

```typescript
// 行 674：只有 children.length === 0 時才真的送 GDB 命令！
if (obj.numchild && obj.children.length === 0) {
  ChildVarFetcher.fetch_children(gdb_var_name, obj.expr_type);
}
```

要強制重新 fetch（如容器大小變化後），必須先清空 `obj.children = []`。

---

## 8. ContainerVisualizer.tsx — 容器形狀渲染

### 資料來源

- 每秒從 `global_variable.__latest_containers` 讀取（`setInterval(1000)` + `forceUpdate()`）
- 高亮從 `global_variable.__latest_highlights` 讀取

### getHighlight() — 高亮輔助函式

```typescript
function getHighlight(
  idx: number,
  highlights: HighlightEntry[] | undefined,
  len?: number  // ★ 必須傳入，支援負數索引
): { bg: string; border: string } | null {
  if (!highlights) return null;
  const h = highlights.find(e => {
    const resolved = (e.index < 0 && len !== undefined) ? len + e.index : e.index;
    return resolved === idx;
  });
  if (!h) return null;
  if (h.color === 'default') return { bg: '#fff6b3', border: '#cca300' }; // 黃色
  return { bg: h.color, border: h.color };
}
```

> **重要**：所有呼叫 `getHighlight` 的地方都要傳第三個參數 `len`（容器長度），才能讓 `{arr[-1]}` 正確高亮最後一格。

### 各容器渲染邏輯（case 分支位置）

| 容器型別 | 識別條件 | 形狀特色 |
|---------|---------|---------|
| `vector` / `array` | 一維：橫向格線 | 有容量虛線格（capacity） |
| `vector` 二維 | 值為陣列的陣列 | 矩陣或迷宮格 |
| `stack` | `type.includes("stack")` | 右開口堆疊，左邊有結構標示線 |
| `queue` | `type.includes("queue")` | 橫向 + 左右箭頭 |
| `deque` | `type.includes("deque")` | 橫向 + 雙向箭頭 |
| `list` | `type.includes("list")` | 圓角節點鏈結 |
| `set` / `multiset` | `type.includes("set")` | RB 樹 或 大括號集合 |
| `map` / `multimap` | `type.includes("map")` | 鍵值對表格 |
| `string` | 字元格 | 每格顯示一個字元 |

### Body 容器置中（目前佈局）

```tsx
<div style={{ overflowX: "auto", display: "flex", justifyContent: "center", padding: "12px 0" }}>
  <div style={{ width: "90%" }}>
    {shape}
  </div>
</div>
```

### 格子大小標準（flex 佈局）

所有容器的格子統一使用：
```tsx
{ flex: 1, padding: '18px 6px', fontSize: '1.1em', textAlign: 'center' }
```
外層容器 `display: 'flex', width: '100%'`，讓格子等寬平分空間。

---

## 9. Visualizer.tsx — 步驟追蹤表格

顯示「程式碼 × 執行步驟」二維表格：

```
行號 | 原始碼           | 步驟1 | 步驟2 | 步驟3
  3  | for(int i=0...) | i=0  | i=1  | i=2
```

- 資料來源：`global_variable.__guide`（`Map<lineNum, stepValues[]>`）
- 每秒 `forceUpdate()` 刷新
- 只有有導覽文字的行才顯示步驟欄

---

## 10. JSON 課程檔格式

```json
{
  "version": "1.0",
  "project_name": "my_lesson",
  "source_code": "#include <iostream>\n...",
  "line_data": {
    "7": {
      "guide": "現在 i={i}，arr[i]={arr[i]}\n{arr[i]:yellow}",
      "tts": "[next] i 是 {i}，把 arr[{i}] 加進 stack。",
      "layout": "sidebar:50 open:container"
    },
    "12": {
      "guide": "{train[-1]:yellow}",
      "tts": "[continue] stack 頂端是 {train[-1]}。",
      "layout": ""
    }
  },
  "program_input": "",
  "breakpoints": [
    { "line": "7", "is_normal_breakpoint": true },
    { "line": "12", "is_normal_breakpoint": true }
  ]
}
```

### 匯入/匯出

- UI 右上角「Import JSON」/「Export JSON」按鈕
- 課程檔包含原始碼、所有 guide/tts/layout 設定、斷點位置

---

## 11. 教學語法速查

### Guide 語法

| 語法 | 說明 |
|------|------|
| `{varName}` | 替換為變數當前值 |
| `{arr}` | 渲染整個容器（在 ContainerVisualizer 顯示） |
| `{arr[i]}` | 渲染容器並高亮索引 i（黃色，default） |
| `{arr[i]:red}` | 高亮索引 i 並指定顏色 |
| `{arr[-1]:yellow}` | 高亮最後一個元素（負數索引） |
| `{grid[i][j]}` | 高亮二維陣列 (i,j) |
| `\n` | 換行 |

> **支援 random access 的容器**：`vector`、`array`、`deque` 可用 `{name[index]}` 高亮。
> `stack` 只能用 `{name[-1]}` 高亮頂端（因為 `stack.top()` 無法轉成索引）。

### TTS 語法

| 語法 | 說明 |
|------|------|
| `{varName}` | 朗讀變數值 |
| `字[音]` | 自訂發音，如 `i[愛]` |
| `A \| B \| C` | 依訪問次數選段（第1/2/3次各讀不同文字） |
| `@N text` | 從第 N 次訪問起才朗讀 |
| `[next]` | TTS 完畢後自動執行 step over |
| `[step-in]` | TTS 完畢後自動 step into |
| `[continue]` | TTS 完畢後繼續到下一斷點 |
| `[speed:N]` | 控制 TTS 速率 |

### Layout 語法

| 語法 | 說明 |
|------|------|
| `sidebar:N` | 右側欄寬度（百分比 0–99） |
| `open:panel1,panel2` | 展開指定面板 |
| `close:panel1` | 折疊指定面板 |
| `maze:containerName` | 對容器啟用迷宮視覺化 |
| `ruler:low,high,mid` | 啟用區間尺規（二分搜尋用） |

面板 ID：`compile_errors`、`memory_watch`、`callgraph`、`visualizer`、`container`、`locals`、`watch_table`

---

## 12. 已知問題與修復記錄

### Bug 1：`fetch_and_show_children_for_var` 不重新 fetch 非空 children

**症狀**：push/pop 後容器視覺化不更新。

**根本原因**：`GdbVariable.tsx:674`
```typescript
if (obj.numchild && obj.children.length === 0) {
  ChildVarFetcher.fetch_children(...);  // 只有空 children 才 fetch！
}
```

**修法**：要強制重新 fetch，必須先清空 `obj.children = []`，再呼叫此函式。

### Bug 2：pop 後 `numchild` 沒有更新（dynamic varobj）

**症狀**：pop 後 `numchild` 仍是舊值，mismatch 比對失敗。

**根本原因**：dynamic varobj（pretty-printer）的 `-var-update` changelist 用 `new_num_children` 而非 `numchild`。`Object.assign(obj, changelist)` 只複製 `new_num_children`，不更新 `numchild`。

**修法**（`GdbVariable.tsx handle_changelist`）：
```typescript
if ("new_num_children" in changelist && obj.children) {
  const _newCount = parseInt(String(changelist["new_num_children"]));
  if (!isNaN(_newCount) && obj.children.length > _newCount) {
    obj.children = [];      // 清空 stale children
    obj.numchild = _newCount; // 同步 numchild
  }
}
```

**修法**（`VisualizerHelper.js checkStore`）：
```javascript
const _newNch = (varObj.new_num_children !== undefined)
  ? parseInt(String(varObj.new_num_children)) : NaN;
const _expectedSize = (!isNaN(_newNch)) ? _newNch : varObj.numchild;
if (varObj.children && varObj.children.length !== _expectedSize) {
  varObj.children = [];
  if (varObj.numchild !== _expectedSize) varObj.numchild = _expectedSize;
  store.set("expressions", expressions);
  GdbVariable.fetch_and_show_children_for_var(varObj.name);
  setTimeout(checkStore, 200);
  return;
}
```

### Bug 3：`{train.size()-1]` 語法在 GDB 失敗

**症狀**：複雜表達式如 `train.size()-1` 無法作為 GDB `-var-create` 的索引。

**解決方案**：改用負數索引語法 `{train[-1]}` 表示最後一個元素。

### Bug 4：Node.js v20 + Webpack 4 建置失敗

**症狀**：`ERR_OSSL_EVP_UNSUPPORTED`

**修法**：
```powershell
$env:NODE_OPTIONS="--openssl-legacy-provider"
npm run build
```

---

## 13. 常見修改場景與對應檔案

### 想改容器的外觀（顏色、大小、形狀）

→ **`gdbgui/src/js/ContainerVisualizer.tsx`**

找對應容器的 `case` 分支（搜尋 `containerName === "stack"` 等），修改 JSX 樣式。

### 想讓更多容器支援索引高亮（`{arr[i]:color}`）

→ **`gdbgui/src/js/VisualizerHelper.js`**（解析語法）  
→ **`gdbgui/src/js/ContainerVisualizer.tsx`**（渲染時呼叫 `getHighlight`）

**語法解析**：在 `graphics_instruction` 的索引處理區塊，確認正規式允許該語法（`/^-?\d+$/` 允許負數）。

**渲染**：確保呼叫 `getHighlight(idx, highlights, len)` 並傳入第三個參數 `len`。

### 想新增容器型別支援

1. **型別識別**（`VisualizerHelper.js`）：在 `checkStore` 的 `containerName` 判斷區塊加入條件
2. **渲染**（`ContainerVisualizer.tsx`）：在 `renderContainer()` 加入新的 `case` 分支

### 想修改 TTS 語法

→ **`gdbgui/src/js/VisualizerHelper.js`**

搜尋 `play_tts` 函式，語法解析在該函式內。

### 想修改 Guide 語法的解析邏輯

→ **`gdbgui/src/js/VisualizerHelper.js`**

搜尋 `graphics_instruction` 函式與 `extractBalancedBraces` 函式。

### 想新增右側面板

→ **`gdbgui/src/js/RightSidebar.tsx`**

在 `render()` 加入新的 `<Collapser>` 元件，設定 `id` 供 Layout 語法控制。

### 想修改 GDB 回應處理

→ **`gdbgui/src/js/process_gdb_response.tsx`**

依 GDB/MI 回應型別分派處理。

### 想修改後端 API

→ **`gdbgui/server/http_routes.py`**

Flask 路由定義。

---

## 附錄：global_variable 完整欄位表

| 欄位 | 型別 | 填寫者 | 讀取者 |
|------|------|--------|--------|
| `__guide` | `Map<lineNum, stepValues[]>` | VisualizerHelper | Visualizer |
| `__line` | `Record<num, string>` | SourceCode | VisualizerHelper |
| `__tts` | `Record<num, string>` | SourceCode | VisualizerHelper |
| `__layout` | `Record<num, string>` | SourceCode | VisualizerHelper |
| `__latest_containers` | `Map<name, ContainerPayload>` | VisualizerHelper | ContainerVisualizer |
| `__latest_highlights` | `Map<name, HighlightEntry[]>` | VisualizerHelper | ContainerVisualizer |
| `__containers_guide` | `Map<lineNum, ContainerPayload[]>` | VisualizerHelper | Visualizer |
| `__line_visit_count` | `Record<num, number>` | VisualizerHelper | VisualizerHelper |
| `__source_text` | `string` | SourceCode | Visualizer |
| `__asking_capacity_for` | `Set<string>` | VisualizerHelper | VisualizerHelper |
| `__rb_tree_data` | `Map<name, RBTreeData>` | VisualizerHelper | ContainerVisualizer |
| `_debug_counter` | `number` | VisualizerHelper | 偵錯用 |
