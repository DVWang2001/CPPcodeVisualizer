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
| `std::vector` | 橫向格子陣列（含容量虛線框） |
| `std::stack` | 開口向右的容器 |
| `std::queue` | 兩端箭頭的橫向容器 |
| `std::deque` | 雙端橫向容器 |
| `std::list` | 雙向箭頭節點鏈 |
| `std::string` | 字元格子陣列 |
| `std::array` | 橫向格子陣列 |

```
目前堆疊內容：{stk}
佇列：{q}
向量 arr：{arr}
```

### 2.4 高亮特定索引 `{容器名[索引]}`

索引可以是整數常數，也可以是變數（系統即時查詢）：

```
{arr[i]}
{vec[0]}
{myStack[top]}
```

> 效果：容器視覺化中對應格子會以黃底粗體高亮。

### 2.5 多行說明 `\n`

在指導文字中寫入 `\n` 可換行，後面的文字會對應到下面的程式碼行。

```
第一行說明\n第二行說明\n第三行說明
```

### 2.6 呼叫圖自訂標籤 `[標籤名] ...` / `[標籤名#顏色] ...`

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
| `memory_watch` | 記憶體與指標追蹤 |
| `callgraph` | call graph（歷史呼叫圖） |
| `visualizer` | 視覺化（Visualizer） |
| `container` | 容器視覺化（Container） |
| `locals` | 區域變數（Local Variables） |
| `watch_table` | Teaching Dashboard（Table） |

### 4.5 組合範例

```
sidebar:50 open:container close:locals
sidebar:40 open:callgraph,container close:visualizer
sidebar:0 close:container,callgraph
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

## 六、欄位設計建議（給 AI 生成教案使用）

### 6.1 Guide 欄的設計原則

- 每次暫停**只顯示該步驟最重要的容器或變數**，避免同時顯示太多。
- 遞迴類題目：用 `[標籤名#顏色]` 標記不同函式呼叫層次，搭配 call graph。
- 迴圈類題目：用 `{陣列名[i]}` 高亮當前被訪問的元素。
- 條件判斷行：可純文字說明判斷式意義，不一定要顯示容器。

### 6.2 TTS 欄的設計原則

- **第一次進入**：完整說明該行的語意、目的。
- **後續重複進入**（迴圈/遞迴）：只說關鍵變數值，縮短說明。
  使用 `| @N` 漸進簡化：第 1 次詳細，第 3 次簡短，第 5 次以後只說值。
- **自動播放**：若該行不需要停留觀察，加 `[next]` 讓流程自動推進。
  遞迴進入點通常加 `[step-in]`，退出條件加 `[next]` 或 `[continue]`。
- **發音修正**：遇到縮寫、英文夾雜的中文詞，用 `詞[讀音]` 修正。

### 6.3 Layout 欄的設計原則

- **程式開始**（main 入口）：`sidebar:40 open:callgraph`
- **容器操作行**：`sidebar:55 open:container close:locals`
- **遞迴/函式呼叫行**：`sidebar:50 open:callgraph,container`
- **不重要的行**（僅宣告、空行）：不填或 `sidebar:30 close:container`
- **程式結束**：`sidebar:60 open:watch_table`

### 6.4 多次進入設計範本（迴圈/遞迴）

```
TTS 第 7 行（for 迴圈）：
  [next] 開始枚[枚]舉硬幣，coin[i]={coin[i]}，目前計數 number[i]={number[i]} | @3 繼續枚[枚]舉，number[i]={number[i]} | @6 [next] {number[i]}

TTS 第 5 行（遞迴入口）：
  [step-in] 進入遞迴，i={i}，剩餘 n={n} | @4 再次遞迴，i={i}，n={n} | @8 [next] i={i}，n={n}
```

---

## 七、快速語法速查表

### Guide 欄
| 語法 | 功能 |
|------|------|
| `說明文字` | 顯示純文字 |
| `{var}` | 顯示變數值 |
| `{container}` | 顯示容器視覺化 |
| `{arr[i]}` | 高亮容器索引 i |
| `文字\n文字` | 多行說明 |
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
| `sidebar:50 open:container close:locals` | 組合使用（空格分隔） |

### 可用面板 ID
`memory_watch` / `callgraph` / `visualizer` / `container` / `locals` / `watch_table`
