# 編譯錯誤視覺化 第三期 Implementation Plan（草案）

> 狀態：草案，待使用者核准。核准前不寫產品程式碼。執行方式比照第一、二期（先 Task 0 實測，再依序實作）。

**Goal:** 完成家族 7（類別與繼承）與家族 8（流程與回傳）的編譯錯誤視覺化，並附上該期的 Claude Design 畫布（涵蓋本期所有預期的錯誤示意圖）。第三期完成後，8 個家族全部可視覺化。

**Architecture:** 沿用前兩期的三層（解析、分類、畫面）與錨點規則。第三期沒有新的架構機制，但有兩個處理細節：
1. **附註過濾**：`lambda-capture` 的附註會列出大量 `capture ... by value` 的建議，只保留 `declared here` 與 `lambda expression begins here`。
2. **警告**：`missing-return` 與函式內的 VLA 在 clang 中是警告，需要決定是否納入（見「需要你先決定的問題」）。

**Spec:** `docs/superpowers/specs/2026-10-30-compile-error-visualization-design.md`（第 4 節家族 7、8 的內容，以本計畫的實測結果為準）。

## 已採用的預設

- 警告層（一般警告）：第三期不做。
- 中文說明：白話為主，術語放在括號中；原始 clang 訊息收合在底部。

## 本期的錯誤種類（Task 0 已實測）

語料：`tests/compile-diag/family7/*.cpp`、`family8/*.cpp`，以 `node tests/compile-diag/probe.mjs family7` 等實測。

| kind | family | clang 實測訊息（第一條） | 附註 |
|---|---|---|---|
| incomplete-type | 7 | `variable has incomplete type 'Node'` | `forward declaration of 'Node'` |
| abstract-class | 7 | `variable type 'Shape' is an abstract class` | `unimplemented pure virtual method 'area' in 'Shape'` |
| override-mismatch | 7 | `'paint' marked 'override' but does not override any member functions`；或 `only virtual member functions can be marked 'override'` | 無 |
| missing-return | 8 | **警告** `non-void function does not return a value in all control paths [-Wreturn-type]` | 無（待決定，見下） |
| lambda-capture | 8 | `variable 'n' cannot be implicitly captured in a lambda with no capture-default specified` | `'n' declared here`、`lambda expression begins here`，另有大量 `capture ... by value/reference` 建議（過濾） |
| lambda-return | 8 | `return type 'const char *' must match previous return type 'int' when lambda expression has unspecified explicit return type` | 無 |
| goto-jump | 8 | `cannot jump from this goto statement to its label` | `jump bypasses variable initialization` |
| vla-file-scope | 8 | `variable length array declaration not allowed at file scope`（同時伴隨一條警告） | `read of non-const variable 'n' is not allowed in a constant expression`、`declared here` |

**與先前設計文件的差異（以實測為準）**：
- `missing-return`：設計文件寫成家族 8 的主線，但 clang 只給**警告**。
- 「陣列大小不是常數」：設計文件的寫法不成立。函式內的非常數陣列大小（`int a[n];`）clang 只給**警告**（`-Wvla-cxx-extension`，它把 VLA 當成擴充功能）；**全域**的非常數陣列大小才是錯誤。第三期只畫全域的錯誤版本。
- `override`：有兩種訊息，要分別處理（不是只有一種）。

## 需要你先決定的問題

1. **missing-return（警告）**：這是家族 8 唯一的警告。
   - 預設：**不納入**，等之後的警告層一起做（家族 8 第三期只有 4 種錯誤）。
   - 另一選擇：只把這一種以「警告」樣式納入，其他警告仍不做。
   你要哪一種？
2. **函式內的非常數陣列（VLA）**：clang 只給警告，程式能編譯。
   - 預設：**不顯示**（屬於警告層）。
   - 另一選擇：也用警告樣式顯示。
3. **lambda 附註**：預設只保留 `declared here` 與 `lambda expression begins here`，過濾掉所有 `capture ...` 建議。同意嗎？

## 任務（草案）

### Task 0：實測 — 已完成
語料與實測結果見上表。

### Task 1：解析層
- 無新需求。補測試：lambda 的多個附註、警告與錯誤混合的 stderr。

### Task 2：分類層
- 新增 kind：`incomplete-type`、`abstract-class`、`override-mismatch`（兩種訊息）、`lambda-capture`、`lambda-return`、`goto-jump`、`vla-file-scope`。
- `missing-return`：依問題 1 的決定，要嘛不分類（other），要嘛歸為 family 8 的警告。
- 附註過濾：`lambda-capture` 只保留 `declared here` 與 `begins here`。
- 測試：表格驅動，以上表的實測訊息為準。

### Task 3：畫面元件
- 每個 kind 一個畫面（與第三期畫布一致）。
- `lambda-capture`：顯示捕捉的變數與 lambda 的開始位置，並說明解法（加 `[n]` 或 `[&n]`）。

### Task 4：接入 CompileErrors 面板
- 沿用前兩期的接入方式。警告的處理依問題 1 的決定。

### Task 5：回歸與驗收
- 全部 Jest、既有 e2e 回歸（比對 HEAD 基準）。
- 每個家族至少一個 e2e（家族 7、8 各一）。
- 畫布與實作逐一比對。
- 獨立 verifier 驗收。

## 畫布

Claude Design 畫布連結：https://claude.ai/artifact/JvSvP32rfo6zVtupFNZjRi（總覽 + 8 張畫板，對應上表 8 種 kind；8-1 缺少回傳以警告樣式標示，待決定；私人，要分享請從頁面的 Share 選單操作）

## 不在本期範圍

- 一般警告層（包括函式內的 VLA 警告，除非問題 2 決定納入）。
- 連結錯誤與執行期錯誤。
- 第三期完成後，8 個家族的全部範圍就完成了，之後的工作是回歸、整體的一致性檢查，以及（若需要）警告層。
