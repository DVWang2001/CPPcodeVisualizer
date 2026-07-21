# 三維狀態 DP 教案（0/1 背包·雙限制）Design

**Date:** 2026-07-21
**Status:** Draft, pending user review
**Builds on:** 遞迴 taxonomy 路線圖（`2026-07-19-recursion-coverage-roadmap-design.md`）；沿用 P1–P3 已建的呼叫樹、幽靈預跑、×N 配對，**不新增任何視覺化功能**。

## 目標

用經典 0/1 背包（最有名的 DP 之一）的**雙限制版**當教案，讓使用者觀看「三維狀態」的呼叫樹生長、看到重疊子問題（×N 徽章），並用 naive / 記憶化兩版對照演出 DP 的價值。

## 交付物（都是 JSON bundle — 使用者按 Import JSON 載入）

- `examples/cpp/rec_knapsack.gdbgui.json`（naive）
- `examples/cpp/rec_knapsack_memo.gdbgui.json`（記憶化）
- 對應的 `.cpp` 來源（`rec_knapsack.cpp` / `rec_knapsack_memo.cpp`）保留在 `examples/cpp/` 當可編輯來源；bundle 的 `source_code` 欄位即帶 `//@` 註解的完整原始碼。
- bundle 由 scratchpad 的 `make-bundles.js` 從 `.cpp` 產生（斷點 = 遞迴函式入口行），沿用既有 v2 格式。

## 問題與遞迴

物品 3 種：`wt[]={2,2,1}`、`vol[]={1,1,2}`、`val[]={3,2,2}`；預算 `W=4, V=3`。

```cpp
int knap(int i, int w, int v) {              // 用第 i 件之後、剩重量 w 剩體積 v，能拿的最大價值
    int result;
    if (i == N) { result = 0; return result; }
    int skip = knap(i + 1, w, v);            // 不拿第 i 件
    int take = 0;
    if (w >= wt[i] && v >= vol[i])           // 拿得下才拿
        take = val[i] + knap(i + 1, w - wt[i], v - vol[i]);
    result = (skip > take) ? skip : take;    // 取較大
    return result;
}                                            // 呼叫 knap(0, 4, 3)
```

狀態 `(i, w, v)` 三維，三個維度都在變（i 每層 +1；拿物品時 w、v 各減）。

## 教學重點：重疊子問題

物品 0 與物品 1 的 `(重量,體積)` 都是 `(2,1)`，故「只拿其中一件」的兩條路都抵達
**`knap(2, 2, 2)`** → ×2 徽章亮在此節點。

- **Naive 版**（`rec_knapsack.cpp`）：`knap(2,2,2)` 整棵子樹被展開兩次；手算 ≈14 節點（深度 3、每層 ≤2 有效分支）。
- **記憶化版**（`rec_knapsack_memo.cpp`）：第二個 `knap(2,2,2)` 命中記憶表、收成葉節點、不再展開；手算 ≈12 節點。並排即 DP 故事。

> **實作第一步必做**：把 naive `.cpp` 放進容器用 `gdb --batch` 實跑（即 `/api/prerun_calltree` 的機制），核對真實節點數與 `knap(2,2,2)` 確實出現兩次。手算僅供設計，數字以實跑為準；若實跑與預期差異大（例如 >30 或無重疊），調整 `wt/vol/val/W/V`。

## 硬規則（全部沿用，見 AUTHORING_GUIDE §1.2–§1.4）

- 全自動播放：每個 GDB 停駐行都有 `@tts` 且以 `[next]/[step-in]/[continue]` 開頭；最後停駐點 `[continue]` 收尾。
- `result` 在函式最外層宣告一次；賦值行不自引用 `{變數}`。
- **多分支拆行**：`skip` 與 `take` 各自獨立成行、存具名變數；兩者都是「呼叫行」（去程+回程），訊息**方向中性**、用 `[step-in]`。
- `take` 的條件式（拿得下才拿）：`if` 行與 take 呼叫行都要註解；item 拿不下時 take 行不會被停駐，不影響自動播放。
- main 的 `knap(0,4,3)` 呼叫行必停兩次，用 `@2` 門檻分出發/返回。
- 斷點設在 `int knap(...)` 入口行。
- 記憶化版：`memo` 陣列以 `(i,w,v)` 為索引、初值哨兵（如 -1）；memo 命中時 `result = memo[..]; return result;`（該次呼叫即成葉節點）。索引前 `w,v` 保證 ≥0（超支在更前面已 `take` 條件擋掉，不會用負索引）。

## Scope / 非目標

- 不建 F3（綠色 memo 節點）；記憶化命中就是「有 ×N 徽章的葉節點」，用現有渲染即可。
- 不改任何前端/後端程式碼；純教案內容（`.cpp` + bundle）。
- 只做 naive + memo 兩份；不做 bottom-up 表格版（那不是遞迴樹，離題）。

## 測試 / 驗收

- 編譯驗證：兩份 `.cpp` 以 `g++ -g -O0` 編譯並執行，輸出正確的最大價值。
- 容器 gdb 實跑核對節點數與重疊（見上）。
- 使用者驗收：Import 兩個 bundle → Run → 全自動播放；naive 看到 `knap(2,2,2)` ×2 與整棵重複子樹，memo 看到第二個收成葉節點；全程不跳、幽靈骨架先出現。
