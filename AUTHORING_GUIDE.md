# CPPcodeVisualizer 教案撰寫指南

本文件說明如何利用「指導（Guide）」、「TTS」、「Layout」三欄位為每一行程式碼撰寫互動式教案。
教案儲存在 JSON 檔中，可透過前端 **Export JSON / Import JSON** 按鈕匯出或匯入。

---

## 一、整體架構

執行程式時，每次 GDB 暫停在某一行，系統會依序執行：

1. **Guide** — 在右側視覺化面板顯示圖形、容器內容、呼叫圖標籤
2. **TTS** — 朗讀指定文字（可嵌入即時變數值）
3. **Layout** — 自動調整右側欄位的開合與比例

三個欄位的設定都以「行號」為 key 寫在 JSON 的對應欄位中。

---

## 二、指導欄（Guide）

> 填入右側 **Guide** 欄。觸發時機：GDB 暫停在該行。

### 2.1 顯示純文字

直接填入字串，會出現在 **Visualizer** 面板（右側 visualizer 區塊）。

```
這是第 7 行的說明文字
```

### 2.2 顯示變數值 `{變數名}`

用大括號包住變數名稱，系統會即時向 GDB 查詢其值後呈現。

```
目前 i 的值是 {i}，j 是 {j}
```

> 可在同一行混合文字與多個變數：`n = {n}，sum = {sum}`

### 2.3 顯示容器視覺化 `{容器名}`

若變數是 STL 容器，系統自動渲染對應圖形：

| 容器類型 | 對應圖形 |
|----------|---------|
| `std::vector` | 橫向格子陣列（含容量虛線框）；元素為陣列時自動切換成二維格狀視圖 |
| `std::stack` | 開口向右的容器 |
| `std::queue` | 兩端箭頭的橫向容器 |
| `std::deque` | 雙端橫向容器 |
| `std::list` | 雙向箭頭節點鏈 |
| `std::string` | 字元格子陣列 |
| `std::array` | 橫向格子陣列；元素為陣列時自動切換成二維格狀視圖 |
| `std::set` / `std::multiset` | 大括號集合；可切換為紅黑樹視圖 |
| `std::map` / `std::multimap` | key-value 表格；可切換為紅黑樹視圖 |
| `std::unordered_map` | key-value 表格 |

```
目前堆疊內容：{stk}
佇列：{q}
向量 arr：{arr}
集合 s：{s}
映射 m：{m}
```

#### 二維陣列視圖

`std::vector<vector<int>>` 或 `std::array<array<int,N>,M>` 類型的容器，會自動以**二維格狀視圖**渲染（rows × cols 方格），並支援以 `{arr[i][j]}` 高亮特定格子：

```
{grid}        ← 二維格狀視圖
{grid[i][j]}  ← 高亮第 i 列第 j 行的格子
```

勾選容器標題旁的「迷宮模式」可切換為迷宮配色（見 4.5 節）。

### 2.4 高亮特定索引 `{容器名[索引]}` 與多色高亮

索引可以是整數常數，也可以是變數（系統即時查詢）：

```
{arr[i]}
{vec[0]}
{myStack[top]}
```

> 效果：容器視覺化中對應格子會以**黃底粗體**高亮（預設色）。

#### 多個索引同時高亮

同一行 Guide 欄中，對**同一容器**寫多個帶索引的 token，每個索引都會被高亮：

```
{arr[i]} {arr[j]}
```

> `i` 和 `j` 指向的格子都會高亮（預設皆為黃色）。

#### 自訂高亮顏色 `{容器名[索引]:顏色}`

在閉括號 `]` 後面加上 `:顏色` 可指定 CSS 顏色（支援命名色或十六進位色碼）：

```
{arr[i]:lightblue}      ← i 格顯示淺藍色
{arr[j]:#ff6b6b}        ← j 格顯示珊瑚紅（十六進位）
{arr[i]} {arr[j]:orange} ← i 預設黃色，j 橘色
{grid[r][c]:lime}        ← 二維陣列 (r,c) 格顯示萊姆綠
```

