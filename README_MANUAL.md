# CPPcodeVisualizer 使用說明書

> **適用對象**：本說明書供使用者操作參考，亦可供大型語言模型（LLM）學習本專案結構、功能與使用方式。

---

## 目錄

1. [專案簡介](#1-專案簡介)
2. [系統架構](#2-系統架構)
3. [環境需求與安裝](#3-環境需求與安裝)
4. [啟動方式](#4-啟動方式)
5. [使用者介面說明](#5-使用者介面說明)
6. [核心功能詳解](#6-核心功能詳解)
   - 6.1 [上傳與編譯 C/C++ 程式](#61-上傳與編譯-cc-程式)
   - 6.2 [除錯控制按鈕](#62-除錯控制按鈕)
   - 6.3 [Call Graph（歷史呼叫圖）](#63-call-graph歷史呼叫圖)
   - 6.4 [Container Visualizer（容器視覺化）](#64-container-visualizer容器視覺化)
   - 6.5 [Memory Watch（記憶體與指標追蹤）](#65-memory-watch記憶體與指標追蹤)
   - 6.6 [Teaching Dashboard（教學儀表板）](#66-teaching-dashboard教學儀表板)
   - 6.7 [Visualizer（客製化視覺化）](#67-visualizer客製化視覺化)
   - 6.8 [Local Variables（區域變數）](#68-local-variables區域變數)
   - 6.9 [Breakpoints（中斷點）](#69-breakpoints中斷點)
   - 6.10 [指導語法與 TTS 語音播報](#610-指導語法與-tts-語音播報)
   - 6.11 [Layout 控制欄位](#611-layout-控制欄位)
   - 6.12 [迷宮模式教案（BFS Maze Lesson）](#612-迷宮模式教案bfs-maze-lesson)
7. [右側面板說明](#7-右側面板說明)
8. [CLI 命令列參數](#8-cli-命令列參數)
9. [後端 API 路由說明](#9-後端-api-路由說明)
10. [前端元件架構](#10-前端元件架構)
11. [自訂 Call Graph 標籤（進階）](#11-自訂-call-graph-標籤進階)
12. [鍵盤快捷鍵](#12-鍵盤快捷鍵)
13. [常見問題 FAQ](#13-常見問題-faq)
14. [專案目錄結構](#14-專案目錄結構)

---

## 1. 專案簡介

**CPPcodeVisualizer** 是一個以瀏覽器為介面的 C/C++ 程式碼執行視覺化工具，基於 [gdbgui](https://github.com/cs01/gdbgui) 開發。它提供：

- 以瀏覽器操作 GNU Debugger（GDB）
- 即時視覺化 C/C++ 資料結構（`vector`、`queue`、`stack`、`list`、`deque`、字串、二維陣列等）
- 動態呼叫圖（Call Graph），可即時觀察程式函式呼叫的歷史紀錄與當前執行狀態
- 記憶體與指標追蹤（Memory Watch）
- 教學儀表板（WatchTable），方便教學展示
- 直接上傳 C/C++ 原始碼，自動編譯並開始除錯

**技術棧**：
- **後端**：Python 3、Flask、Flask-SocketIO、pygdbmi
- **前端**：React（TypeScript/TSX）、vis.js（Call Graph 渲染）
- **通訊**：WebSocket（Socket.IO）

---

## 2. 系統架構

```
瀏覽器（使用者）
    ↕ HTTP / WebSocket
Python Flask 伺服器（gdbgui/server/）
    ↕ stdio
GDB 子行程（GNU Debugger）
    ↕
被除錯的 C/C++ 可執行檔
```

### 後端組成

| 檔案 | 功能 |
|------|------|
| `gdbgui/cli.py` | 命令列入口點（`gdbgui` 指令） |
| `gdbgui/server/app.py` | Flask App 與 SocketIO 初始化 |
| `gdbgui/server/http_routes.py` | HTTP 路由（上傳、編譯、頁面渲染等） |
| `gdbgui/server/sessionmanager.py` | GDB 會話管理（每個 WebSocket 對應一個 GDB 子行程） |
| `gdbgui/server/server.py` | 伺服器啟動邏輯 |
| `gdbgui/server/constants.py` | 常數定義（預設 port、host 等） |

### 前端組成（`gdbgui/src/js/`）

| 元件 | 功能 |
|------|------|
| `gdbgui.tsx` | 應用程式根元件 |
| `TopBar.tsx` | 頂部工具列（控制按鈕、設定） |
| `ControlButtons.tsx` | 執行控制按鈕（Run/Continue/Next/Step/Return） |
| `RightSidebar.tsx` | 右側面板（含所有視覺化工具） |
| `CallGraph.tsx` | 函式呼叫圖視覺化（使用 vis.js） |
| `ContainerVisualizer.tsx` | STL 容器視覺化 |
| `MemoryWatch.tsx` | 記憶體與指標追蹤 |
| `WatchTable.tsx` | 教學儀表板（Watch 表格） |
| `Visualizer.tsx` | 客製化視覺化 |
| `Locals.tsx` | 區域變數列表 |
| `Breakpoints.tsx` | 中斷點管理 |
| `GdbApi.tsx` | 與後端 GDB 的通訊介面 |
| `SourceCode.tsx` | 原始碼顯示與中斷點設定 |
| `process_gdb_response.tsx` | 解析 GDB MI 輸出並更新 UI 狀態 |

---

## 3. 環境需求與安裝

### 系統需求

- **作業系統**：Linux（建議）、macOS、Windows（需 MinGW 或 Cygwin）
- **Python**：3.7 以上
- **Node.js**：16 以上（僅開發時需要）
- **GDB**：GNU Debugger（需安裝於系統 PATH）
- **編譯器**：`g++`（C++）或 `gcc`（C）

### Linux 安裝依賴

```bash
sudo apt install gdb g++ python3 python3-pip
```

### macOS 安裝依賴

```bash
brew install python3 gdb
# 注意：macOS 上需要對 gdb 進行 codesign
```

### Windows 安裝依賴

建議使用 [MinGW](http://mingw.org/) 安裝 `gdb`、`g++`、`make`，並將 `C:\MinGW\bin\` 加入系統 PATH。

### 安裝 Python 依賴

```bash
# 在專案根目錄執行
pip install -r requirements.txt
```

或使用 pipx 安裝（若作為套件使用）：

```bash
pipx install gdbgui
```

### 安裝前端依賴（開發模式）

```bash
npm install
# 或
yarn install
```

---

## 4. 啟動方式

### 方式一：直接執行（推薦）

```bash
# 在專案根目錄執行
python -m gdbgui
```

或若已安裝為套件：

```bash
gdbgui
```

啟動後，瀏覽器將自動開啟 `http://localhost:5000`。

### 方式二：指定埠號

```bash
python -m gdbgui --port 8080
```

### 方式三：遠端存取模式

```bash
python -m gdbgui --remote
# 監聽 0.0.0.0，允許從其他機器連入
# 警告：建議同時設定認證
```

### 方式四：直接載入可執行檔

```bash
python -m gdbgui ./my_program
# 或帶參數
python -m gdbgui './my_program arg1 arg2'
```

### 方式五：開發模式（前後端熱重載）

```bash
# 終端 1（後端）
python -m gdbgui --debug

# 終端 2（前端，webpack 監聽模式）
npm run dev
# 或
yarn dev
```

---

## 5. 使用者介面說明

開啟瀏覽器後，介面分為三個主要區域：

```
┌────────────────────────────────────────────────────┐
│  TopBar（頂部工具列）：控制按鈕、設定齒輪、選單      │
├─────────────────────────────┬──────────────────────┤
│                             │  右側面板（RightSidebar）│
│  SourceCode（原始碼區）      │  - Memory Watch       │
│                             │  - Call Graph         │
│                             │  - Visualizer         │
│                             │  - Container          │
│                             │  - Local Variables    │
│                             │  - Teaching Dashboard │
│                             │  - Breakpoints        │
├─────────────────────────────┴──────────────────────┤
│  Terminal / GDB Console（底部終端機輸出）            │
└────────────────────────────────────────────────────┘
```

---

## 6. 核心功能詳解

### 6.1 上傳與編譯 C/C++ 程式

本專案自訂了一個上傳頁面（`/upload`），使用者可以：

1. 連至 `http://localhost:5000/upload`
2. 上傳 `.cpp`、`.c`、`.cc`、`.cxx` 等 C/C++ 原始碼檔
3. 伺服器自動用 `g++ -g -O0` 編譯成可執行檔
4. 編譯成功後自動重導向回除錯主頁（`/`）

#### 直接貼上程式碼（API）

透過 POST 請求至 `/create_and_upload`：

```
POST /create_and_upload
Content-Type: application/x-www-form-urlencoded

code=<C++原始碼>&filepath=<可選的本機路徑>&program_input=<標準輸入>
```

- 若 `filepath` 存在且有效，直接修改該檔案並重新編譯
- 若未指定，自動生成唯一檔案名稱並儲存至 `gdbgui/server/uploads/`
- `program_input` 會寫入對應的 `.in` 檔案，供程式讀取標準輸入

#### 預設程式

若瀏覽器尚未載入任何程式，伺服器會自動生成並編譯一個 Hello World 範例，方便使用者立即操作。

---

### 6.2 除錯控制按鈕

位於 TopBar 右側，提供以下按鈕：

| 按鈕圖示 | 功能 | 鍵盤快捷鍵 |
|-----------|------|-----------|
| ↺ (Repeat) | **Run**：從頭執行程式 | `r` |
| ▶ (Play) | **Continue**：繼續執行至下一個中斷點 | `c` |
| ⏸ (Pause) | **Interrupt**：暫停正在執行的程式（傳送 SIGINT） | — |
| ⏭ (Step Forward) | **Next**：執行下一行（不進入函式） | `n` 或 `→` |
| ↓ (Arrow Down) | **Step**：執行下一行（進入函式） | `s` 或 `↓` |
| ↑ (Arrow Up) | **Return**：執行到目前函式返回 | `u` 或 `↑` |

> **注意**：若 GDB 支援反向除錯（如使用 `rr replay`），可以按住 `Shift` 鍵搭配上述快捷鍵進行反向操作。

---

### 6.3 Call Graph（歷史呼叫圖）

**位置**：右側面板 → "call graph (歷史呼叫圖)"（可折疊）

**功能**：以有向圖（Directed Acyclic Graph）的形式，即時顯示程式執行過程中的函式呼叫歷史。

#### 節點內容

每個節點顯示：
- **函式名稱**與**參數（含值）**，例如：`findMax(arr=..., n=5)`
- **目前行號**，例如：`Line: 42`
- **區域變數**（僅當前執行節點顯示）

#### 節點顏色意義

| 顏色 | 意義 |
|------|------|
| 灰白（#ecf0f1） | 歷史呼叫過的函式（非當前） |
| 黃色（#f1c40f） | 目前正在執行的函式（Active Node） |
| 綠色 | 自訂標籤設為 green |
| 紅色 | 自訂標籤設為 red |
| 藍色 | 自訂標籤設為 blue |

#### 互動操作

- 可拖曳節點調整位置
- 可縮放（滾輪）與平移（拖曳背景）
- 當節點數量變化或當前節點改變時，自動 focus 到當前節點

---

### 6.4 Container Visualizer（容器視覺化）

**位置**：右側面板 → "container"（可折疊）

**功能**：以視覺化方式呈現 C++ STL 容器或陣列的當前狀態。

#### 支援的資料結構

| 類型 | 視覺化樣式 |
|------|-----------|
| `vector` | 橫向方格陣列，顯示 Size 與 Capacity，未使用容量以虛線框表示 |
| `array` | 橫向方格陣列 |
| `string` | 橫向方格陣列，字元加上單引號 |
| `list` | 圓角節點串，以 ↔ 符號連接（雙向鏈結串列） |
| `stack` | 橫向排列，左端為頂部，以紅色框線表示 |
| `queue` | 橫向排列，以綠色框線與 ← 符號表示進出方向 |
| `deque` | 橫向排列，以紫色框線與 ↔ 符號表示 |
| `2D vector / 2D array` | 方格矩陣形式 |

#### 高亮顯示

若程式提供 `__latest_highlights` 資訊，對應索引的元素會以**黃色背景**高亮顯示，方便追蹤當前操作的元素（例如排序演算法正在比較的兩個元素）。

#### 迷宮模式（Maze Mode）

當容器為**二維整數陣列**（`vector<vector<int>>` 或 `int[][N]`）時，可切換為**迷宮格線模式**，將每個數值以彩色方格呈現，便於教學展示 BFS、DFS 等路徑搜尋演算法。

##### 啟用方式

- 在 Container Visualizer 中，當偵測到二維陣列時，標題列右側會出現 **☐ 迷宮模式** 核取框。
- 勾選後，該容器以彩色方格矩陣顯示。
- 也可透過 Layout 欄位中的 `maze:` 指令**自動開啟**（詳見 [6.11 Layout 控制欄位](#611-layout-控制欄位)）。

##### 固定顏色規則

| 數值 | 顏色 | 語意（慣例） |
|------|------|-------------|
| `0` | 白色 | 可通行的地板 |
| `1` | 深灰 / 黑色 | 牆壁 |

> `0` 與 `1` 的顏色為固定值，無法修改。

##### 自訂顏色規則

對於 `0` 與 `1` 以外的數值，可在迷宮模式啟用後，於顏色規則編輯器中新增規則：

1. 在「數值」欄位輸入整數（例如 `2`）
2. 在「顏色」選色器選取顏色（例如金黃色代表最短路徑）
3. 按 **新增規則** 按鈕確認
4. 已新增的規則可按 **×** 刪除

若某數值沒有對應規則，預設以**灰色**顯示。

**常見用法範例（BFS 迷宮）**：

| 數值 | 建議顏色 | 語意 |
|------|---------|------|
| `2` | 金黃 `#FFD700` | BFS 最短路徑 |
| `3` | 天藍 `#87CEEB` | BFS 已探索區域 |

---

### 6.5 Memory Watch（記憶體與指標追蹤）

**位置**：右側面板 → "記憶體與指標追蹤 (Memory Watch)"（可折疊）

**功能**：追蹤指定變數的記憶體位址與其指向的值，適合觀察指標、動態記憶體的使用情形。

---

### 6.6 Teaching Dashboard（教學儀表板）

**位置**：右側面板 → "teaching dashboard (table)"（可折疊）

**功能**：以表格形式列出使用者設定的 Watch 變數，適合教學場景中同時觀察多個關鍵變數的值變化。

---

### 6.7 Visualizer（客製化視覺化）

**位置**：右側面板 → "visualizer"（可折疊）

**功能**：提供客製化的資料視覺化，可依照程式提供的視覺化資料，繪製特定圖形或標記。

---

### 6.8 Local Variables（區域變數）

**位置**：右側面板 → "local variables"（可折疊，預設摺疊）

**功能**：顯示目前執行函式中所有的區域變數名稱與值，等同於 GDB 的 `info locals` 指令。

---

### 6.9 Breakpoints（中斷點）

**位置**：右側面板 → "breakpoints"（可折疊，預設摺疊）

**功能**：
- 列出所有已設定的中斷點
- 可啟用/停用或刪除中斷點
- 點擊原始碼行號可直接設定/移除中斷點

---

### 6.10 指導語法與 TTS 語音播報

在「SourceCode（原始碼區）」的每一行前方，有兩個輸入框：**Guide**（指導語法）與 **TTS**（語音播報）。這兩個欄位能讓使用者在程式執行到該行時，觸發特定的視覺化效果或發出語音提示，非常適合教學與演算法展示。

#### 1. 指導語法 (Guide) 欄位

在該行的 **Guide** 欄位中輸入特定語法，可用於動態監看變數、操作 Call Graph 的節點顏色與標籤，或渲染特定的 STL 容器。

**支援的語法與功能**：

*   **動態監看變數或容器**
    *   **語法**：`{變數名稱}`
    *   **範例**：`{sum}` 或 `{myVector}`
    *   **效果**：執行到該行時，會自動在 Memory Watch 與 Teaching Dashboard 中監看該變數。若變數為 STL 容器（如 `vector`、`queue`、`list` 等）或陣列，則會在 **Container Visualizer** 中渲染對應的圖形。
*   **容器索引高亮**
    *   **語法**：`{容器名稱[索引變數]}` 或 `{容器名稱[常數索引]}`
    *   **範例**：`{arr[i]}` 或 `{myVector[0]}`
    *   **效果**：除了會將 `arr` 顯示於 Container Visualizer 中之外，還會將索引 `i` 指定的元素以**黃色背景高亮**顯示。這在展示排序演算法（如 Bubble Sort 正在比較的兩個元素）時非常實用。
*   **客製化 Call Graph 節點 (標籤與顏色)**
    *   **語法**：`[自訂標籤名稱#顏色] {變數1} {變數2}` 或 `[自訂標籤名稱] {變數}`
    *   **範例**：`[初始化#red] {i}` 或 `[計算總和#green] {sum}`
    *   **效果**：當程式執行到該行，Call Graph 上的當前節點會變成指定的顏色（如 `red`, `green`, `blue` 或 CSS 顏色碼），且節點標題會改為自訂的標籤名稱，並在節點內顯示所選變數的當前數值。

#### 2. TTS 語音播報 (TTS) 欄位

在該行的 **TTS** 欄位中輸入特定語法，程式碼執行到該行時，會透過瀏覽器的 Web Speech API 播放中文合成語音，並在原始碼旁顯示對話泡泡字幕。

**支援的語法與功能**：

*   **靜態文字播報**
    *   **語法**：直接輸入文字
    *   **範例**：`開始執行排序`
    *   **效果**：念出「開始執行排序」並顯示字幕。
*   **動態變數數值播報**
    *   **語法**：輸入 `{變數名稱}` 結合文字
    *   **範例**：`目前的總和是 {sum}`
    *   **效果**：程式會去抓取 `sum` 當下的值。如果 `sum` 是 15，則會念出「目前的總和是 15」並顯示字幕。
*   **客製讀音轉換**
    *   **語法**：`顯示字[發音]`
    *   **範例**：`白[柏]起打了一套拳`
    *   **效果**：字幕上會顯示正確的字 `白起打了一套拳`，但語音合成時會念括號內的發音 `柏起打了一套拳`。這對於某些破音字或不支援的符號非常有用。

---

### 6.11 Layout 控制欄位

在每一行的 **Layout** 欄位（與 Guide/TTS 並列）中，可輸入以空格分隔的 `key:value` 指令，當程式執行到該行時，系統會自動調整介面佈局。

#### 支援的 Layout 指令

| 指令 | 說明 | 範例 |
|------|------|------|
| `sidebar:<寬度百分比>` | 設定右側面板佔視窗的寬度百分比（整數） | `sidebar:55` |
| `open:<容器名稱>` | 展開指定名稱的 Collapser 面板 | `open:container maze` |
| `close:<容器名稱>` | 折疊指定名稱的 Collapser 面板 | `close:local variables` |
| `maze:<容器變數名稱>` | **自動啟用迷宮模式**，並可指定多個容器（逗號分隔） | `maze:main::maze` |

#### `maze:` 指令詳細說明

`maze:containerName` 會呼叫全域函式 `window.gdbgui_set_maze_mode(containerName, true)`，將 Container Visualizer 中對應名稱的容器切換至迷宮顯示模式。

- `containerName` 格式通常為 `<函式名稱>::<變數名稱>`，例如：`main::maze`
- 可同時指定多個容器，以逗號分隔：`maze:main::maze,main::grid`

#### 範例

```
open:container maze sidebar:55 maze:main::maze
```

**效果**：
1. 展開名稱包含 "container maze" 的面板
2. 將右側面板寬度設為 55%
3. 自動將 `main::maze` 容器切換為迷宮模式

> **建議搭配使用**：在 BFS 迷宮教學中，在宣告 `maze` 變數的那一行設定此 Layout 指令，讓迷宮一初始化就自動以彩色方格呈現。

---

### 6.12 迷宮模式教案（BFS Maze Lesson）

本專案內建一個完整的「BFS 走迷宮」教學教案，檔案位於 `docs/maze_bfs_lesson.json`。

#### 教案內容

- **原始碼**：`maze_gen.cpp`（包含迷宮生成 + BFS 解題）
  - 使用遞迴 DFS 生成完美迷宮（`MazeGenerator::generate`）
  - 使用 BFS 尋找最短路徑（`solveMaze`）
  - 迷宮數值語意：`0`=通道、`1`=牆壁、`2`=最短路徑、`3`=BFS 已探索
- **預設輸入**：`21 21` + seed `42`（21×21 迷宮，固定亂數種子）
- **備用輸入**：11×11（較小）、31×31（較大，隨機種子）

#### 關鍵行號說明

| 行號 | 程式碼 | 教學重點 |
|------|--------|---------|
| 17 | `carve(maze, 1, 1, rng)` | DFS 遞迴生成迷宮 |
| 25 | `maze[r][c] = 0` | 標記目前格為可通行 |
| 44 | `bool solveMaze(...)` | BFS 求解入口 |
| 55 | `q.push(start)` | 初始化 BFS 起點 |
| 62 | `while (!q.empty() && !found)` | BFS 主迴圈 |
| 64 | `maze[r][c] = 3` | 標記已探索格（可在迷宮中看到藍色展開） |
| 74 | `q.push({nr, nc})` | 將鄰近可走格加入佇列 |
| 80 | `if (found)` | 開始回溯最短路徑 |
| 83 | `maze[r][c] = 2` | 標記最短路徑格（金黃色） |

#### 如何載入教案

1. 在介面上方選單選擇「載入 JSON 教案」（或相關 API）
2. 選取 `docs/maze_bfs_lesson.json`
3. 系統自動：
   - 載入 `maze_gen.cpp` 原始碼並編譯
   - 設定程式輸入（`21 21` + seed `42`）
   - 在各關鍵行填入 Guide、TTS 語音說明
   - 執行到迷宮初始化行時，自動展開 Container 面板並啟用迷宮模式

#### 建議顏色設定

載入教案後，在 Container Visualizer 的迷宮顏色規則編輯器中新增：

| 數值 | 顏色代碼 | 說明 |
|------|---------|------|
| `2` | `#FFD700` | BFS 最短路徑（金黃） |
| `3` | `#87CEEB` | BFS 已探索（天藍） |

---

## 7. 右側面板說明

右側面板（`RightSidebar`）包含多個可折疊區塊（`Collapser`）。每個區塊都可以：

- **點擊標題列**：展開或摺疊內容
- **拖曳下緣分隔條**：調整該區塊的高度
- **點擊 "reset height"**：恢復自動高度

面板預設狀態：

| 面板名稱 | 預設狀態 |
|---------|---------|
| 記憶體與指標追蹤 | 展開 |
| Call Graph | 展開 |
| Visualizer | 展開 |
| Container | 展開 |
| Local Variables | **摺疊** |
| Teaching Dashboard | 展開 |
| Breakpoints | **摺疊** |

---

## 8. CLI 命令列參數

執行 `python -m gdbgui --help` 或 `gdbgui --help` 可查看所有參數。

### GDB 設定

| 參數 | 說明 | 預設值 |
|------|------|--------|
| `-g`, `--gdb-cmd` | 指定 GDB 執行檔路徑與參數 | `gdb` |

### 網路設定

| 參數 | 說明 | 預設值 |
|------|------|--------|
| `-p`, `--port` | 監聽埠號 | `5000` |
| `--host` | 監聽 IP 位址 | `127.0.0.1` |
| `-r`, `--remote` | 遠端模式（host 設為 0.0.0.0，不自動開啟瀏覽器） | — |

### 安全設定

| 參數 | 說明 |
|------|------|
| `--auth-file` | 指定含有帳號/密碼的文字檔（HTTP Basic Auth） |
| `--user` | 認證帳號 |
| `--password` | 認證密碼 |
| `--key` | SSL 私鑰路徑 |
| `--cert` | SSL 憑證路徑 |

### 其他設定

| 參數 | 說明 |
|------|------|
| `--remap-sources` | 重新對應原始碼路徑（JSON 格式），例如：`'{"build_path": "local_path"}'` |
| `--project` | 設定專案根目錄（影響資料夾面板的相對路徑顯示） |
| `-v`, `--version` | 顯示版本號 |
| `-n`, `--no-browser` | 不自動開啟瀏覽器 |
| `-b`, `--browser` | 指定瀏覽器執行檔 |
| `--debug` | Flask debug 模式（修改伺服器檔案時自動重載） |

### 位置參數

```bash
# 直接指定可執行檔
gdbgui ./my_program

# 帶額外參數（包含 flag 時使用 --args）
gdbgui --args ./my_program arg1 -flag1 -flag2
```

---

## 9. 後端 API 路由說明

| HTTP 方法 | 路由 | 說明 |
|-----------|------|------|
| `GET` | `/` | 主要除錯介面（若無程式會自動建立 Hello World） |
| `GET/POST` | `/upload` | 上傳 C/C++ 原始碼或可執行檔並編譯 |
| `POST` | `/create_and_upload` | 提交程式碼字串，儲存並編譯，支援 JSON 回傳 |
| `GET` | `/read_file` | 讀取本機原始碼檔案（含語法高亮） |
| `GET` | `/dashboard` | 列出所有活躍的 GDB 會話 |
| `GET` | `/dashboard_data` | 取得 GDB 會話資訊（JSON） |
| `PUT` | `/kill_session` | 終止指定的 GDB 會話 |
| `POST` | `/send_signal_to_pid` | 傳送系統信號至指定 PID |
| `GET` | `/get_last_modified_unix_sec` | 取得檔案最後修改時間 |

---

## 10. 前端元件架構

```
gdbgui.tsx（根元件）
├── TopBar.tsx
│   ├── BinaryLoader.tsx（載入二進位檔按鈕）
│   ├── ControlButtons.tsx（偵錯控制按鈕）
│   └── Settings.tsx（設定齒輪）
├── MiddleLeft.tsx（中間左側：檔案系統）
│   └── FoldersView.tsx
├── SourceCode.tsx（原始碼顯示區）
│   └── SourceFileAutocomplete.tsx
├── RightSidebar.tsx（右側視覺化面板）
│   ├── MemoryWatch.tsx
│   ├── CallGraph.tsx（vis.js 呼叫圖）
│   ├── Visualizer.tsx（客製化視覺化）
│   ├── ContainerVisualizer.tsx（STL 容器視覺化）
│   ├── Locals.tsx（區域變數）
│   ├── WatchTable.tsx（教學儀表板）
│   └── Breakpoints.tsx（中斷點管理）
└── Terminals.tsx（底部終端機）
```

### 狀態管理

本專案使用 `statorgfc` 函式庫進行全域狀態管理，主要狀態定義於 `InitialStoreData.ts`：

| 狀態鍵值 | 說明 |
|---------|------|
| `paused_on_frame` | 目前暫停的函式框架資訊 |
| `locals` | 當前函式的區域變數列表 |
| `expressions` | 使用者監看的表達式列表 |
| `call_graph_updated` | Call Graph 更新計數器（觸發重繪） |
| `breakpoints` | 中斷點列表 |
| `threads` | 執行緒列表 |
| `source_code_state` | 原始碼顯示狀態 |
| `waiting_for_response` | 是否等待 GDB 回應（顯示 spinner） |

---

## 11. 自訂 Call Graph 標籤（進階）

透過設定 `window.gdbgui_global_variable.__call_graph_custom_labels`，可以為特定行號的 Call Graph 節點設定自訂標籤、顯示變數與顏色。

### 格式

```javascript
window.gdbgui_global_variable.__call_graph_custom_labels = {
    "42": {
        labelName: "排序中",       // 節點主標題
        vars: ["i", "j", "arr"],  // 要顯示的變數名稱列表
        color: "green"            // 節點顏色："green", "red", "blue", 或 CSS 顏色字串
    },
    "55": {
        labelName: "比較元素",
        vars: ["a", "b"],
        color: "#ff5733"
    }
};
```

### 說明

- `labelName`：當程式執行到該行號時，節點標題會改為此字串（取代預設的函式名稱）
- `vars`：會先嘗試以 `函式名稱::變數名稱` 查找當前 scope 的值，找不到則用 `變數名稱` 查找
- `color`：支援 `"green"`、`"red"`、`"blue"` 或任意 CSS 顏色值

---

## 12. 鍵盤快捷鍵

| 按鍵 | 功能 |
|------|------|
| `r` | Run（從頭執行） |
| `c` | Continue（繼續至下一個中斷點） |
| `n` 或 `→` | Next（下一行，不進入函式） |
| `s` 或 `↓` | Step（下一行，進入函式） |
| `u` 或 `↑` | Return（執行至函式返回） |
| `Shift + r/c/n/s/u` | 對應的**反向**操作（需 GDB 支援，如 `rr replay`） |

---

## 13. 常見問題 FAQ

### Q1：啟動後瀏覽器顯示空白或「No container data available」

**A**：這是正常的初始狀態。需要先載入程式並執行，才會有資料出現在各視覺化面板中。

### Q2：上傳 C++ 檔案後顯示「Compilation failed」

**A**：
1. 確認系統已安裝 `g++`：`g++ --version`
2. 確認程式碼沒有語法錯誤
3. 查看錯誤訊息中的 `stderr` 欄位，即為 `g++` 的編譯錯誤輸出

### Q3：macOS 上 GDB 出現「please check gdb is codesigned」

**A**：需要對 GDB 進行 codesign，詳見 [官方說明](http://andresabino.com/2015/04/14/codesign-gdb-on-mac-os-x-yosemite-10-10-2/)。

### Q4：Windows 上無法啟動

**A**：注意原版 gdbgui 僅在 0.14 以前支援 Windows。本專案在 Windows 上建議使用 WSL（Windows Subsystem for Linux）執行，或透過 MinGW 環境。

### Q5：Call Graph 出現後圖形大小異常（圖太小或空白）

**A**：嘗試展開/摺疊 Call Graph 面板一次，`ResizeObserver` 會自動偵測容器尺寸並重新渲染。

### Q6：遠端使用時安全注意事項

**A**：使用 `--remote` 或設定 `host=0.0.0.0` 時，務必搭配 `--auth-file` 或 `--user`/`--password` 參數啟用 HTTP Basic Auth，並建議使用 SSL（`--key` 與 `--cert`）。

---

## 14. 專案目錄結構

```
CPPcodeVisualizer/
├── gdbgui/                       # 主要套件目錄
│   ├── __init__.py               # 版本號定義
│   ├── __main__.py               # python -m gdbgui 入口
│   ├── cli.py                    # 命令列介面（argparse）
│   ├── server/                   # Flask 後端
│   │   ├── app.py                # Flask App 與 Socket.IO 設定
│   │   ├── http_routes.py        # HTTP 路由（上傳、編譯、頁面）
│   │   ├── sessionmanager.py     # GDB 會話管理
│   │   ├── server.py             # 伺服器啟動
│   │   ├── constants.py          # 常數（預設 port、host 等）
│   │   └── uploads/              # 上傳的原始碼與編譯後的可執行檔（執行期自動清理）
│   ├── src/
│   │   └── js/                   # React 前端原始碼（TypeScript/TSX）
│   │       ├── gdbgui.tsx        # 根元件
│   │       ├── TopBar.tsx        # 頂部工具列
│   │       ├── ControlButtons.tsx # 控制按鈕
│   │       ├── RightSidebar.tsx  # 右側面板
│   │       ├── CallGraph.tsx     # 呼叫圖視覺化
│   │       ├── ContainerVisualizer.tsx # STL 容器視覺化
│   │       ├── MemoryWatch.tsx   # 記憶體追蹤
│   │       ├── WatchTable.tsx    # 教學儀表板
│   │       ├── SourceCode.tsx    # 原始碼顯示
│   │       ├── GdbApi.tsx        # GDB 通訊介面
│   │       ├── process_gdb_response.tsx # GDB MI 輸出解析
│   │       ├── InitialStoreData.ts # 全域狀態初始值
│   │       └── ...
│   ├── static/                   # 靜態資源（CSS、編譯後的 JS）
│   └── templates/                # HTML 模板（gdbgui.html、upload.html 等）
├── docs/                         # 文件與教學教案
│   └── maze_bfs_lesson.json      # BFS 走迷宮教學教案（含 TTS、Guide、Layout 標注）
├── maze_gen.cpp                  # 迷宮生成 + BFS 求解範例程式
├── examples/                     # 範例程式
├── tests/                        # 測試
├── requirements.txt              # Python 依賴
├── package.json                  # Node.js 依賴
├── webpack.config.js             # Webpack 設定（前端打包）
├── setup.py                      # Python 套件設定
└── README_MANUAL.md              # 本說明書
```

---

*本說明書最後更新：2026-04-08*

*專案基於 gdbgui（MIT/GPL-3.0 授權），原作者 Chad Smith。本擴充版本 CPPcodeVisualizer 為研究用途。*
