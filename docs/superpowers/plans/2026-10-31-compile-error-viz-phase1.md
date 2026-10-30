# 編譯錯誤視覺化 第一期 Implementation Plan

> **For agentic workers:** 依 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 執行。步驟使用 checkbox 追蹤。

**Goal:** 完成家族 1（名稱與作用域）、家族 2（型別）、家族 3（語法）的編譯錯誤視覺化，並附上該期的 Claude Design 畫布。

**Architecture:** 純函式的解析層（stderr → Diagnostic）與分類層（訊息 → family/kind），以及依 family 分派的畫面元件，接入現有 CompileErrors 面板（不取代原文列表）。

**Tech Stack:** TypeScript / TSX（gdbgui 前端）、Jest（`gdbgui/src/js/tests/`）、Playwright e2e（`e2e/tests/zz_*.spec.ts`）、語料 `tests/compile-diag/`。

**Spec:** `docs/superpowers/specs/2026-10-30-compile-error-visualization-design.md`

## 已採用的預設（核准時使用者未另行回覆）

- 警告層：第一期不做。
- 中文說明：白話為主，術語放在括號中。
- 原始 clang 訊息：收合在每個畫面的底部。

## 本期的錯誤種類（13 種，對應 Claude Design 畫布的 13 張畫板）

| kind | family | clang 訊息（Task 0 實測，見 `tests/compile-diag/expected.json`） |
|---|---|---|
| undeclared | 1 | `use of undeclared identifier 'cnt'` |
| out-of-scope | 1 | `use of undeclared identifier 'i'`（與 undeclared 相同文字；需掃描原始碼判斷名稱在別處宣告過） |
| redefinition | 1 | `redefinition of 'x'` + note `previous definition is here` |
| missing-include | 1 | `use of undeclared identifier 'std'`（根因），後面接連鎖錯誤 |
| init-type | 2 | `cannot initialize a variable of type 'int' with an lvalue of type 'const char[3]'` |
| ptr-value | 2 | `cannot initialize a variable of type 'int *' with an lvalue of type 'int'` |
| return-type | 2 | `cannot initialize return object of type 'int' with an lvalue of type 'const char[7]'` |
| narrowing | 2 | `non-constant-expression cannot be narrowed from type 'int' to 'char' in initializer list [-Wc++11-narrowing]` + note `insert an explicit cast` |
| missing-semicolon | 3 | `expected ';' at end of declaration`（fix-it 插入 `;`） |
| missing-paren | 3 | `expected ')'` + note `to match this '('` |
| syntax-chain | 3 | `expected ';' at end of declaration` 出現多次（兩處獨立的缺分號，並非逐層連鎖） |
| missing-typename | 3 | `missing 'typename' prior to dependent type name 'C::iterator'`（fix-it 插入 `typename `） |
| case-jump | 3 | `cannot jump from switch statement to this case label` + note `jump bypasses variable initialization` |

**Task 0 的發現（已修正上表）**：
- clang 會附上 fix-it 修正建議（`;`、`typename `、`static_cast<char>( )`），可直接用於視覺化。
- 字串常值是 `lvalue`（`const char[N]`），不是 `rvalue`。
- 缺少分號的訊息在全域範圍與函式內不同（`after top level declarator` / `at end of declaration`）。
- 缺少右括號的樣本必須放在函式內，放在全域會變成 `expected unqualified-id`。
- 缺少標頭的第一個錯誤是 `'std'`，不是 `'vector'`。

## 任務

### Task 0：確認 clang 的實際訊息（語料）

**Files:**
- Create: `tests/compile-diag/family1/*.cpp`、`family2/*.cpp`、`family3/*.cpp`（每種一個檔）
- Create: `tests/compile-diag/expected.json`（每個檔的預期 `family`、`kind`、`message` 的開頭字串）

- [ ] **Step 1：為每種錯誤寫一個最小的 `.cpp`**
- [ ] **Step 2：用引擎的 clang（`gdbgui/static/engine/driver.js` 的 `syntaxOnly` 或同等入口）跑每個檔，取得 stderr**
  實際能否在 Node 中跑，要先確認；若不能，改在正式機的測試目錄跑（沿用前幾期的做法）。
