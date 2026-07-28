# CPPcodeVisualizer 教案撰寫指南

本文件說明如何利用「指導（Guide）」、「TTS」、「Layout」三個欄位，為每一行程式碼撰寫互動式教案。
三個欄位直接寫在 C++ 原始碼**行尾的 `//@` 註解**裡（語法見第一章），原始碼本身即是完整教案。

> **給 AI 的重點**：生成教案 = 輸出一份行尾帶 `//@` 註解的 .cpp 程式碼。
> 前端另提供 **Export JSON / Import JSON** 按鈕，可把教案連同斷點、程式輸入打包成 JSON bundle（格式見第五章）。

---

## 一、整體架構

執行程式時，每次 GDB 暫停在某一行，系統會依序執行：

1. **Guide** — 在右側視覺化面板顯示圖形、容器內容、呼叫圖標籤
2. **TTS** — 朗讀指定文字（可嵌入即時變數值）
3. **Layout** — 自動調整右側欄位的開合與比例

### 1.1 `//@` 行尾註解語法

三個欄位寫在該行程式碼**行尾的 `//@` 註解**中，以 `@guide` / `@tts` / `@layout` 關鍵字分欄：

```cpp
int x = 5;  //@ @guide 宣告變數 x @tts 目前 x 的值是 {x} @layout sidebar:50 open:container
```

語法規則：

- 哨兵是 `//@`：只有以 `//@` 開頭的行尾註解會被解析；一般 `//` 註解不受影響。`//@` 對編譯器而言就是普通 C++ 註解，完全不影響程式執行。
- `@guide`、`@tts`、`@layout` 三個關鍵字**皆可省略、順序任意**；每個關鍵字之後到下一個關鍵字（或行尾）之間的文字即為該欄內容，前後空白自動去除。
- 一行只能有一個 `//@`，三欄都寫在同一個註解內。
- 欄位值裡的其他標記照常寫在內容中：`{變數}`、`[speed:N]`、`[next]`、TTS 的 `@3` 門檻、`sidebar:50` 等。TTS 的 `@數字` 門檻不會被誤認為欄位關鍵字。
- 欄位值需要**換行**時寫 `\n`（反斜線本身寫 `\\`），整個 `//@` 註解必須維持單行。
- 保留字：欄位值中不可出現字面字串 `@guide`、`@tts`、`@layout`。

完整範例（AI 生成教案時輸出這種形式的 .cpp 即可）：

```cpp
#include <iostream>
#include <vector>
using namespace std;
int main() {
  int n = 5;         //@ @guide [初始化] n={n} @tts [next] 我們宣告 n，初值是 {n} @layout sidebar:40 open:callgraph
  vector<int> v;     //@ @guide 目前向量內容：{v} @layout sidebar:55 open:container close:locals
  for (int i = 0; i < n; i++) {  //@ @tts 第一次進入迴圈，i={i} | @3 繼續，i={i} | @5 [next] {i}
    v.push_back(i);  //@ @guide {v[i]} @tts 把 {i} 放進向量尾端
  }
}
```

---

### 1.2 回傳值約定（`result` 變數）

呼叫樹要顯示「這一層算出什麼」（節點上的綠色 `⇒ 值`），教案函式必須把回傳值
先存進名為 `result` 的區域變數再 return：

    int result = n + rest;
    return result;      // 呼叫樹返回時顯示 ⇒ 值

直接 `return n + rest;` 不會壞，只是該節點返回時沒有 `⇒ 值`（僅變淡）。
此外 **`result` 必須在函式最外層宣告一次，各分支只賦值、不得在內層區塊重複宣告**：

    int result;            // 函式最外層宣告一次
    if (n <= 1) {
        result = 1;        // base case 只賦值
        return result;
    }

原因：frame 的最後一個停駐點是函式右大括號 `}`，區塊內宣告的 `result` 在那裡已
出 scope，呼叫樹會凍結到外層未初始化的垃圾值（實測症狀：第一次 return 顯示 `↑0`）。

