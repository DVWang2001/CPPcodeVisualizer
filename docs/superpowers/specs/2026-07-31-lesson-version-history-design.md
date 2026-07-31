# 教案版本歷史與提交前差異

2026-07-31

## 要解決什麼

「存到我的帳號」目前直接覆寫教案。使用者看不出這次到底改了哪些行，也不能回到
先前內容。這和 Git 的工作流程差一個關鍵步驟：先看 diff，再確認提交；提交後保留
可回看的歷史。

本功能把教案編輯流程改為：**工作區 → 檢視變更 → 確認提交 → 版本紀錄 → 還原到
工作區**。它讓使用者能從原始碼、`//@` 行內註解和標題的變化，練習理解類似 Git
commit 的概念。

## 不做什麼

* 不做提交訊息。版本號與時間已足以辨識這個教學範圍內的提交；使用者明確不需要它。
* 不儲存 diff patch；每版存完整快照。幾十 KB 的教案以完整快照換取可靠還原，比自己
  套 patch 更簡單也更不容易壞。
* 不做分支、合併、多人衝突解決或版本刪除。最後寫入者成為目前版本，但每次成功寫入
  前的版本仍留在歷史中，可以還原。
* 不公開版本歷史。公開的是教案目前版本；只有擁有者能看自己的歷史。

## 使用者流程

### 儲存／提交

1. 使用者在 `/edit?lesson=<id>` 編輯教案後按「儲存到我的帳號」。
2. 原有的標題輸入保留。新教案直接建立第 1 版；既有教案則進入「提交變更」視窗。
3. 視窗先顯示標題的舊值與新值，再以 Monaco 的左右並列 diff editor 顯示：左邊是
   上次提交版本，右邊是工作區內容。`//@` 註解本來就在 source code 字串裡，因此和
   程式碼一起逐行標示新增、刪除或修改。
4. 「取消」只關閉視窗；「確認提交」才呼叫現有的教案寫入 API。
5. 成功後，更新目前教案並新增下一版歷史快照。若標題與 bundle 都沒有變化，顯示
   「沒有變更可提交」，不呼叫 API、不新增空版本。

### 版本紀錄與還原

編輯器旁有「版本紀錄」按鈕，只在載入既有、且屬於目前使用者的教案時顯示。打開後：

* 依新到舊列出 `v3`、`v2`、`v1` 與提交時間。
* 選取 `vN` 時，顯示它相對 `v(N-1)` 的標題與逐行差異；`v1` 標記為初始版本。
* 「還原此版本」只將該快照填回編輯器工作區，並關閉歷史視窗；它不會直接寫入伺服器。
  使用者仍需走一次儲存、差異預覽和確認提交，還原結果會成為新的版本，原有歷史不變。

## 資料與 API

新增 migration 建立歷史快照表：

```sql
CREATE TABLE IF NOT EXISTS lesson_versions (
    id          INTEGER PRIMARY KEY,
    lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    bundle_json TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (lesson_id, version)
);

CREATE INDEX IF NOT EXISTS lesson_versions_lesson_idx
    ON lesson_versions (lesson_id, version DESC);
```

`lesson_versions` 不複製 `user_id`：擁有權已由 `lessons.user_id` 作為唯一真相，避免兩份
資料日後不一致。外鍵 CASCADE 讓刪除教案時快照一併刪除。

歷史快照也納入既有帳號儲存配額；一次提交若會超過配額，整筆 transaction 拒絕，
目前教案與版本紀錄都不變。這保留「每次成功提交都有版本」的承諾，同時避免無上限
歷史佔滿資料庫。

`db.create_lesson()` 會在同一個 transaction 建立 `lessons` 與 `v1`；
`db.update_lesson_owned_by()` 會在同一個 transaction 更新目前內容並插入版本號最大值加一
的快照。非擁有者 PUT 的既有 fork 行為沿用 `create_lesson()`，所以副本從自己的 v1 開始，
不會攜帶原作者歷史。

