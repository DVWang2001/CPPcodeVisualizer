# for 迴圈 A/B/C 三段式單步 Design

**Date:** 2026-07-28
**Status:** Draft, pending user review
**Affects:** 新增 `gdbgui/src/js/forHeader.ts`；修改 `GdbApi.tsx`、`SourceCode.tsx`、`Actions.ts`、`gdbgui.css`
**目標：** 比照 Visual Studio，把 `for (A; B; C)` 拆成三個可見的步驟——先 A，再 B，B 成立才進迴圈本體，本體做完顯示 C，然後回到 B。

## 前置調查（已實測，非推論）

用 GDB 16.3 對 `-g -O0` 編譯的 `for (int i = 0; i < 3; i++)` 實測：

**line table 對該行有三筆，但只切出兩個可辨識的停駐狀態：**

| PC | 指令 | 對應 | GDB 會停 |
|---|---|---|---|
| `0x1158` | `movl $0x0,-0x8(%rbp)` | **A** `i = 0` | ✅ 僅第一次 |
| `0x115f` | `jmp 0x116b` | （跳到條件） | ❌ |
| `0x1167` | `addl $0x1,-0x8(%rbp)` | **C** `i++` | ✅ 之後每次 |
| `0x116b` | `cmpl $0x2,-0x8(%rbp)` / `jle` | **B** `i < 3` | ❌ |

**結論一：A 與 C 可以靠 `frame.addr` 精準區分。**

**結論二：B 永遠不會是獨立的 GDB 停駐點**——它跟 C 在同一個位址區塊裡，`next` 不會為它停下來。而且 **GDB 16.3 拿不到欄位（column）資訊**：`maint info line-table` 的欄位只有 `INDEX LINE REL-ADDRESS UNREL-ADDRESS IS-STMT PROLOGUE-END EPILOGUE-BEGIN`，沒有 COLUMN。所以無法靠 DWARF 把 B 的位址範圍切出來。

因此 B 採 **UI 虛步**：按下一步時只換高亮、不送 GDB 命令，再按一次才真的走。使用者已確認採用此方案。

## 架構

四個各自獨立、可分開測試的單元。

### ① `forHeader.ts` — 純函式解析器

```ts
export interface ForSegments { a: [number, number]; b: [number, number]; c: [number, number]; }
export function parseForHeader(lineText: string): ForSegments | null;
```

回傳三段在該行的**字元位移**（0-indexed、半開區間；Monaco 的 column 是 1-indexed，在呼叫端 +1 轉換）。

在括號深度 0 上切兩個分號，並跳過字串常值、字元常值與巢狀括號。以下一律回 `null`，代表**完全走現有行為、不做任何改變**：

- range-for（`for (auto x : v)`）——沒有頂層分號
- `while` / `do-while` / 其他關鍵字
- 該行找不到與 `for` 配對的右括號（多行 for 標頭）
- 頂層分號數量不等於 2

`for (;;)` 三段皆為空範圍：解析成功但不產生高亮，虛步仍照常運作（B 恆為真）。

純函式、無外部相依，是這個功能唯一有真正解析邏輯的地方，測試主力放這裡。

### ② A / C 判定 — 用位址，不用計數

`global_variable.__for_line_min_addr: { [line: number]: bigint }` 記錄該行看過的**最小位址**。每次停在 for 行時先更新 `min = min(舊值, 目前位址)`，再判定：目前位址等於最小值 → **A**，否則 → **C**。

`frame.addr` 是十六進位字串（如 `"0x0000555555555158"`），一律以 `BigInt(addr)` 轉成數值再比較，不要用字串比大小。

先更新再判定使這個規則能自我修正：若使用者把中斷點設在迴圈中間、第一次停到的是遞增區塊，該次會誤報 A；但迴圈重新進入時初始化區塊的較低位址會把 min 拉下來，之後判定即恢復正確。

刻意不用既有的 `__line_visit_count`（`Actions.ts:85`）：迴圈巢狀、或同一個函式被呼叫第二次時，內層 for 的初始化會再跑一次，計數法會把它誤判成 C；位址法天然正確，因為初始化區塊的位址是固定的。

**已知假設：** 初始化區塊的位址低於遞增區塊。這在 `-O0` 成立（編譯器按原始碼順序配置），本專案本來就假設 `-O0`（BST 視覺化的說明文字已明寫「無旋轉」的同類假設）。若 `frame.addr` 缺失則退回「該行第一次停 → A」。

