# CPPcodeVisualizer 系統原理說明

> **用途**：本文件供學術研究使用，說明各子系統的設計原理、運作機制與技術細節。

---

## 目錄

1. [系統架構總覽](#1-系統架構總覽)
2. [前端框架與狀態管理](#2-前端框架與狀態管理)
3. [GDB 通訊機制（GdbApi）](#3-gdb-通訊機制gdbapi)
4. [GDB 回應處理（process_gdb_response）](#4-gdb-回應處理process_gdb_response)
5. [STL 容器視覺化（ContainerVisualizer）](#5-stl-容器視覺化containervisualizer)
6. [導覽與 TTS 處理核心（VisualizerHelper）](#6-導覽與-tts-處理核心visualizerhelper)
7. [步驟追蹤表格（Visualizer）](#7-步驟追蹤表格visualizer)
8. [區間尺規（RangeRuler）](#8-區間尺規rangeruler)
9. [編譯錯誤顯示（CompileErrors）](#9-編譯錯誤顯示compileerrors)
10. [原始碼編輯器（SourceCode）](#10-原始碼編輯器sourcecode)
11. [右側面板佈局（RightSidebar）](#11-右側面板佈局rightsidebar)
12. [除錯控制列（ControlButtons）](#12-除錯控制列controlbuttons)
13. [終端機模擬（Terminals）](#13-終端機模擬terminals)
14. [動作中心（Actions）](#14-動作中心actions)
15. [後端伺服器（http_routes）](#15-後端伺服器http_routes)
16. [安全沙箱（jail_manager）](#16-安全沙箱jail_manager)
17. [完整資料流程](#17-完整資料流程)
18. [教學導覽語法設計](#18-教學導覽語法設計)

---

## 1. 系統架構總覽

CPPcodeVisualizer 是以 [gdbgui](https://github.com/cs01/gdbgui) 為基礎所擴充的 C++ 互動式教學除錯器，核心目標是讓學習者在單步執行程式時，同步看到 STL 容器的動態形狀、聽到 TTS 語音講解、並按照教師預先設定的導覽文字理解每一步驟。

### 技術堆疊

| 層次 | 技術 |
|------|------|
| 前端框架 | React 16.8 + TypeScript 3.3 |
| 程式碼編輯 | Monaco Editor 0.21.2 |
| 狀態管理 | statorgfc（輕量 observable store） |
| WebSocket | Socket.IO 4.1（前端） + Flask-SocketIO（後端） |
| 終端機 | xterm.js 4.8.0 |
| 模組打包 | Webpack 5 |
| 後端伺服器 | Python Flask |
| GDB 介面 | GDB/MI（Machine Interface） |
| 虛擬終端機 | PTY（Pseudo-Terminal）|
| 沙箱隔離 | Chroot Jail + ulimit 資源限制 |

### 架構分層

```
┌─────────────────────────────────────────────────────┐
│                    瀏覽器（前端）                     │
│  ┌──────────┐  ┌─────────────────┐  ┌────────────┐  │
│  │SourceCode│  │ContainerVisualiz│  │ Visualizer │  │
│  │ (Monaco) │  │er + RangeRuler  │  │(步驟追蹤)  │  │
│  └──────────┘  └─────────────────┘  └────────────┘  │
│  ┌──────────────────────────────────────────────┐   │
│  │         VisualizerHelper（核心協調器）         │   │
│  │   TTS播放 / 導覽解析 / 容器資料抓取           │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │         GdbApi（Socket.IO 客戶端）             │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                        ↕ WebSocket
┌─────────────────────────────────────────────────────┐
│              Flask 後端伺服器                         │
│  ┌──────────┐  ┌─────────┐  ┌───────────────────┐  │
│  │http_route│  │  GDB/MI │  │  jail_manager      │  │
│  │  s.py    │  │  通訊   │  │ （沙箱隔離）       │  │
│  └──────────┘  └─────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────┘
                        ↕ PTY
┌─────────────────────────────────────────────────────┐
│          GDB 子行程 + 被偵錯程式（Inferior）          │
└─────────────────────────────────────────────────────┘
```

---

## 2. 前端框架與狀態管理

### statorgfc Store

本專案使用 **statorgfc** 作為前端全域狀態管理，其運作原理類似精簡版 MobX：透過 `store.set(key, value)` 寫入、`store.subscribe(keys, callback)` 訂閱，當特定 key 發生變化時自動觸發對應元件的重新渲染。

**關鍵全域狀態（InitialStoreData.ts 定義）**：

| 狀態 key | 型別 | 用途 |
|----------|------|------|
| `expressions` | 物件陣列 | 所有 GDB 變數表達式及其值 |
| `inferior_program` | 字串 | `running` / `paused` / `exited` |
| `breakpoints` | 陣列 | 斷點清單（含條件與計數） |
| `locals` | 陣列 | 目前作用域的本地變數 |
| `stack` | 陣列 | 呼叫堆疊框架 |
| `source_file_paths` | 陣列 | 已索引的原始碼檔案 |
| `compile_errors` | 陣列 | 解析後的 GCC 錯誤列表 |
| `tts_speed` | 數值 | TTS 播放速率（0.1–4.0） |
| `tts_subtitle` | 字串 | 目前 TTS 正在朗讀的文字 |
| `edit_mode` | 布林 | 是否處於教師編輯模式 |

教學用自訂狀態以雙底線開頭命名（如 `__guide`、`__tts`、`__layout`），與原始 gdbgui 狀態做區隔。

---

## 3. GDB 通訊機制（GdbApi）

**檔案**：[gdbgui/src/js/GdbApi.tsx](gdbgui/src/js/GdbApi.tsx)

### GDB/MI 協議

GDB 提供機器介面（Machine Interface, MI）模式，在此模式下：
- 所有輸入指令以 `-` 開頭（如 `-exec-next`、`-var-create`）
- 所有輸出以結構化的 token 格式回傳
- 每條回應以 `(gdb)` 作為提示符結束

### Socket.IO 雙向通道

```
前端 GdbApi.run_gdb_command(cmd)
    │
    └──→ socket.emit('run_gdb_command', {data: cmd})
                │
         Flask-SocketIO 接收
                │
         將指令寫入 GDB stdin（PTY）
                │
         GDB 執行並輸出 MI 回應
                │
         Flask 讀取 stdout，emit('gdb_response', data)
                │
    ←──── socket.on('gdb_response', callback)
                │
         process_gdb_response() 處理回應
```

### 重要設計：Token 機制

GDB/MI 支援在指令前加上數字 token（如 `123-exec-next`），回應會帶回相同 token，讓前端能對應非同步指令與結果。本專案在部分指令中使用此機制追蹤變數查詢的來源。

---

## 4. GDB 回應處理（process_gdb_response）

**檔案**：[gdbgui/src/js/process_gdb_response.tsx](gdbgui/src/js/process_gdb_response.tsx)

這是全域 GDB 回應的分派中心，根據回應類型（`type` 欄位）執行對應的處理邏輯：

| 回應類型 | 說明 | 觸發動作 |
|----------|------|----------|
| `result` | 指令結果（成功/失敗） | 更新變數值、斷點、堆疊 |
| `notify` | 非同步通知 | 處理斷點命中、程式停止 |
| `output` | 程式標準輸出 | 更新終端機顯示 |
| `console` | GDB 控制台文字 | 更新 GDB log 終端機 |

當偵測到 `*stopped`（程式暫停）事件時，會呼叫 `Actions.inferior_program_paused(frame)`，觸發整條教學導覽顯示鏈路。

---

## 5. STL 容器視覺化（ContainerVisualizer）

**檔案**：[gdbgui/src/js/ContainerVisualizer.tsx](gdbgui/src/js/ContainerVisualizer.tsx)

### 5.1 核心原理

`ContainerVisualizer` 每秒從全域 store 的 `__latest_containers` 讀取最新的容器資料，並根據容器型別選擇對應的繪圖元件進行渲染。資料本身由 `VisualizerHelper` 非同步向 GDB 查詢並存入 store。

### 5.2 容器形狀對應

| C++ 型別 | 視覺形狀 | 說明 |
|----------|---------|------|
| `vector<T>` | 橫向格線陣列 | 包含容量虛線格（capacity） |
| `T[]`（陣列） | 橫向格線陣列 | 同 vector 但無 capacity |
| `T[][]`（二維） | 矩陣格線 | 支援迷宮模式 |
| `stack<T>` | 右開口容器 | 仿實體堆疊形狀 |
| `queue<T>` | 雙箭頭容器 | 左進右出 |
| `deque<T>` | 雙端橫向 | 兩端皆可操作 |
| `list<T>` | 鏈結節點鏈 | 含雙向箭頭 |
| `string` | 字元格線 | 每格一個字元 |
| `set` / `multiset` | RB 樹 或 大括號集合 | 可切換模式 |
| `map` / `multimap` | 鍵值對表格 | key → value |
| `unordered_map` | 雜湊表格式 | 同 map 但無排序 |

### 5.3 紅黑樹（RB-Tree）視覺化

這是本系統最複雜的容器視覺化元件，分為兩種模式：

**模式 A：從 GDB 取得真實樹狀結構**

透過 `VisualizerHelper.fetchRBTreeData()` 執行 GDB Python 腳本，直接走訪底層 `_M_node` 指標結構，取得每個節點的：
- 鍵值（key）
- 節點顏色（紅/黑）
- 左右子節點指標

**模式 B：JS 模擬插入順序建樹**

當 GDB 樹結構取得失敗時，以集合中元素的插入順序模擬 RB 樹建構過程，在前端執行完整的 RB 樹插入演算法（含旋轉與顏色修正）：

```typescript
// 核心旋轉操作
function rbRotateLeft(tree, node) { ... }
function rbRotateRight(tree, node) { ... }

// 插入後修復 RB 樹性質
function rbInsertFix(tree, node) {
  while (node.parent?.color === 'red') {
    if (叔父節點是紅色) {
      // Case 1：重新著色
    } else if (node 是右子節點) {
      // Case 2：左旋
    } else {
      // Case 3：右旋 + 重新著色
    }
  }
  tree.root.color = 'black';
}
```

節點顏色以圓形背景色（紅色/深灰色）呈現，並計算黑高（black-height）驗證樹的合法性。

### 5.4 迷宮模式（Maze Mode）

當教師在 Layout 欄位設定 `maze:containerName` 後，二維陣列會以迷宮格子呈現：

- 值 `0`：地板（淡色）
- 值 `1`：牆壁（深色）
- 其他值：依使用者定義的顏色規則著色

顏色規則透過 UI 小工具編輯，存入 `mazeColorRules` 狀態，支援動態新增/刪除規則。

### 5.5 索引高亮

透過 `__latest_highlights` 狀態傳遞高亮資訊：

- `{arr[i]}`：將索引 i 的格子加上黃色背景 + 粗體
- `{grid[i][j]}`：將二維格子 (i,j) 加上高亮

---

## 6. 導覽與 TTS 處理核心（VisualizerHelper）

**檔案**：[gdbgui/src/js/VisualizerHelper.js](gdbgui/src/js/VisualizerHelper.js)

這是整個教學系統的協調核心，負責在每次程式暫停時：
1. 解析當前行的導覽/TTS/Layout 指令
2. 非同步抓取所有 `{expr}` 對應的 GDB 變數值
3. 播放 TTS 語音
4. 更新全域 store 供各元件渲染

### 6.1 processing_guide()

入口函式，在 `Actions.inferior_program_paused()` 觸發後執行：

```
processing_guide(lineNumber, funcName)
  ├─ 讀取 __line[lineNumber] → 導覽文字
  ├─ 讀取 __tts[lineNumber]  → TTS 文字
  ├─ 讀取 __layout[lineNumber] → 佈局指令
  ├─ 遞增 __line_visit_count[lineNumber]（追蹤同行執行次數）
  ├─ 解析並套用 Layout 指令（sidebar/open/close/maze/ruler）
  ├─ 呼叫 graphics_instruction() → 更新容器視覺化
  └─ 呼叫 play_tts() → 播放語音
```

### 6.2 graphics_instruction()

非同步容器資料抓取流程：

```
graphics_instruction(guideText, lineNumber, funcName)
  │
  ├─ 以 extractBalancedBraces() 從文字中提取所有 {expr} token
  │
  ├─ 對每個 token 判斷：
  │   ├─ 是索引語法？ → {arr[i]} → 記錄高亮位置
  │   ├─ 是二維索引？ → {grid[i][j]} → 記錄 2D 高亮
  │   └─ 是容器名稱？ → 建立 GDB 變數 (-var-create)
  │
  ├─ Promise.all([所有 GDB 查詢]) → 等待全部完成
  │
  ├─ 對每個容器值：
  │   ├─ 判斷型別（vector/stack/map/set/...）
  │   ├─ 若為 vector：額外查詢 capacity()
  │   ├─ 若為 set/map：呼叫 fetchRBTreeData()
  │   ├─ 若有巢狀容器（inner vector）：遞迴抓取
  │   └─ 整合為統一的容器資料物件
  │
  └─ store.set('__latest_containers', containers)
      store.set('__latest_highlights', highlights)
```

**extractBalancedBraces()** 的設計要點：不使用簡單正規式，而是追蹤括號深度，支援 `{func(arr, i)}` 這類含括號的複雜表達式。

### 6.3 TTS 系統（play_tts）

**多次訪問語法（Multi-visit）**：

同一行可能在迴圈中被執行多次，TTS 支援依訪問次數播放不同文字：

```
"第一次 | 第二次 | 第三次"
```

使用 `__line_visit_count[line]` 追蹤，以 `|` 分割後選取對應段落。

**閾值語法（Threshold）**：

```
"@3 第三次以後才播放的文字"
```

表示從第三次訪問起才播放此段，之前訪問保持靜音或播放其他段。

**變數替換**：

TTS 文字中的 `{varName}` 在播放前透過 GDB 查詢替換為當前值，使語音能動態說出「現在 i 等於 5」。

**自訂發音**：

`字[音]` 語法將特定文字替換為自訂發音，如 `i[愛]` 讓系統朗讀「愛」而非英文字母 i。

**自動步進指令**：

TTS 文字中的 `[next]`、`[step-in]`、`[step-out]`、`[continue]` 在 TTS 播放完畢後自動觸發對應的 GDB 指令，實現全自動導覽播放。

**音訊 API 流程**：

```
play_tts(line, func)
  ├─ 計算本次訪問對應的文字段落
  ├─ 替換 {varName} 為實際值
  ├─ POST /tts_audio?text=... → 取得 MP3 串流
  ├─ 建立 Audio 物件播放
  ├─ 同步顯示字幕（store.set('tts_subtitle', text)）
  └─ 播放完成後執行 [next] 等自動指令
```

使用 `taskId` 系統防止競態條件：每次新的 TTS 請求產生新 taskId，舊音訊若偵測到 taskId 已改變則立即停止。

---

## 7. 步驟追蹤表格（Visualizer）

**檔案**：[gdbgui/src/js/Visualizer.tsx](gdbgui/src/js/Visualizer.tsx)

### 運作原理

Visualizer 顯示一張「程式碼 × 執行步驟」的二維表格：

```
行號 | 原始碼                | 步驟1 | 步驟2 | 步驟3
  1  | int main() {          |       |       |
  2  |   int sum = 0;        | sum=0 |       |
  3  |   for(int i=0; i<n;){ | i=0   | i=1   | i=2
  4  |     sum += i;         | sum=0 | sum=1 | sum=3
  5  | }                     |       |       |
```

- 每次程式暫停且有導覽文字時，在對應行的下一個空白欄位填入導覽輸出
- `resolveGuideText()` 負責將 `{varName}` 替換為當時的 GDB 值
- 無導覽文字的行只顯示原始碼，不佔用步驟欄

### 清除機制

程式重新執行時，`clear()` 函式會重置所有教學相關的全域狀態：
`__guide`、`__containers_guide`、`__latest_containers`、`__latest_highlights`

---

## 8. 區間尺規（RangeRuler）

**檔案**：[gdbgui/src/js/RangeRuler.tsx](gdbgui/src/js/RangeRuler.tsx)

### 用途

專為二分搜尋等「區間縮減」演算法設計的視覺化元件，以橫向尺規呈現三個變數的相對位置。

### 啟動方式

在 Layout 欄位設定：
```
ruler:low,high,mid
```

### 渲染原理

```
所有值正規化到 0%–100%：
  position(x) = (x - 0) / max * 100%

左標記（low）：藍色，顯示於 position(low)
右標記（high）：藍色，顯示於 position(high)
中間標記（mid）：紅色，顯示於 position(mid)
有效區間（low 到 high）：藍色高亮背景
```

每次程式暫停時從 `expressions` / `locals` store 讀取最新值，`max` 在 high 值增大時動態更新。

---

## 9. 編譯錯誤顯示（CompileErrors）

**檔案**：[gdbgui/src/js/CompileErrors.tsx](gdbgui/src/js/CompileErrors.tsx)

### 錯誤解析

使用正規式解析 GCC/G++ 標準錯誤輸出：

```
/path/to/file.cpp:15:8: error: 'x' was not declared in this scope
```

正規式：`^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$`

提取欄位：檔案路徑、行號、欄號、嚴重性、訊息內容。

### AI 解釋功能

點擊「AI 解釋」按鈕後：
1. 收集所有解析後的錯誤物件
2. 讀取當前原始碼內容
3. POST `/api/explain_error`（含錯誤列表 + 原始碼 + 語言）
4. 後端呼叫 LLM，回傳中文說明
5. 以對話框顯示解釋結果

---

## 10. 原始碼編輯器（SourceCode）

**檔案**：[gdbgui/src/js/SourceCode.tsx](gdbgui/src/js/SourceCode.tsx)

### 雙模式設計

**執行模式（Run Mode）**：
- Monaco Editor 顯示原始碼（唯讀）
- 左側顯示導覽輸出（步驟追蹤）
- 目前執行行高亮

**編輯模式（Edit Mode）**：
- 每行右側出現三個欄位：Guide / TTS / Layout
- 點擊 ✎ 按鈕開啟全功能編輯 modal（含預覽）
- ⠿ 拖曳把手允許拖曳換行，自動重新計算所有行號對應

### 三欄編輯 Modal

每行的編輯 modal 包含三個分頁：

| 分頁 | 功能 |
|------|------|
| 📝 Guide | 導覽文字（含 `{varName}` 替換與容器視覺化指令） |
| 🔊 TTS | 語音文字、速度設定、自動步進、預覽播放 |
| 📐 Layout | 面板開關、迷宮模式、尺規啟動、側邊欄寬度 |

### 資料持久化

三種欄位資料分別儲存於 `localStorage`，key 格式為：
- `gdbgui_guide_inputs_{檔名}_{行號}`
- `gdbgui_tts_inputs_{檔名}_{行號}`
- `gdbgui_layout_inputs_{檔名}_{行號}`

程式重新載入後自動恢復，支援匯出為 JSON 與匯入。

---

## 11. 右側面板佈局（RightSidebar）

**檔案**：[gdbgui/src/js/RightSidebar.tsx](gdbgui/src/js/RightSidebar.tsx)

### 面板系統

右側邊欄包含多個可折疊面板，教師可透過 Layout 指令動態控制其開關：

| 面板 ID | 元件 |
|---------|------|
| `visualizer` | 步驟追蹤表格 |
| `container` | STL 容器視覺化 |
| `callgraph` | 函式呼叫圖 |
| `locals` | 本地變數 |
| `watch_table` | 教學儀表板 |
| `memory_watch` | 記憶體監看 |
| `compile_errors` | 編譯錯誤 |

### 可調整高度

每個面板高度可透過滑鼠拖曳邊緣調整，使用 `mousedown` → `mousemove` → `mouseup` 事件追蹤拖曳距離並更新面板高度。

---

## 12. 除錯控制列（ControlButtons）

**檔案**：[gdbgui/src/js/ControlButtons.tsx](gdbgui/src/js/ControlButtons.tsx)

提供標準的 GDB 操作按鈕，對應 GDB/MI 指令：

| 按鈕 | GDB/MI 指令 | 功能 |
|------|------------|------|
| 執行 | `-exec-run` | 重新從頭執行 |
| 繼續 | `-exec-continue` | 繼續到下一斷點 |
| 暫停 | `signal SIGINT` | 中斷執行 |
| 下一行 | `-exec-next` | 步過（Step Over） |
| 進入 | `-exec-step` | 步入（Step Into） |
| 返回 | `-exec-finish` | 步出（Step Out） |

額外教學控制：
- **編輯模式切換**：顯示/隱藏 Guide/TTS/Layout 欄位
- **自動播放開關**：啟用後 TTS 完成自動執行下一指令
- **TTS 速度滑桿**：即時調整 0.1×–4.0× 播放速率

---

## 13. 終端機模擬（Terminals）

**檔案**：[gdbgui/src/js/Terminals.tsx](gdbgui/src/js/Terminals.tsx)

使用 **xterm.js** 在瀏覽器中模擬三個獨立終端機：

| 終端機 | 用途 |
|-------|------|
| 程式輸入 | 使用者鍵入程式的標準輸入（透過 PTY 傳送） |
| 程式輸出 | 被偵錯程式的 stdout/stderr |
| gdbgui 日誌 | GDB 原始 MI 指令與回應流 |

PTY（Pseudo-Terminal）讓程式認為自己連接在真實終端機上，使 `scanf`、`cin` 等互動式輸入函式能正常運作。

---

## 14. 動作中心（Actions）

**檔案**：[gdbgui/src/js/Actions.ts](gdbgui/src/js/Actions.ts)

集中管理所有會改變全域狀態的操作：

### 關鍵函式

**`inferior_program_paused(frame)`**：
程式暫停時的主入口，依序執行：
1. 更新堆疊框架顯示
2. 呼叫 `refresh_state_for_gdb_pause()`（取得本地變數、暫存器）
3. 呼叫 `VisualizerHelper.processing_guide(frame.line, frame.func)`

**`inferior_program_starting()`**：
程式開始執行時重置 `__line_visit_count`，確保多次執行時計數從零開始。

**`clear_program_state()`**：
清除所有動態狀態（斷點命中計數、堆疊、本地變數等）。

**TTS 控制**：
`stop_tts()`、`pause_tts()`、`resume_tts()` 透過操作 `window._tts_api` 物件控制當前音訊播放。

---

## 15. 後端伺服器（http_routes）

**檔案**：[gdbgui/server/http_routes.py](gdbgui/server/http_routes.py)

### 主要 API 端點

| 端點 | 方法 | 功能 |
|------|------|------|
| `/` | GET | 主頁面 HTML |
| `/tts_audio` | GET | 文字轉語音 MP3 串流 |
| `/api/explain_error` | POST | AI 編譯錯誤解釋 |
| `/upload` | POST | 原始碼上傳 |
| `/compile` | POST | 編譯 C/C++ 程式 |
| `/socket.io/` | WS | GDB 雙向通訊 |

### 編譯流程與安全檢查

```
POST /compile
  │
  ├─ 接收原始碼 → 寫入暫存檔
  │
  ├─ 靜態分析（Static Analysis）
  │   └─ 掃描原始碼中的危險函式呼叫
  │       ├─ 警告級：fopen/ofstream/socket → 提示訊息
  │       └─ 封鎖級：system/fork/exec* → 拒絕編譯
  │
  ├─ GCC/G++ 編譯
  │   └─ 加上 -Wl,--wrap=system,--wrap=fork,... 參數
  │       （連結器層攔截危險函式，替換為返回 EPERM 的 stub）
  │
  ├─ 設定沙箱環境 _setup_jail()
  │
  └─ GDB 載入編譯後的二進位檔
```

### TTS 端點

`/tts_audio?text=...` 接收文字字串，呼叫後端 TTS 引擎（支援 Google TTS / Azure 等），以串流方式回傳 MP3 音訊資料，前端使用 `Audio` 物件直接播放。

---

## 16. 安全沙箱（jail_manager）

**檔案**：[gdbgui/server/sandbox/jail_manager.py](gdbgui/server/sandbox/jail_manager.py)

### 三層防護架構

本系統在公開環境執行使用者上傳的 C++ 程式，需防範惡意程式碼：

**第一層：靜態分析**

在編譯前掃描原始碼，偵測危險函式呼叫（`system`、`popen`、`fork`、`exec*` 等），若發現則拒絕或警告。

**第二層：連結器包裝（Linker Wrapping）**

使用 GCC 連結選項 `-Wl,--wrap=system` 將危險函式重新導向至安全 stub：

```c
// 編譯時自動注入的 stub
int __wrap_system(const char *cmd) { errno = EPERM; return -1; }
pid_t __wrap_fork() { errno = EPERM; return -1; }
```

即使程式中呼叫了 `system()`，實際執行的是上述 stub，直接返回錯誤。

**第三層：資源限制（ulimit）**

透過包裝腳本在執行前設定：

| 資源 | 限制 |
|------|------|
| 檔案寫入 | 512 KB |
| 子行程數 | 64 個 |
| CPU 時間 | 30 秒 |
| 虛擬記憶體 | 512 MB |

### Chroot Jail（需 root）

當伺服器以 root 執行時，可建立完整的 chroot 隔離環境：

```
<jail_dir>/
├── app/          ← 使用者二進位檔
├── lib/          ← bind-mount 共享函式庫（唯讀）
├── lib64/
├── usr/
├── tmp/          ← 唯一可寫目錄
├── dev/          ← 必要裝置節點（null, zero, urandom）
└── proc/         ← 掛載 procfs
```

非 root 模式退回僅 ulimit 限制（仍可配合 GDB 運作）。

---

## 17. 完整資料流程

以下是從教師設定導覽到學生看到視覺化的完整鏈路：

```
【教師設定階段】
  1. 教師在 Edit Mode 的 Guide 欄位輸入：
     "現在 i={i}，把 {arr[i]} 加進 {stk}"
     └→ 存入 localStorage（gdbgui_guide_inputs_main.cpp_5）

  2. TTS 欄位輸入：
     "現在 i 是 {i}，把陣列第{i}個元素推入堆疊"
     └→ 存入 localStorage（gdbgui_tts_inputs_main.cpp_5）

  3. Layout 欄位輸入：
     "sidebar:40 open:container"
     └→ 存入 localStorage（gdbgui_layout_inputs_main.cpp_5）

【學生執行階段】
  4. 學生點擊「下一行」→ GdbApi.run_gdb_command('-exec-next')

  5. GDB 執行並回傳 *stopped，frame={line:5, func:main}

  6. process_gdb_response() 偵測到程式暫停
     └→ Actions.inferior_program_paused({line:5, func:'main'})

  7. VisualizerHelper.processing_guide(5, 'main')
     ├─ 讀取 __line[5] = "現在 i={i}，..."
     ├─ 讀取 __tts[5]  = "現在 i 是 {i}，..."
     ├─ 讀取 __layout[5] = "sidebar:40 open:container"
     │
     ├─ 套用 Layout → 右側邊欄調為 40%，開啟容器面板
     │
     ├─ graphics_instruction("現在 i={i}，把 {arr[i]} 加進 {stk}")
     │   ├─ 提取 token：i, arr[i], stk
     │   ├─ GDB 查詢 i → 3
     │   ├─ GDB 查詢 arr → [10,20,30,40,50]，高亮索引 3
     │   ├─ GDB 查詢 stk → stack{10,20,30}
     │   └─ store.set('__latest_containers', {arr:[...], stk:[...]})
     │       store.set('__latest_highlights', {arr:3})
     │
     └─ play_tts(5, 'main')
         ├─ 替換 {i} → "3"
         ├─ POST /tts_audio?text="現在i是3，把陣列第3個元素推入堆疊"
         └─ 播放 MP3，同步顯示字幕

  8. ContainerVisualizer 偵測到 __latest_containers 更新
     └→ 渲染 arr 橫向格線（第 3 格高亮）+ stk 堆疊形狀

  9. Visualizer 在步驟追蹤表格的行 5 填入：
     "現在 i=3，把 30 加進 stk"
```

---

## 18. 教學導覽語法設計

### Guide 語法

| 語法 | 說明 | 範例 |
|------|------|------|
| `{varName}` | 替換為變數當前值 | `i={i}` → `i=3` |
| `{arr}` | 渲染整個容器 | 顯示 vector 格線 |
| `{arr[i]}` | 渲染容器並高亮索引 i | 第 i 格黃色高亮 |
| `{grid[i][j]}` | 高亮二維陣列 (i,j) | 矩陣格子高亮 |
| `[label#color]` | 設定呼叫圖標籤與顏色 | `[遞迴#red]` |
| `[speed:N]` | 設定播放速度 | `[speed:2]` 兩倍速 |
| `\n` | 換行（多行導覽） | 顯示多行說明 |

### TTS 語法

| 語法 | 說明 | 範例 |
|------|------|------|
| `{varName}` | 朗讀變數值 | `i 等於 {i}` |
| `字[音]` | 自訂發音 | `i[愛]` |
| `A \| B \| C` | 依訪問次數選段 | 第 1/2/3 次各讀不同文字 |
| `@N text` | 從第 N 次訪問起讀 | `@3 從第三次起說` |
| `[next]` | TTS 結束後自動下一行 | 自動步過 |
| `[step-in]` | TTS 結束後自動步入 | 自動步入函式 |
| `[continue]` | TTS 結束後繼續執行 | 跳到下一斷點 |
| `[speed:N]` | 控制 TTS 速率 | `[speed:1.5]` |

### Layout 語法

| 語法 | 說明 |
|------|------|
| `sidebar:N` | 右側欄寬度百分比（0–99） |
| `open:panel1,panel2` | 展開指定面板 |
| `close:panel1` | 折疊指定面板 |
| `maze:containerName` | 對指定容器啟用迷宮視覺化 |
| `ruler:low,high,mid` | 啟用區間尺規並指定三變數 |

面板 ID 對照：
`compile_errors`、`memory_watch`、`callgraph`、`visualizer`、`container`、`locals`、`watch_table`

---

*本文件由 Claude Code 自動生成，依據原始碼分析結果撰寫，版本對應 Develop 分支（2026-05-06）。*