| 常用顏色 | CSS 值 |
|---------|--------|
| 預設黃色 | 不加 `:顏色` |
| 淺藍 | `lightblue` 或 `#add8e6` |
| 珊瑚紅 | `#ff6b6b` |
| 橘色 | `orange` |
| 萊姆綠 | `lime` 或 `#00ff00` |
| 粉紅 | `pink` |
| 薰衣草 | `lavender` |

> **建議使用淺色**，深色背景會讓格子內的黑色文字難以辨讀。  
> 迷宮模式（maze）的預設高亮色為橘紅，不受 `:顏色` 語法影響時（未指定顏色）會使用橘紅以保持對比度；指定顏色時會使用指定顏色。

### 2.5 紅黑樹視覺化（set / map 專屬）

對 `set`、`multiset`、`map`、`multimap` 類型的容器，**Container 面板**標題旁會出現「紅黑樹」勾選框。勾選後容器改為 SVG 樹狀圖顯示，每個節點包含：

- **節點顏色**：深藍灰 = 黑節點、深紅 = 紅節點（符合 RB-tree 著色規則）
- **節點文字**：`set` 顯示元素值；`map` 顯示 `key→value`
- **`bhN` 標籤**：右上角顯示該節點的**黑色高度**（Black Height）——從該節點往下到葉節點（不含）的黑節點數；所有路徑的黑色高度相等即代表樹已平衡

圖例說明：
```
深藍灰節點 = 黑節點
深紅節點   = 紅節點
bhN 標籤   = 黑色高度（各路徑相等表示符合 RB-tree 不變式）
```

> 視覺化資料來源：優先使用 GDB 讀取的真實樹狀結構（色彩與連結正確），若 GDB 資料尚未就緒則以 JS 模擬插入順序做 fallback。

#### 搭配教案使用

在 Guide 欄顯示容器、在 Layout 欄同時開啟 container 面板即可。  
紅黑樹切換是前端互動狀態，不需要特殊的 Layout 指令。

```
Guide 第 N 行：目前集合內容：{s}
Layout 第 N 行：sidebar:55 open:container
```

### 2.6 多行說明 `\n`

在指導文字中寫入 `\n` 可換行，後面的文字會對應到下面的程式碼行。

```
第一行說明\n第二行說明\n第三行說明
```

### 2.7 設定 TTS 播放速度 `[speed:N]`

在指導欄任意位置加入 `[speed:N]`，GDB 暫停到該行時會立即將 TTS 播放速度設為 N 倍速。
N 的有效範圍為 **0.1 – 4.0**，預設為 1.0。

```
[speed:1.5] 目前 i={i}
[speed:0.8] 請仔細觀察以下堆疊內容：{stk}
[speed:1.0]
```

- `[speed:N]` token 本身**不會顯示**在 Guide 面板，只作為速度指令。
- 可與其他指導內容混用，例如 `[speed:1.2] {q}` 先調速再顯示容器。
- 速度設定**持續到下次更改**，適合在教學開始時設為慢速，收尾時恢復正常速。
- 與 ControlButtons 的速度滑桿同步，兩者互相覆蓋。

### 2.8 呼叫圖自訂標籤 `[標籤名] ...` / `[標籤名#顏色] ...`

在指導開頭加上 `[標籤名]` 或 `[標籤名#顏色]`，即可在 **call graph** 面板的節點上顯示自訂文字與顏色。
標籤後面的 `{變數}` 語法照常運作。

```
[初始化] {n}
[迴圈體#blue] i={i} arr={arr}
[遞迴呼叫#red] {n}
[回傳#green]
```

支援的顏色名稱：任何 CSS 合法顏色字串，例如 `red`、`blue`、`#ff8800`、`rgba(0,200,100,0.8)`。