AI 生成遞迴教案時一律採用此寫法。

### 1.3 全自動播放（硬性標準）

教案必須能**全自動播放**：使用者 Import 教案、按下 Run 之後，不需要任何手動步進，
教案要自己一路播放到程式結束。

- GDB 可能停駐的**每一行**（含函式的右大括號行、main 的收尾行）都必須有 `@tts`，
  且以自動播放指令開頭（`[next]`／`[step-in]`／`[continue]`，見 3.4 節）。
- 同一行多次停駐時，每個 `@N` 門檻段落也**各自**要以指令開頭，
  不得留下沒有指令的段落（例如遞迴呼叫行：第一次 `[step-in]` 往下、
  回程時用 `@N [next]` 繼續）。
- 最後一個停駐點以 `[continue]` 收尾，讓程式跑到結束。
- **Run 一定先停在 main 的第一個可執行行**（系統自動 `-break-insert main`）：
  main 裡的呼叫行會停**兩次**（起跑出發、遞迴結束返回），訊息必須用 `@2` 門檻
  區分，例如 `[next] 從 main 出發，呼叫 sum(4) | @2 [next] 遞迴全部結束，回到 main`。
- 驗收方式：Import 後按 Run，全程不碰鍵盤滑鼠，教案應自動播放完畢。

AI 生成教案時此為**硬性標準**：任何一個停駐點缺少自動播放指令即為不合格。

### 1.4 多分支（樹狀）遞迴

- **每個遞迴呼叫獨立成行**，存入具名變數：`int a = fib(n - 1);`、`int b = fib(n - 2);`。
  不要寫 `return fib(n-1) + fib(n-2);` — 單行雙呼叫無法逐呼叫註解與自動播放。
- **斷點設在遞迴函式入口行**。自動播放的「下降」靠它：呼叫行不論寫 `[next]` 或
  `[step-in]`，入口斷點都會攔住進入下一層。
- 呼叫行一律用 `[step-in]`（回程再次停駐該行時，呼叫已完成，step 等同 next，安全）。
- **呼叫行的訊息必須方向中性**：樹狀遞迴的呼叫行「去程／回程」交錯出現、無法用
  `@N` 門檻區分，訊息要寫成兩種情境都通（例：「處理左邊的子問題」），
  不要寫「往下呼叫」或「回來了」這種單向敘述。

### 1.5 回傳行的 @guide 要顯示「回傳值 ← 由來」

`return result;` 那一行的 `@guide` 不要只寫回傳值，要一併寫出它**怎麼算出來的**，
讓學生在 return 那一刻於節點上同時看到值和它的由來（回答「為什麼回傳這個值」）：

    return result;   //@ @guide 回傳 {result} ← max(不拿 {skip}, 拿 {take})

慣用格式：`回傳 {result} ← <由來>`。由來依函式而定：

- 線性／分治：`← {n} + {rest}`、`← {a} + {b}`、`← max(不拿 {skip}, 拿 {take})`
- base case：`← base case (n≤1)`、`← 沒物品可拿`
- 記憶化命中：`← 直接查記憶表`
- 尾遞迴轉交：`← 下層原封傳回`

`return` 行上 `{result}` 與由來用到的變數（`{skip}`、`{n}` 等）此時都已賦值、在 scope 內，可安全引用。

### 1.6 遞迴呼叫的回傳值要存成獨立變數，別和其他運算混在一行

`take = val[i] + knap(...)` 把「子問題的回傳值」和「額外運算（+val[i]）」塞進同一個變數，
節點上只看得到最後的 take，看不出子問題其實回傳多少 —— 學生會困惑「子問題明明回傳 0，
怎麼變 2」。把子問題的答案先存成獨立變數：

    int sub = knap(i + 1, w - wt[i], v - vol[i]);   //@ 子問題的答案（看得到它回傳 0）
    take = val[i] + sub;                            //@ 拿 = 這件的價值 + 子問題 {sub}