新增三條只讀端點，均使用既有登入驗證；GET 不需要 CSRF：

| 端點 | 回應 | 權限 |
|---|---|---|
| `GET /api/lessons/<id>/versions` | 版本號、時間清單 | 僅擁有者 |
| `GET /api/lessons/<id>/versions/<version>` | 該版 `title` 與 `bundle` | 僅擁有者 |
| `GET /api/lessons/<id>/versions/<version>/diff` | 該版與前一版的兩份快照 | 僅擁有者 |

不存在的教案、版本，或非擁有者，一律回 404。這和現有的敏感教案操作一致，不洩漏
目標是否存在。後端只回快照資料；逐行演算法和視覺呈現交給既有 Monaco 前端，避免
另造一套 diff 格式。

## 前端邊界

`SourceCode.tsx` 已是教案載入、bundle 組裝與儲存的唯一入口，因此它負責保留「最新
提交快照」並開啟兩個小型 React modal：

| 元件 | 職責 |
|---|---|
| `LessonCommitDialog` | 標題 old/new、Monaco diff editor、取消／確認提交 |
| `LessonHistoryDialog` | 讀取版本清單、選版的前後差異、還原到工作區 |
| `lessonVersion.ts` | 純函式：判斷 bundle/title 是否變更、把 snapshot 轉成 Monaco 使用的資料 |

差異 editor 使用既有 Monaco 依賴的原生 `DiffEditor`；不新增 diff 函式庫，也不手寫
LCS 演算法。`SourceCode.tsx` 只協調 API、工作區與 dialog，資料比較留在純函式中，
讓前端測試不需要掛載 Monaco。

最新版快照取自載入教案時的 GET 回應；第一次成功建立或更新後，直接用已提交的
title/bundle 更新前端基準。歷史選版的還原呼叫既有 `applyProjectBundle()`，因此 source
code、行內註解、程式輸入和斷點都一起回到該版。

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 工作區與最新提交完全相同 | 不送出；說明沒有變更可提交 |
| 取消預覽 | 不寫資料、不改目前基準 |
| 版本列表／快照讀取失敗 | 顯示錯誤，工作區不變 |
| 確認提交失敗 | 工作區與預覽維持，使用者可修正或重試 |
| 非擁有者請求歷史 | 404；不顯示版本紀錄按鈕 |
| 還原舊版 | 只改工作區；下一次確認提交才建立新版本 |

## 測試

### Python

* 建立教案會同時有唯一的 v1；更新會保留 v1 並建立 v2。
* 同一個 title/bundle 的更新不會由前端送出；若 API 仍收到它，也不新增空版本。
* 版本快照保存 title、`source_code`、`//@` 註解、program input 與 breakpoints。
* 刪除教案會 CASCADE 刪除其版本。
* 快照計入帳號配額；配額不足時目前教案與歷史都不變。
* 非擁有者列出或讀取版本得到 404；對他人教案的 PUT fork 產生自己的獨立 v1。
* API 回傳版本由新到舊排序，讀取不存在版本得到 404。

### Jest

* `lessonVersion.ts` 對相同／不同 title、原始碼、行內註解判斷正確。
* 還原快照會產生可交給 `applyProjectBundle()` 的原 bundle，不遺失欄位。

### E2E

* 修改標題、程式碼和 `//@` 註解後，按儲存會先見到 diff；取消後伺服器內容未變。
* 確認提交後，版本清單有 v2，且 v2 diff 顯示三種變更。
* 選 v1 還原只變工作區；確認下一次提交後出現 v3，v1/v2 仍可讀取。
* 非作者開啟同一公開教案時看不到原作者版本紀錄。

## 實作順序

1. migration、DB 快照讀寫與 API，先用 Python 測試鎖定交易與權限。
2. 純前端 snapshot 比較 helper 與 Jest。
3. 提交預覽 dialog，接入既有儲存流程。
4. 版本紀錄 dialog 與工作區還原。
5. E2E 涵蓋提交、取消、歷史和權限。