- [ ] **Step 3：把實際訊息寫入 `expected.json`**，與上表不同的，以實際為準並更新本計畫。

### Task 1：解析層 `compileDiag.ts`（純函式）

**Files:**
- Create: `gdbgui/src/js/compileDiag.ts`
- Test: `gdbgui/src/js/tests/compileDiag.jest.ts`

**Interfaces:**
- Produces: `parseCompileDiagnostics(stderr: string): Diagnostic[]`，其中 `Diagnostic = { severity: "error"|"warning"|"note"; file: string; line: number; col: number; message: string; notes: Diagnostic[] }`

- [ ] **Step 1：寫測試**：單一 error、error 後接 note、多個 error、無法解析的行被略過而不丟出例外。
- [ ] **Step 2：確認測試失敗**
- [ ] **Step 3：實作**（逐行比對 `file:line:col: severity: message`，`note:` 行歸屬前一個 diagnostic）
- [ ] **Step 4：確認測試通過**

### Task 2：分類層 `compileFamily.ts`（純函式）

**Files:**
- Create: `gdbgui/src/js/compileFamily.ts`
- Test: `gdbgui/src/js/tests/compileFamily.jest.ts`

**Interfaces:**
- Consumes: Task 1 的 `Diagnostic`
- Produces: `classifyDiagnostic(d: Diagnostic): { family: 1|2|3|"other"; kind: string }`

- [ ] **Step 1：寫測試**：表格驅動，每個 kind 一筆（以 Task 0 的實際訊息為準）；未知訊息回傳 `family: "other"`。
- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**（正規表示式表，順序敏感：`out-of-scope` 需要判斷名稱是否在別處宣告，第一期以語料中的訊息差異區分；若訊息完全相同，`out-of-scope` 與 `undeclared` 以 AST 或原始碼比對，此點在 T0 決定）
- [ ] **Step 4：確認通過**

### Task 3：畫面元件

**Files:**
- Create: `gdbgui/src/js/CompileDiagView.tsx`（依 family 分派；每個 kind 一個小元件或一個共用版型）
- Test: `gdbgui/src/js/tests/CompileDiagView.jest.ts`

- [ ] **Step 1：測試**：每個 kind 渲染出中文標題、白話說明、視覺化區塊，並有可展開的原始訊息。
- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**，畫面與本期 Claude Design 畫布一致（見下方「畫布」）。
- [ ] **Step 4：確認通過**

### Task 4：接入 CompileErrors 面板

**Files:**
- Modify: 現有 CompileErrors 面板（先在 T0 前確認其檔名與掛載點）

- [ ] **Step 1：e2e 測試**：在編輯器放入一個 kind 的語料程式，按執行，確認視覺化區塊出現，且原文列表仍在。
- [ ] **Step 2：確認失敗**
- [ ] **Step 3：接入**，原文列表保留，視覺化區塊放在其上方。
- [ ] **Step 4：確認 e2e 通過**

### Task 5：回歸與驗收

- [ ] **Step 1：全部 Jest 通過**（`npx jest`）
- [ ] **Step 2：相關既有 e2e 通過**
- [ ] **Step 3：畫布與實作一致**：逐一比對 13 張畫板與畫面；不一致的先更新畫布並回報。
- [ ] **Step 4：fresh-context verifier 驗收**

## 畫布

Claude Design 畫布連結：https://claude.ai/artifact/6MD8K1Y6BrFeYpVoiCxRZu（13 張畫板，對應上表 13 種 kind；私人，要分享請從頁面的 Share 選單操作）

畫布與實作的一致性：實作時每個畫面都要對照此畫布；若不可行，先更新畫布並回報。

## 不在本期範圍

- 家族 4–8（第二、三期）。
- 警告層（第二期或之後，待使用者決定）。
- 連結錯誤與執行期錯誤。
- 任何自動修正（fix-it）。