這樣 `sub` 明確顯示子問題回傳的值，`take = val[i] + sub` 顯示組成，回傳的由來一目了然。
通則：**一行最多一個遞迴呼叫，且其回傳值先落在自己的具名變數上**，再參與後續運算。

---

## 二、指導欄（Guide）

> 寫在該行 `//@` 註解的 **`@guide`** 欄位。觸發時機：GDB 暫停在該行。

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

> **重要：`{變數}` 讀到的是「該行執行前」的值。** GDB 停在某行時該行尚未執行，
> 所以**該行才要賦值的變數不可在同一行的註解引用**（會讀到未初始化的垃圾值），
> 請放到下一行的註解。例如 `result = n + rest;` 的註解只能用 `{n}`、`{rest}`，
> `{result}` 要寫在下一行 `return result;` 的註解上。

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

勾選容器標題旁的「迷宮模式」可切換為迷宮配色（見 4.6 節）。

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

在 Guide 欄顯示容器、在 Layout 欄開啟 container 面板，並可用 `bst:容器名`（見 4.7 節）自動切換紅黑樹視圖：

```cpp
s.insert(x);  //@ @guide 目前集合內容：{s} @layout sidebar:55 open:container bst:s
```

### 2.6 多行說明 `\n`

在指導文字中寫入 `\n` 可換行，Guide 面板會分行顯示（`//@` 註解本身仍維持單行）。

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

> 寫在該行 `//@` 註解的 **`@tts`** 欄位。觸發時機：GDB 暫停在該行。語言：`zh-TW`（繁體中文）。

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

> 規則：`[音]` 會**取代它前面的那一個字**送給語音引擎（例：`白[柏]` 唸成「柏」）。
> 把正確讀音緊接在要修正的字後面即可；只影響朗讀，字幕仍顯示原字。

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

### 3.7 停頓 `[wait:N]` / `[pause:N]`

在 TTS 文字中插入 `[wait:秒數]` 或 `[pause:秒數]`（兩者等價），朗讀到該處會靜默指定秒數後再繼續，適合留時間讓學生觀察畫面：

```
先看這一行 [pause:1.5] 注意 i 的值變成 {i}
現在插入節點 [wait:2] 觀察樹的旋轉
```

> 停頓標記不會顯示在字幕中。

---

## 四、Layout 欄

> 寫在該行 `//@` 註解的 **`@layout`** 欄位。觸發時機：GDB 暫停在該行。
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

### 4.7 紅黑樹視圖 `bst:容器名稱`

自動為指定的 `set` / `map` 類容器勾選「紅黑樹」視圖（等同於在 Container 面板手動勾選，見 2.5 節）：

```
bst:s
bst:s,m
```

### 4.8 容器字體大小 `font:N`

設定 Container 面板的字體大小，單位為 em（例如元素較多時縮小字體）：

```
font:1.5
font:0.8
```

### 4.9 組合範例

```
sidebar:50 open:container close:locals
sidebar:40 open:callgraph,container close:visualizer
sidebar:0 close:container,callgraph
sidebar:55 open:container maze:maze
sidebar:60 open:container bst:s font:1.2
```

---

## 五、JSON bundle 格式（v2）

Export JSON 產生的 `.gdbgui.json` bundle 只有五個欄位——**Guide/TTS/Layout 沒有獨立欄位**，它們以 `//@` 註解直接內嵌在 `source_code` 裡：

| 欄位 | 說明 |
|------|------|
| `version` | 固定為 `"2.0"` |
| `fullname_to_render` | 目前渲染的檔案路徑（可為空字串） |
| `source_code` | 完整原始碼字串，行尾 `//@` 註解即教案內容 |
| `breakpoints` | 斷點清單 |
| `program_input` | 程式的標準輸入內容 |

以下為完整範例，程式碼為 coin change 找零問題（`\n` 為 JSON 字串內的換行）：