---

## 三、TTS 欄（Text-to-Speech）

> 填入右側 **TTS** 欄。觸發時機：GDB 暫停在該行。語言：`zh-TW`（繁體中文）。

### 3.1 基本文字

直接填入文字，系統即朗讀。

```
現在程式進入 main 函式
```

### 3.2 嵌入即時變數值 `{變數名}`

與 Guide 相同語法，TTS 會唸出變數當前的數值。

```
目前 i 等於 {i}，n 等於 {n}
```

> 容器變數同樣支援，會唸出元素清單，例如 `1, 2, 3`。

### 3.3 自訂發音 `字[音]`

針對容易被系統誤讀的字，用 `[正確讀音]` 緊接在字之後指定：

```
這是一個遞[遞]迴函式
枚[枚]舉所有組合
```

> 規則：`字[音]` → 系統唸「音」而非原字。

### 3.4 自動播放指令前綴 `[指令]`

在 TTS 文字**最前面**加上指令標記，TTS 唸完後自動執行該 GDB 動作：

| 指令 | 對應操作 |
|------|---------|
| `[next]` | 執行下一行（step over） |
| `[step-in]` | 步入函式（step into） |
| `[step-out]` | 步出函式（step out） |
| `[continue]` | 繼續執行到下一個斷點 |

```
[next] 我們先宣告變數 i，值為 {i}
[step-in] 現在呼叫遞迴函式，讓我們進入看看
[continue] 這個迴圈不重要，直接跳到下一個斷點
```

### 3.5 多次進入語法 `|`

用 `|` 分隔不同次進入時要唸的文字。預設依序對應第 1、2、3… 次：

```
第一次進入這行 | 第二次進入 | 第三次以後都唸這個
```

- 超過段落數時，重複最後一段。
- 程式重新執行（⟲）後計數歸零。

每段**可各自帶自動播放指令**：

```
[next] 第一次自動下一步 | [step-in] 第二次步進 | 之後不自動
```

### 3.6 指定觸發次數 `@N`

在每段開頭加 `@N` 指定「從第幾次進入才開始唸這段」：

```
第一次說這個 | @3 第三次才換這段 | @10 第十次以後唸這個
```

> 規則：選取所有 `threshold ≤ 當前次數` 中閾值最大的那段。

**混合 `@N` 與自動播放指令**：

```
[next] 初次介紹 | @2 第二次快速帶過 | @5 [continue] 第五次後直接跳
```

**不加 `@N` 時等同於 `@1`、`@2`、`@3`…（向下相容）**

---

## 四、Layout 欄

> 填入右側 **Layout** 欄。觸發時機：GDB 暫停在該行。
> 每個 token 以空格分隔，格式均為 `key:value`。

### 4.1 調整右側欄寬度 `sidebar:N`

`N` 為百分比（0–99），代表右側側邊欄佔整個中間區域的比例。

```
sidebar:50
sidebar:30
sidebar:0
```

> `sidebar:0` 可完全隱藏右側欄（適合只看程式碼的步驟）。
> `sidebar:70` 放大右側視覺化區域。

### 4.2 展開面板 `open:面板ID`

可同時展開多個面板（用逗號分隔）：

```
open:container
open:container,callgraph
open:memory_watch,locals
```

### 4.3 收合面板 `close:面板ID`

```
close:locals
close:locals,watch_table
```

### 4.4 可用面板 ID

| 面板 ID | 面板說明 |
|---------|---------|
| `compile_errors` | 編譯錯誤（含 AI 解釋功能） |
| `memory_watch` | 記憶體與指標追蹤 |
| `callgraph` | call graph（歷史呼叫圖） |
| `visualizer` | 視覺化（Visualizer） |
| `container` | 容器視覺化（Container） |
| `locals` | 區域變數（Local Variables） |
| `watch_table` | Teaching Dashboard（Table） |

### 4.5 編譯錯誤面板 `open:compile_errors`

