# 編譯錯誤視覺化系統（設計）

日期：2026-10-30
狀態：草案，待使用者核准（HARD-GATE：核准前不寫產品程式碼）

## 1. 背景與目標

學生寫 C++ 時最常先遇到的是編譯錯誤。目前編譯器輸出的是純文字訊息，學生往往只看得懂第一行，
也不知道錯誤的根因在哪裡。目標是把編譯錯誤轉成**可以看見的圖像**：標出位置、畫出涉及的型別、
名稱、作用域或呼叫關係，讓學生理解「為什麼錯」，而不只是「錯在哪一行」。

成功的標準：
- 常見的 8 個錯誤家族，每一種都有對應的畫面，而不是只有原文訊息。
- 畫面以學生看得懂的中文說明為主，原始 clang 英文訊息保留在可展開的位置。
- 不改變編譯與執行的行為；視覺化只是讀取編譯器的輸出，不影響結果。

## 2. 範圍

**納入**：8 個家族（見第 4 節），以編譯器報出的 error 為主。

**預設決定（使用者已同意 8 個家族，以下兩項是我的預設，若有異議請告知）**：
- **警告（warning）**：不納入主線，改為獨立的「警告層」，預設收合，可以隱藏。第一期不做。
- **連結錯誤（undefined reference、多重定義）**：不納入。它來自連結器（wasm-ld），不是編譯器，留待之後。

**不納入**：執行期錯誤（記憶體、算術、流程、例外），它們有另一份規格；本文件只處理編譯階段。

## 3. 資料來源（已驗證）

引擎在瀏覽器內用 wasm 版 clang（`gdbgui/static/engine/driver.js`），可以取得兩種資料：

1. **stderr 診斷文字**：`clang++` 的錯誤與警告，格式為 `檔案:行:列: 嚴重度: 訊息`，後面可以跟著 `note:` 附註行。
   這是主要來源。`mapRunError` 目前已把它轉成 `compile` 錯誤並交給 CompileErrors 面板，行號已經可用。
2. **AST JSON**：`driver.js` 提供 `-fsyntax-only -Xclang -ast-dump=json`。它能提供名稱、型別、呼叫的結構化資料，
   用來把畫面畫具體（例如哪個函式、哪個參數型別）。**限制**：程式有錯時 AST 可能不完整，需要在實作前實測；
   若不完整，對應家族就只用 stderr 文字。

**訊息寫法以 clang 為準**。先前的示意圖用了 GCC 的寫法（例如 `was not declared in this scope`），
實作時要用 clang 的寫法，例如：
- `use of undeclared identifier 'cnt'`
- `no matching function for call to 'f'`
- `no member named 'size' in 'Foo'`
- `cannot initialize a variable of type 'int' with an lvalue of type 'const char[3]'`
- `redefinition of 'x'`
- `expected ';' after expression`

實際的字串要在第一期的語料測試中逐一確認，不以本文件的範例為準。

## 4. 八個家族與畫面規格

每個家族下面列出代表錯誤、所需畫面，以及和先前示意圖（01–10）的關係。
「沿用」代表直接用既有示意；「新增」代表要重新設計。

### 家族 1：名稱與作用域
- 未宣告的名稱（`use of undeclared identifier`）→ 沿用 02「作用域階梯」
- 超出作用域（迴圈變數在迴圈外使用）→ 沿用 03「生命範圍方框」
- 重複定義（`redefinition of`）→ 沿用 09「同名連線」
- 標頭缺失造成名稱消失（如 `unknown type name 'vector'`）→ 沿用 10「根因與連鎖」

### 家族 2：型別
- 型別不符（`cannot initialize a variable of type`）→ 沿用 01「型別並排」
- 窄化轉換（`implicit conversion loses integer precision`，通常是警告；若在 `{}` 初始化中則為 error）→ 沿用 07「位元條」
- 回傳型別不符（`cannot initialize return object of type`）→ 新增，沿用 01 的版型
- 指標與參考轉換（`invalid conversion from`）→ 新增

### 家族 3：語法
- 缺少分號（`expected ';'`）→ 沿用 04「預期符號」
- 語法連鎖（一個漏字引發後續多行錯誤）→ 沿用 10「根因與連鎖」
- 模板缺少 `typename`（`missing 'typename' prior to dependent type name`）→ 新增
- `case` 跨越初始化（`cannot jump from switch statement`）→ 新增

### 家族 4：函式呼叫與多載（新增）
- 參數數量或型別不符（`no matching function for call to`）→ 新畫面：**呼叫的實際參數與每個候選宣告並排比對**，不符處標紅。
- 二義性呼叫（`call to ... is ambiguous`）→ 新畫面：多個候選同時亮起。
- 呼叫不存在的成員（`no member named`）→ 沿用 10 或新增「成員清單」畫面

### 家族 5：模板與自動推導
- 模板實例化失敗（缺少 `operator<`，常見於 `std::sort`）→ 沿用 08「模板參數卡片」
- 自動推導失敗（`no matching function` 搭配模板參數、`'auto' ... cannot deduce`）→ 新增，沿用 08 版型
- 運算子不支援（`invalid operands to binary expression`、`no viable overloaded '<<'`）→ 新增：兩邊的型別與可用運算子清單