### ③ 虛步狀態機

新增 store key `for_sub_step`：`{ line: number; seg: 'A' | 'B' | 'C' } | null`。

- **每個真正的 GDB 停駐點**（`Actions.inferior_program_paused`）重算一次：該行 `parseForHeader` 成功 → 依 ② 設成 A 或 C；否則設 `null`。
- **攔截 `GdbApi.click_next_button()`**（`GdbApi.tsx:670`）：目前 seg 是 A 或 C → 只把 seg 換成 B、重繪、**不送 `-exec-next`**；目前是 B → 清空 seg、送出真正的 `-exec-next`。
- `reverse === true`（反向單步）直接跳過整個機制。

手動 Next（`ControlButtons.tsx:56`）與自動播放（`GdbApi.tsx:1026` 的 `gdbgui_run_autoplay_command`）最後都呼叫 `click_next_button()`，所以攔這一個點就同時涵蓋兩條路徑。

### ④ 自動播放的接續（必要，否則教案會卡死）

虛步不產生 GDB pause → 不會觸發新的 TTS → 沒有人排下一個命令 → 播放停住。

`click_next_button(reverse = false, opts = {})` 新增 `opts.autoplay`，由 `gdbgui_run_autoplay_command` 的 `case "next"` 傳入 `true`。當一次呼叫被虛步消耗**且** `opts.autoplay` 為真時，在停留 `FOR_SUBSTEP_DWELL_MS`（800ms，與現有動畫結果停留一致）後自行再呼叫一次 `click_next_button(false, { autoplay: true })`。

手動點擊不排接續——使用者自己按下一步。

### ⑤ 高亮

在現有整行 `paused_on_line` 裝飾（`SourceCode.tsx:455-462`，`isWholeLine: true`）之上，**多疊一個** `inlineClassName` 的字元範圍裝飾。這個 codebase 已經在用字元範圍裝飾（`SourceCode.tsx:152` 的指令註解），不是新機制。

CSS class `for_seg_active` 加在 `gdbgui.css`，沿用既有 `--highlight-*` token，不引入新顏色。`SourceCode` 透過 `store.connectComponentState` 觀察 `for_sub_step` 觸發重繪。

## Scope / 非目標

- **不支援** range-for、while、do-while、多行 for 標頭 —— 一律回 `null` 走現有行為。
- **虛步不支援 `//@` 註解。** `//@` 目前一行一組，B 是同一行的虛步。v1 虛步只高亮、不講話、不顯示 guide。要讓 B 有自己的旁白需要擴充註解語法，另案處理。
- 不改反向單步、不改 step-in / step-out / continue。
- 不動 `__line_visit_count`（`@N` 門檻只在真正的 GDB pause 遞增，行為不變）。

## 已知影響

**全域開啟**（使用者明確選擇）。現有教案含 for 迴圈者（`rec_knapsack`、`rec_knapsack_memo` 等）的 for 行會多出一個 B 步驟，播放節奏改變，需要重新驗收一次。`@N` 門檻不受影響。

## 驗證

**單元測試（`gdbgui/src/js/tests/forHeader.jest.ts`）** —— 解析器是唯一有真正邏輯的單元，測試主力：

1. 標準 `for (int i = 0; i < 3; i++)` 三段範圍正確
2. 巢狀括號 `for (int i = f(a, b); i < g(c); i += h(d))` 不被內層逗號/括號騙到
3. 字串含分號 `for (int i = 0; s != "a;b"; i++)` 不被字串裡的分號切開
4. range-for `for (auto x : v)` → `null`
5. `while (i < 3)` → `null`
6. `for (;;)` → 三段皆空範圍（非 null）
7. 多行 for 標頭（該行無配對右括號）→ `null`
8. 同一行有 for 之外的分號（`int a = 1; for (...)`）取到正確的那組

**A/C 判定單元測試** —— 餵位址序列，斷言 `A, C, C, C`；並含「迴圈重新進入」序列（回到最小位址）斷言重新判為 A。

**e2e（`e2e/tests/zz_for_substep.spec.ts`）** —— 用真 GDB 走一個三次迭代的 for 迴圈，斷言高亮段落序列為：

```
A, B, body, C, B, body, C, B, body, C, B, （條件不成立）離開迴圈
```

並斷言虛步期間 `paused_on_frame.line` **不變**（證明沒有送出 GDB 命令），以及自動播放模式下同一序列能自己跑完不卡住。