`compile_errors` 面板會自動在每次編譯後更新。使用 `open:compile_errors` 可以在程式啟動前（或重新編譯後）自動展開它。

```
sidebar:40 open:compile_errors
```

面板功能：
- 顯示所有 error / warning / note 並標注行號與欄號
- **點擊**任一錯誤可以跳到對應行
- **🤖 AI 解釋錯誤**按鈕：將錯誤清單與原始碼送至後端 AI，以中文說明錯誤原因與修法

> 注意：AI 解釋需要後端有效的 API 金鑰，否則會顯示錯誤訊息。

### 4.6 迷宮模式 `maze:容器名稱`

自動為指定容器啟用「迷宮視覺化模式」（以格狀地圖顯示二維陣列）：

```
maze:maze
maze:grid,board
```

> 等同於在容器視覺化面板手動勾選「迷宮模式」。

### 4.7 組合範例

```
sidebar:50 open:container close:locals
sidebar:40 open:callgraph,container close:visualizer
sidebar:0 close:container,callgraph
sidebar:55 open:container maze:maze
```

---

## 五、JSON 格式範例

以下為一份完整的 JSON 教案片段，程式碼為 coin change 找零問題：

```json
{
  "source_code": "#include <iostream>\nusing namespace std;\nint coin[] = {1,5,10,50};\nint number[] = {0,0,0,0};\nvoid recursive(int i, int n) {\n  if (i == 4) return;\n  for (number[i] = 0; number[i]*coin[i] <= n; number[i]++) {\n    recursive(i+1, n-coin[i]*number[i]);\n  }\n}\nint main() {\n  int n; cin >> n;\n  recursive(0,n);\n}",
  "guide": {
    "5": "[遞迴入口#blue] i={i} n={n}",
    "6": "[終止條件#red] i={i}",
    "7": "[枚舉硬幣#yellow] {number}",
    "8": "[遞迴呼叫#blue] {number[i]}"
  },
  "tts": {
    "5": "[next] 進入遞迴函式，目前 i 是 {i}，剩餘金額 n 是 {n} | @3 再次進入，i={i}，n={n} | @6 [step-in] 第六次以後步進觀察",
    "6": "[next] i 等於 4 嗎？目前 i 是 {i} | @2 [continue] 條件判斷，i={i}，已熟悉，跳過",
    "7": "枚[枚]舉硬幣，coin[i] 是 {coin[i]}",
    "8": "[step-in] 遞迴呼叫，number[i]={number[i]}"
  },
  "layout": {
    "5": "sidebar:50 open:container,callgraph close:locals",
    "6": "sidebar:40 open:callgraph",
    "8": "sidebar:55 open:container"
  },
  "breakpoints": [
    { "line": "5", "is_normal_breakpoint": true }
  ]
}
```

---

## 六、編輯器功能

### 6.1 Export / Import JSON

在程式碼編輯器右上角有兩顆按鈕：

| 按鈕 | 功能 |
|------|------|
| **Import JSON** | 從本機匯入 `.gdbgui.json` 教案檔（程式碼、Guide/TTS/Layout、斷點一次匯入） |
| **Export JSON** | 將目前教案儲存為 `.gdbgui.json`（Chrome/Edge 支援「另存新檔」直接覆蓋本機檔案；其他瀏覽器自動下載） |

> **建議工作流**：在 Chrome/Edge 中使用，Export 時可直接瀏覽到專案資料夾並覆蓋同名 JSON，省去手動移檔的步驟。

### 6.2 行編輯器 Modal（✎ 按鈕）

在「Edit Mode」下，每一行的 Guide/TTS/Layout 欄右側都有一個 **✎** 按鈕。
點擊後會彈出放大版的行編輯器，分為三個 Tab：

#### 📝 指導文字 Tab
- 多行 `textarea`，可輸入長篇指導說明
- 支援 `{varName}` 佔位符
- 適合需要換行或篇幅較長的說明