### 家族 6：const 與存取權限
- 修改常數（`cannot assign to variable 'N' with const-qualified type`）→ 沿用 05「上鎖方塊」
- 捨棄限定詞（`discards qualifiers`，clang 寫法為 `discards qualifiers`）→ 新增：const 物件與被呼叫函式的「不保證不修改」標記
- 存取 private 成員（`is a private member of`）→ 新增：類別欄位表，private 欄位上鎖
- 靜態上下文使用非靜態成員（`call to non-static member function without an object argument`）→ 新增

### 家族 7：類別與繼承（新增）
- 不完整型別（`incomplete type`）→ 新增：型別只有前向宣告的方框
- 抽象類別實例化（`allocating an object of abstract class type`）→ 新增：列出未覆寫的純虛函式
- 覆寫不符（`marked 'override' but does not override any member`）→ 新增：基底與衍生的簽名並排比對
- 建構子參數不符 → 沿用家族 4 的呼叫畫面

### 家族 8：流程與回傳
- 缺少回傳值（警告 `non-void function does not return a value`，在 clang 中多為警告）→ 沿用 06「流程圖出口」。**注意**：clang 預設把它當警告，若要在主線顯示，需要說明它是警告。
- Lambda 回傳或捕捉錯誤（如 `variable 'x' cannot be implicitly captured`）→ 新增
- 陣列大小不是常數（`variable length arrays`，`size of array has non-integral type`）→ 新增
- `goto` 或 `case` 跨越初始化 → 與家族 3 的 `case` 共用畫面

## 5. 架構

三層，前兩層是純函式，方便測試：

1. **解析層** `compileDiag.ts`：把 stderr 文字解析成 `Diagnostic[]`，欄位為
   `{ severity: "error"|"warning"|"note", file, line, col, message, notes: Diagnostic[] }`。
   純字串處理，不碰 store、不碰 DOM。
2. **分類層** `compileFamily.ts`：依訊息（以正規表示式比對）決定家族與子類型，輸出
   `{ family: 1..8 | "other", kind: string }`。未知的訊息一律歸為 `other`，顯示原文，不得丟掉。
3. **畫面層**：每個家族一個 React 元件，接收 `Diagnostic` 與可選的 AST 片段，回傳視覺化。
   統一的外框顯示：中文標題、一句話說明、畫面、可展開的「原始 clang 訊息」。

接入點：現有的 CompileErrors 面板。第一期先在它旁邊加入視覺化區塊，不取代原文列表。

## 6. 分期與驗收

**第一期：家族 1、2、3**（對應示意 01–04、07、09、10，改用 clang 訊息）
- 驗收：語料中每一種 clang 訊息都有 `family/kind` 對應；`other` 的比例低於約定值（實作前定）；
  每個家族至少一個 e2e 測試，確認畫面出現在編輯器的編譯錯誤區。

**第二期：家族 4、5、6**
- 驗收：多載與模板的畫面能列出所有候選，而不是只取第一個；const 與權限的畫面在不同編譯器版本下訊息一致（以固定版本為準）。

**第三期：家族 7、8**
- 驗收：類別與流程的畫面能在範例教案中找到對應的錯誤，並有測試。

每一期結束前，全部既有的 Jest 測試與相關 e2e 必須通過，才算完成。

**每一期的設計交付物（必備）**：每一期開始製作時，都要用 Claude Design 畫出**該期所有預期的錯誤示意圖**，
作為該期的設計依據與驗收基準。具體規定：
- 每一期一張 Claude Design 畫布（canvas），畫板涵蓋該期列在第 4 節的**每一種**錯誤（不是只畫代表性的幾種）。
- 每一張畫板都要包含：錯誤的 clang 原始訊息、中文說明、以及對應的視覺化畫面。
- 畫布連結要寫在該期的計畫文件中，並在該期驗收時一併交付。
- 實作時的畫面必須與畫布一致；若實作中發現畫板不可行，先更新畫布並回報，不得默默偏離。
- 第一期畫布以 clang 訊息為準，不沿用先前 GCC 寫法的示意圖。

先前已做的 10 種示意圖（連結 `K78gmFpW5XHiNUDH3TYWC8`）是探索用，不作為任何一期的正式交付；
各期的正式畫布在該期開始時另建。

## 7. 測試策略

- **語料測試**：每個錯誤種類一個小的 `.cpp` 檔，加上預期的 `family/kind`。語料放在 `tests/compile-diag/`。
- **單元測試（Jest）**：解析層與分類層的純函式測試。
- **e2e**：在編輯器中放入語料程式，確認畫面出現，且原文訊息仍可展開。

## 8. 風險

- **clang 訊息會隨版本改變**：引擎使用的是固定版本的 browsercc，所以以它為準；升級時要重跑語料。
- **AST 在有錯的程式上可能不完整**：第一期先只用 stderr 文字；AST 只在確認可靠後用於豐富畫面。
- **中文化的準確性**：中文說明是我們寫的，必須與 clang 原文對應，並保留原文供查證。
- **工作量**：8 家族約 40 種錯誤，分期實作可以把風險拆開。

## 9. 待使用者決定

1. 警告層：第一期是否就做，還是等到第二期？（目前預設：第一期不做）
2. 中文說明的語氣：偏向給學生的白話，還是保留編譯器術語？（目前預設：白話＋術語在括號中）
3. 錯誤原文的位置：預設收合在每個畫面的底部，是否同意？

## 10. 非目標

- 不改變編譯流程，不改 clang 參數。
- 不做自動修正（fix-it 應用）。第一期只顯示，不改程式碼。
- 不做連結錯誤與執行期錯誤（另有規格）。
