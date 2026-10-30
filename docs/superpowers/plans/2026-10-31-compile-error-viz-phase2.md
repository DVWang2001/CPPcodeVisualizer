# 編譯錯誤視覺化 第二期 Implementation Plan（草案）

> 狀態：草案，待使用者核准。核准前不寫產品程式碼。執行方式比照第一期（先 Task 0 實測，再依序實作）。

**Goal:** 完成家族 4（函式呼叫與多載）、5（模板與自動推導）、6（const 與存取權限）的編譯錯誤視覺化，並附上該期的 Claude Design 畫布（涵蓋本期所有預期的錯誤示意圖）。

**Architecture:** 沿用第一期的三層（解析層、分類層、畫面層）。第二期新增兩個機制：
1. **候選清單**：多載與模板錯誤會附上多個 `note: candidate ...`，畫面要並排列出每個候選與實際呼叫的參數。
2. **錨點規則**：模板實例化的錯誤出現在標頭檔（`/include/c++/...`），不在使用者的程式中。畫面要以使用者檔案中的 `in instantiation ... requested here` 附註為錨點，指出根因。

**Spec:** `docs/superpowers/specs/2026-10-30-compile-error-visualization-design.md`（第 6 節的每期畫布要求同樣適用）。

## 已採用的預設

- 警告層與連結錯誤、執行期錯誤：不做（沿用第一期的決定）。
- 中文說明：白話為主，術語放在括號中；原始 clang 訊息收合在底部。

## 本期的錯誤種類（12 種，Task 0 已實測）

以 `tests/compile-diag/family4–6/*.cpp` 為語料（已建立），用引擎的 clang 實測（`node tests/compile-diag/probe.mjs family4`，同 family5、family6）。

| kind | family | clang 實測訊息（第一條） | 附註 |
|---|---|---|---|
| no-matching-call | 4 | `no matching function for call to 'add'` | `candidate function not viable: requires 2 arguments, but 1 was provided` |
| ambiguous-call | 4 | `call to 'f' is ambiguous` | 每個候選一條 `note: candidate function` |
| no-member | 4 | `no member named 'length' in 'Box'` | 無 |
| no-matching-ctor | 4 | `no matching constructor for initialization of 'Point'` | 候選含**隱含的複製/移動建構子雜訊**，需過濾，只保留使用者宣告的建構子 |
| deduction-failed | 5 | `no matching function for call to 'make'` | `candidate template ignored: couldn't infer template argument 'T'` |
| template-operator | 5 | `invalid operands to binary expression ('const Card' and 'const Card')`（位於 `/include/c++/...`） | 使用者檔案中的 `in instantiation of function template specialization 'std::sort<...>' requested here` 為錨點 |
| auto-no-init | 5 | `declaration of variable 'x' with deduced type 'auto' requires an initializer` | 無 |
| binary-operator | 5 | `invalid operands to binary expression ('Card' and 'Card')` | 無（位於使用者檔案） |
| const-assign | 6 | `cannot assign to variable 'N' with const-qualified type 'const int'` | `variable 'N' declared const here` |
| discards-qualifiers | 6 | `'this' argument to member function 'bump' has type 'const Counter', but function is not marked const` | `'bump' declared here` |
| private-access | 6 | `'balance' is a private member of 'Account'` | `implicitly declared private here` |
| static-context | 6 | `call to non-static member function without an object argument` | 無 |

**與第一期的差異（需要注意）**：
- `discards-qualifiers` 的訊息不是 `discards qualifiers`。以實測為準。
- `template-operator` 的完整輸出超過一百行，多數來自標頭檔。解析層仍會把它們解析成診斷，但**分類與畫面必須以使用者檔案的錨點為準**，不能把標頭內的每一行都畫出來。

## 需要你先決定的問題

1. **模板錯誤的畫面**：預設是只畫一個畫面（錨點 + 根因訊息 + 「錯誤發生在標準函式庫內部」的說明），標頭內的其他診斷收合。同意嗎？
2. **候選清單的上限**：多載候選很多時（例如 `std::` 的多載），預設只畫前 5 個並顯示「還有 N 個」，原文完整收合。同意嗎？
3. **隱含建構子**：預設過濾掉 `implicit copy/move constructor`，不顯示。同意嗎？

## 任務（草案）

### Task 0：實測 — 已完成
語料與實測結果見上表。

### Task 1：解析層擴充
- 解析層已支援 `note:` 歸屬。第二期需要：辨識 `In file included from` 行（忽略）、保留附註的 `file`，供錨點判斷使用。
- 測試：含標頭路徑的 stderr、多層 `note: in instantiation of`。

### Task 2：分類層擴充
- 新增 kind：`no-matching-call`、`ambiguous-call`、`no-member`、`no-matching-ctor`、`deduction-failed`、`template-operator`、`auto-no-init`、`binary-operator`、`const-assign`、`discards-qualifiers`、`private-access`、`static-context`。
- `template-operator` 與 `binary-operator` 的訊息相同，只差位置（標頭 vs 使用者檔案），分類要看位置。
- 測試：表格驅動，每個 kind 一筆，以上表的實測訊息為準。

### Task 3：畫面元件擴充
- 候選清單（並排列出每個候選的宣告與參數，不符處標紅）。
- 錨點畫面（模板錯誤）。
- 每個 kind 的畫面與第二期畫布一致。

### Task 4：接入 CompileErrors 面板
- 沿用第一期的接入方式，不改變原文列表。

### Task 5：回歸與驗收
- 全部 Jest、既有 e2e 回歸（同第一期，比對 HEAD 基準）。
- 每個家族至少一個 e2e（家族 4、5、6 各一）。
- 畫布與實作逐一比對。
- 獨立 verifier 驗收。

## 畫布

Claude Design 畫布連結：（待本計畫核准後建立，涵蓋上表 12 種 kind 的示意）

## 不在本期範圍

- 家族 7（類別與繼承）、家族 8（流程與回傳）：第三期。
- 警告層、連結錯誤、執行期錯誤。