#### 🔊 語音 TTS Tab

| 欄位 | 說明 |
|------|------|
| **語速倍率** | 數字輸入框，等同於 `[speed:N]` 標籤，留空代表使用預設速度 |
| **[continue] 勾選** | 勾選後 TTS 唸完自動繼續到下個斷點 |
| **語音朗讀文字** | TTS 實際唸出的內容，留空則此行不播語音 |
| **預覽** | 即時顯示組合後的原始 TTS 字串，可確認格式是否正確 |

> 儲存時自動將三個欄位組合為 `[speed:N][continue]文字` 格式。

#### 📐 版面 Layout Tab

| 欄位 | 說明 |
|------|------|
| **右側欄寬度** | 數字輸入，等同於 `sidebar:N` |
| **迷宮容器** | 容器名稱，等同於 `maze:名稱` |
| **展開面板** | 逗號分隔的面板 ID，等同於 `open:id1,id2` |
| **收合面板** | 逗號分隔的面板 ID，等同於 `close:id1,id2` |
| **預覽** | 即時顯示組合後的原始 Layout 字串 |

點擊 **儲存** 套用所有欄位；點擊 **取消** 或點擊遮罩關閉不儲存。

### 6.3 行拖曳排序

在 Edit Mode 下，程式碼左側（行號區右邊）每行都有一個 **⠿ 拖曳 handle**。
拖曳 handle 可以搬移整行（包含其 Guide、TTS、Layout、斷點設定）：

| 操作 | 效果 |
|------|------|
| **拖曳單行** | 將該行移到目標行之後（目標行底部顯示藍色指示線） |
| **Ctrl + 點擊 handle** | 加入 / 取消該行的多選（累積選取不連續的行） |
| **Shift + 點擊 handle** | 從上次點擊行到此行的連續範圍全選 |
| **拖曳已選中的行** | 一次移動所有選中的行，插入位置取決於最上面的 source 行 |

> 拖曳完成後 Guide/TTS/Layout 的行號對應自動更新，不需要手動修正。

---

## 七、沙箱安全機制

當使用者點擊 **Run / Restart** 編譯並執行程式時，系統會自動啟用三層保護機制，防止惡意程式碼（如 `system("> evil.txt")`、`system("sudo rm -rf /")` 等）破壞伺服器檔案系統。





### 7.1 Layer 1 — 靜態分析（編譯前）

編譯前掃描原始碼（已去除注釋與字串常量），依嚴重程度分兩類處理：

- **`[sandbox:封鎖]`**（紅色）— **直接拒絕編譯**，Console 顯示 `EPERM` 錯誤，流程終止。連結層（Layer 2）同樣針對這些函式設有 `--wrap` 攔截，作為雙重防禦。
- **`[sandbox:警告]`**（黃色）— 允許編譯但在 Console 顯示提示。連結層無法攔截此類呼叫（如 `ofstream`），但 Layer 3 的 ulimit 可限制實際傷害範圍。

| 分類 | 偵測目標 | 層級 |
|------|----------|------|
| Shell 執行 | `system`, `popen` | 封鎖 |
| 程序建立/取代 | `fork`, `vfork`, `exec*` 系列 | 封鎖 |
| 刪除檔案 | `unlink`, `unlinkat`, `remove`, `rmdir` | 封鎖 |
| 改名/移動 | `rename`, `renameat` | 封鎖 |
| 建立目錄 | `mkdir`, `mkdirat` | 封鎖 |
| 權限/擁有者 | `chmod`, `fchmod`, `chown`, `fchown` | 封鎖 |
| 符號/硬連結 | `symlink`, `link` | 封鎖 |
| 截斷檔案 | `truncate`, `ftruncate` | 封鎖 |
| 動態載入 | `dlopen` | 封鎖 |
| 低階寫入 | `open(O_WRONLY)`, `creat`, `mknod`, `mkfifo`, `mkstemp` | 警告 |
| C 檔案寫入 | `fopen("w"/"a")`, `freopen` | 警告 |
| C++ 流 | `ofstream`, `fstream`, `std::filesystem::` | 警告 |
| 網路 | `socket`, `connect`, `bind` | 警告 |
| 信號/提權 | `kill`, `setuid`, `setgid`, `setenv`, `putenv` | 警告 |
| 記憶體映射 | `mmap` | 警告 |