```json
{
  "version": "2.0",
  "fullname_to_render": "",
  "source_code": "#include <iostream>\nusing namespace std;\nint coin[] = {1,5,10,50};\nint number[] = {0,0,0,0};\nvoid recursive(int i, int n) {  //@ @guide [遞迴入口#blue] i={i} n={n} @tts [next] 進入遞迴函式，目前 i 是 {i}，剩餘金額 n 是 {n} | @3 再次進入，i={i}，n={n} | @6 [step-in] 第六次以後步進觀察 @layout sidebar:50 open:container,callgraph close:locals\n  if (i == 4) return;  //@ @guide [終止條件#red] i={i} @tts [next] i 等於 4 嗎？目前 i 是 {i} | @2 [continue] 條件判斷，i={i}，已熟悉，跳過 @layout sidebar:40 open:callgraph\n  for (number[i] = 0; number[i]*coin[i] <= n; number[i]++) {  //@ @guide [枚舉硬幣#yellow] {number} @tts 枚[枚]舉硬幣，coin[i] 是 {coin[i]}\n    recursive(i+1, n-coin[i]*number[i]);  //@ @guide [遞迴呼叫#blue] {number[i]} @tts [step-in] 遞迴呼叫，number[i]={number[i]} @layout sidebar:55 open:container\n  }\n}\nint main() {\n  int n; cin >> n;\n  recursive(0,n);\n}",
  "breakpoints": [
    { "line": "5", "is_normal_breakpoint": true }
  ],
  "program_input": "63"
}
```

> **舊格式相容**：v1 bundle（含 `line_data` 欄位）匯入時會自動轉換為 v2——各行資料被組成 `//@` 註解附加到對應行尾。匯出一律是 v2。

---

## 六、編輯器功能

### 6.1 Export / Import JSON

在程式碼編輯器右上角有兩顆按鈕：

| 按鈕 | 功能 |
|------|------|
| **Import JSON** | 從本機匯入 `.gdbgui.json` 教案檔（含 `//@` 註解的程式碼、斷點、程式輸入一次匯入；v1 舊格式自動轉換） |
| **Export JSON** | 將目前教案儲存為 `.gdbgui.json`（Chrome/Edge 支援「另存新檔」直接覆蓋本機檔案；其他瀏覽器自動下載） |

> **建議工作流**：在 Chrome/Edge 中使用，Export 時可直接瀏覽到專案資料夾並覆蓋同名 JSON，省去手動移檔的步驟。

### 6.2 行內註釋編輯面板（✎）

滑鼠移到編輯器中任一行上，該行行尾（既有 `//@` 的起點處，或程式碼結尾）會出現 **✎** 圖示。
點擊即在該行下方展開行內編輯面板（按 `Esc` 或 ✕ 關閉，不儲存）：

**簡單模式**（預設）：只有「指導文字」多行輸入框，支援 `{變數}` 佔位符。

**進階模式**（點「進階 ▸」切換）：

| 區塊 | 說明 |
|------|------|
| **插入變數** | 點擊變數 chip 插入 `{變數}`；在指導欄輸入 `{` 也會即時彈出變數建議清單 |
| **🔊 TTS** | 語速倍率（等同 `[speed:N]`，留空用預設）、`[continue]` 勾選、語音朗讀文字 |
| **Layout** | `sidebar 寬` / `open:id1,id2` / `close:id1,id2` / `maze` / `bst` 五個欄位 |

點擊 **儲存** 後，面板自動把各欄位組成該行行尾的 `//@` 註解（新增或取代既有註解；全部清空則移除該註解）。
面板只是產生 `//@` 註解的 GUI 工具——直接在編輯器手打 `//@` 註解效果完全相同。

> 註：行尾註解跟著程式碼行一起移動，增刪行不需要任何行號對齊操作。

---

## 七、沙箱安全機制

當使用者點擊 **Run / Restart** 編譯並執行程式時，系統會自動啟用三層保護機制，防止惡意程式碼（如 `system("> evil.txt")`、`system("sudo rm -rf /")` 等）破壞伺服器檔案系統。





### 7.1 Layer 1 — 靜態分析（編譯前）

編譯前掃描原始碼（已去除注釋與字串常量），依嚴重程度分兩類處理：