### 7.2 Layer 2 — 連結層攔截（--wrap）

所有「封鎖」等級的函式，在編譯時會透過 GCC `-Wl,--wrap=XXX` 連結選項，將呼叫導向 `sandbox/stub.c` 中的替換實作：執行時印出 `[sandbox] XXX() is blocked` 訊息並回傳 `-1`（`errno = EPERM`），**不會真正執行**。

### 7.3 Layer 3 — 執行期資源限制（ulimit）與 Docker 部署隔離

每次執行程式前，GDB 透過 `set exec-wrapper <session>/run.sh` 啟動 per-session wrapper，設定以下硬性資源限制，防止 DoS 攻擊：

| 資源 | 限制 |
|------|------|
| 單檔最大寫入 | 512 KB |
| Core dump | 禁止 |
| 子程序數 | 最多 64 個 |
| CPU 時間 | 30 秒 |
| 虛擬記憶體 | 512 MB |

> **為何不使用 chroot 隔離**：GDB 透過 `/proc/PID/exe` 路徑比對來確認執行中的 binary 是否與已載入的符號表相同。chroot 會在 `/proc/PID/exe` 路徑前加上 jail 目錄前綴，造成路徑不符，GDB 無法插入中斷點（回報 `Cannot access memory`）。這是 chroot 與 GDB exec-wrapper 的根本性不相容，無法繞過。

> **檔案系統隔離**：整個應用程式應部署於 Docker 容器中（見 `Dockerfile.gdbgui`）。容器與宿主機的檔案系統完全隔離，即使程式在容器內取得 root，也無法影響宿主機。

即使攻擊者透過 inline asm 繞過 Layer 2，Layer 3 的 ulimit 也能限制 CPU、記憶體與磁碟的消耗範圍。

---

## 八、欄位設計建議（給 AI 生成教案使用）

### 8.1 Guide 欄的設計原則

- 每次暫停**只顯示該步驟最重要的容器或變數**，避免同時顯示太多。
- 遞迴類題目：用 `[標籤名#顏色]` 標記不同函式呼叫層次，搭配 call graph。
- 迴圈類題目：用 `{陣列名[i]}` 高亮當前被訪問的元素。
- 條件判斷行：可純文字說明判斷式意義，不一定要顯示容器。
- 速度控制：用 `[speed:0.8]` 在複雜段落放慢，用 `[speed:1.2]` 在簡單段落加速。

### 8.2 TTS 欄的設計原則

- **第一次進入**：完整說明該行的語意、目的。
- **後續重複進入**（迴圈/遞迴）：只說關鍵變數值，縮短說明。
  使用 `| @N` 漸進簡化：第 1 次詳細，第 3 次簡短，第 5 次以後只說值。
- **自動播放**：若該行不需要停留觀察，加 `[next]` 讓流程自動推進。
  遞迴進入點通常加 `[step-in]`，退出條件加 `[next]` 或 `[continue]`。
- **發音修正**：遇到縮寫、英文夾雜的中文詞，用 `詞[讀音]` 修正。

### 8.3 Layout 欄的設計原則

- **程式開始**（main 入口）：`sidebar:40 open:callgraph`
- **容器操作行**：`sidebar:55 open:container close:locals`
- **遞迴/函式呼叫行**：`sidebar:50 open:callgraph,container`
- **不重要的行**（僅宣告、空行）：不填或 `sidebar:30 close:container`
- **程式結束**：`sidebar:60 open:watch_table`
- **set/map 紅黑樹教學**：`sidebar:60 open:container`（讓學生在 container 面板手動切換紅黑樹模式）

### 8.4 紅黑樹（RB-tree）教案設計提示

- `set` 或 `map` 在 Container 面板有「紅黑樹」切換鈕，適合說明有序關聯容器的底層結構。
- 每個節點右上角的 **`bhN` 標籤**代表黑色高度，所有葉節點路徑的黑色高度應相等，可藉此向學生說明 RB-tree 的平衡不變式。
- 建議在第一次插入元素時以 TTS 說明「黑色高度代表什麼」，之後用 `@N` 漸進省略說明。
- 節點顏色：深藍灰 = 黑節點；深紅 = 紅節點。任意兩個相鄰紅節點代表違反規則（正常情況不應出現）。

### 8.5 多次進入設計範本（迴圈/遞迴）

```
TTS 第 7 行（for 迴圈）：
  [next] 開始枚[枚]舉硬幣，coin[i]={coin[i]}，目前計數 number[i]={number[i]} | @3 繼續枚[枚]舉，number[i]={number[i]} | @6 [next] {number[i]}

TTS 第 5 行（遞迴入口）：
  [step-in] 進入遞迴，i={i}，剩餘 n={n} | @4 再次遞迴，i={i}，n={n} | @8 [next] i={i}，n={n}
```

---

## 九、快速語法速查表

### Guide 欄
| 語法 | 功能 |
|------|------|
| `說明文字` | 顯示純文字 |
| `{var}` | 顯示變數值 |
| `{container}` | 顯示容器視覺化（vector/stack/queue/deque/list/string/array/set/map） |
| `{arr[i]}` | 高亮容器索引 i |
| `{arr[i][j]}` | 高亮二維容器第 i 列第 j 行 |
| `文字\n文字` | 多行說明 |
| `[speed:N]` | 設定 TTS 播放速度（0.1–4.0 倍速） |
| `[標籤名] {var}` | call graph 自訂標籤 |
| `[標籤名#red] {var}` | call graph 自訂標籤（有顏色） |

### TTS 欄
| 語法 | 功能 |
|------|------|
| `文字` | 朗讀文字 |
| `{var}` | 朗讀變數即時值 |
| `字[音]` | 自訂發音 |
| `[next] 文字` | 唸完後自動下一步 |
| `[step-in] 文字` | 唸完後步入函式 |
| `[step-out] 文字` | 唸完後步出函式 |
| `[continue] 文字` | 唸完後繼續到下個斷點 |
| `文字A \| 文字B \| 文字C` | 第1/2/3次進入分別唸 |
| `文字A \| @3 文字B \| @7 文字C` | 第1次/第3次起/第7次起 |

### Layout 欄
| 語法 | 功能 |
|------|------|
| `sidebar:N` | 右側欄寬度（百分比） |
| `open:ID` | 展開面板 |
| `open:ID1,ID2` | 同時展開多個面板 |
| `close:ID` | 收合面板 |
| `maze:容器名` | 啟用指定容器的迷宮視覺化模式 |
| `sidebar:50 open:container close:locals` | 組合使用（空格分隔） |

### 可用面板 ID
`compile_errors` / `memory_watch` / `callgraph` / `visualizer` / `container` / `locals` / `watch_table`

### 編輯器操作
| 操作 | 功能 |
|------|------|
| **✎ 按鈕** | 展開該行的放大版行編輯器（Edit Mode 下可見） |
| **⠿ 拖曳 handle** | 搬移整行至目標位置（行底部藍線為插入點） |
| **Ctrl + 點擊 ⠿** | 多選（切換） |
| **Shift + 點擊 ⠿** | 連續範圍選取 |
| **Export JSON** | 另存新檔至本機（Chrome/Edge）或下載 |
| **Import JSON** | 從本機匯入教案 |