- **`[sandbox:封鎖]`**（紅色）— **直接拒絕編譯**，Console 顯示 `EPERM` 錯誤，流程終止。連結層（Layer 2）同樣針對這些函式設有 `--wrap` 攔截，作為雙重防禦。
- **`[sandbox:警告]`**（黃色）— 允許編譯但在 Console 顯示提示。連結層無法攔截此類呼叫（如 `ofstream`），但 Layer 3 的 ulimit 限制資源消耗，setpriv 降權則防止其覆寫應用程式檔案。

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

### 7.3 Layer 3 — 執行期資源限制（ulimit）、降權（setpriv）與 Docker 部署隔離

每次執行程式前，GDB 透過 `set exec-wrapper <session>/run.sh` 啟動 per-session wrapper，執行兩項保護：

**（1）ulimit 硬性資源限制**（防 DoS）：

| 資源 | 限制 |
|------|------|
| 單檔最大寫入 | 512 KB |
| Core dump | 禁止 |
| 子程序數 | 最多 64 個 |
| CPU 時間 | 30 秒 |
| 虛擬記憶體 | 512 MB |

**（2）setpriv 降權至 nobody**（防應用程式檔案遭覆寫）：

wrapper 呼叫 `setpriv --reuid=65534 --regid=65534 --clear-groups` 將使用者程式降至 `nobody` 身分執行，使其無法覆寫由 root 擁有的應用程式檔案（如 `http_routes.py`）。GDB 本身仍以 root 執行，保有 `CAP_SYS_PTRACE`，可繼續 ptrace `nobody` 的子行程，中斷點功能不受影響。

對應的 PTY 從裝置 (`/dev/pts/N`) 在建立後會 chmod 為 `0o622`，確保 `nobody` 進程能正常輸出至終端機。

> **為何不使用 chroot 隔離**：GDB 透過 `/proc/PID/exe` 路徑比對來確認執行中的 binary 是否與已載入的符號表相同。chroot 會在 `/proc/PID/exe` 路徑前加上 jail 目錄前綴，造成路徑不符，GDB 無法插入中斷點（回報 `Cannot access memory`）。這是 chroot 與 GDB exec-wrapper 的根本性不相容，無法繞過。

> **檔案系統隔離**：整個應用程式應部署於 Docker 容器中（見 `Dockerfile.gdbgui`）。容器與宿主機的檔案系統完全隔離，即使程式在容器內取得 root，也無法影響宿主機。

即使攻擊者透過 inline asm 繞過 Layer 2，Layer 3 的 ulimit 限制 CPU/記憶體/磁碟消耗，setpriv 則防止其以 root 身分破壞應用程式本身。

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
- **set/map 紅黑樹教學**：`sidebar:60 open:container bst:容器名`（自動切換紅黑樹視圖）

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

### `//@` 行尾註解
| 語法 | 功能 |
|------|------|
| `code;  //@ @guide … @tts … @layout …` | 三欄寫在同一個行尾註解；關鍵字皆可省略、順序任意 |
| `\n` / `\\` | 欄位值內的換行 / 反斜線（註解本身維持單行） |

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
| `[speed:N]` | 設定 TTS 播放速度（0.1–4.0 倍速） |
| `[wait:N]` / `[pause:N]` | 朗讀中途靜默 N 秒 |
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
| `bst:容器名` | 啟用指定 set/map 容器的紅黑樹視圖 |
| `font:N` | Container 面板字體大小（em） |
| `sidebar:50 open:container close:locals` | 組合使用（空格分隔） |

### 可用面板 ID
`compile_errors` / `memory_watch` / `callgraph` / `visualizer` / `container` / `locals` / `watch_table`

### 編輯器操作
| 操作 | 功能 |
|------|------|
| **✎ 圖示** | 滑鼠移到任一行時出現於行尾；點擊展開行內註釋編輯面板（見 6.2） |
| **Export JSON** | 另存新檔至本機（Chrome/Edge）或下載 |
| **Import JSON** | 從本機匯入教案 |
