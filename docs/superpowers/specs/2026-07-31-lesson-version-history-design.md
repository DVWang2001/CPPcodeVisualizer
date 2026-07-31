# 教案版本歷史與提交前差異

2026-07-31

## 要解決什麼

「存到我的帳號」目前直接覆寫教案。使用者看不出這次到底改了哪些行，也不能回到
先前內容。這和 Git 的工作流程差一個關鍵步驟：先看 diff，再確認提交；提交後保留
可回看的歷史。

本功能把教案編輯流程改為：**工作區 → 檢視變更 → 確認提交 → 版本紀錄／版本樹 →
還原到工作區**。它讓使用者能從原始碼、`//@` 行內註解和標題的變化，練習理解類似
Git commit 與從舊提交分支的概念。

## 不做什麼

* 不做提交訊息。版本號與時間已足以辨識這個教學範圍內的提交；使用者明確不需要它。
* 不儲存 diff patch；每版存完整快照。幾十 KB 的教案以完整快照換取可靠還原，比自己
  套 patch 更簡單也更不容易壞。
* 不做命名分支、合併、多人衝突解決或版本刪除。從舊版本還原後的下一次提交會自動
  形成一條分支；但每個版本只有一個父版本，沒有兩個父版本的 merge commit。
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

開啟**別人的**教案時保留既有的簡單 fork 行為：使用者按儲存後，伺服器直接在自己
名下建立一篇副本與自己的 v1，即使尚未改過內容。這不是原教案的提交，故不顯示原作者
diff 或歷史，也不適用「沒有變更可提交」的阻擋；成功後編輯器切換到新副本，後續儲存
才走一般的差異預覽與版本樹流程。

### 版本紀錄與還原

編輯器旁有「版本紀錄」按鈕，只在載入既有、且屬於目前使用者的教案時顯示。打開後：

* 以 VS Code Source Control Graph 風格的節點與連線呈現版本樹；目前公開內容的版本
  標示為 `HEAD`，其他沒有子節點的版本仍是可回復的分支端點。
* 選取 `vN` 時，顯示它相對**父版本**的標題與逐行差異；`v1` 標記為初始版本。
* 「還原此版本」只將該快照填回編輯器工作區，並關閉歷史視窗；它不會直接寫入伺服器。
  使用者仍需走一次儲存、差異預覽和確認提交，還原結果會成為新的版本，原有歷史不變。

例如已有 `v1 → v2 → v3 → v4 → v5` 時，還原 v3、修改並提交會得到 `v6`，其父節點
是 v3；v4→v5 不會被覆寫。此時 `HEAD` 移到 v6，公開教案顯示 v6，v5 仍在另一個
分支端點。這是分支，不是合併；v6 的 diff 是 v3→v6，不會拿 v5 比較。

## 資料與 API

新增 migration 建立歷史快照表：

```sql
CREATE TABLE IF NOT EXISTS lesson_versions (
    id                INTEGER PRIMARY KEY,
    lesson_id         INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    version           INTEGER NOT NULL,
    parent_version_id INTEGER REFERENCES lesson_versions(id),
    title             TEXT NOT NULL,
    bundle_json       TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (lesson_id, version)
);

CREATE INDEX IF NOT EXISTS lesson_versions_lesson_idx
    ON lesson_versions (lesson_id, version DESC);

CREATE TABLE IF NOT EXISTS lesson_current_versions (
    lesson_id  INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    version_id INTEGER NOT NULL REFERENCES lesson_versions(id) ON DELETE CASCADE
);
```

`lesson_versions` 不複製 `user_id`：擁有權已由 `lessons.user_id` 作為唯一真相，避免兩份
資料日後不一致。`parent_version_id` 由資料層驗證必須屬於同一篇教案；SQL 單靠外鍵無法
表達這個跨欄位關係。`lesson_current_versions` 是「目前公開內容／HEAD 是哪一版」的
一列指標；用新表而不改 `lessons`，是因為本專案 migration 必須可重跑，而 SQLite 的
`ALTER TABLE ADD COLUMN` 不是冪等操作。外鍵 CASCADE 讓刪除教案時快照與指標一併刪除。

migration 會先替所有既有教案建立 v1（內容取現有 title/bundle，時間取既有更新時間），
再插入對應的 `lesson_current_versions` 指標。新安裝則直接從新表開始，不需要特例。

歷史快照也納入既有帳號儲存配額；一次提交若會超過配額，整筆 transaction 拒絕，
目前教案與版本紀錄都不變。這保留「每次成功提交都有版本」的承諾，同時避免無上限
歷史佔滿資料庫。

`db.create_lesson()` 會在同一個 transaction 建立 `lessons`、v1 與目前版本指標；
`db.update_lesson_owned_by()` 接受提交的 parent version，在同一個 transaction 插入版本號
最大值加一的快照、更新 `lessons` 目前內容與 `lesson_current_versions`。正常儲存使用目前版本
當父節點；從歷史還原後儲存則使用所選舊版當父節點，因此自然形成分支。非擁有者 PUT 的
既有 fork 行為沿用 `create_lesson()`，所以副本從自己的 v1 開始，不會攜帶原作者歷史。

既有 `GET /api/lessons/<id>` 回應加入目前版本號；既有 PUT body 可選擇加入
`parent_version`。新前端每次既有教案提交都帶它：正常時是目前版本，從舊版還原後是所選
版本。伺服器驗證它存在且屬於同一篇教案；舊前端省略欄位時，伺服器預設使用目前版本，
維持相容且只會延續現有主線。

非擁有者 PUT 沿用目前的 fork 路徑，不接受原教案的 `parent_version`，也不需有內容
差異；它以送來的 title/bundle 建立新 lesson 與新擁有者的 v1。新 lesson 不保存原教案
id、版本節點或歷史快照，因此原作者歷史仍只能被原作者讀取。

新增三條只讀端點，均使用既有登入驗證；GET 不需要 CSRF：

| 端點 | 回應 | 權限 |
|---|---|---|
| `GET /api/lessons/<id>/versions` | 版本號、時間、父版本、目前版本 | 僅擁有者 |
| `GET /api/lessons/<id>/versions/<version>` | 該版 `title` 與 `bundle` | 僅擁有者 |
| `GET /api/lessons/<id>/versions/<version>/diff` | 該版與父版本的兩份快照 | 僅擁有者 |

不存在的教案、版本，或非擁有者，一律回 404。這和現有的敏感教案操作一致，不洩漏
目標是否存在。後端只回快照資料；逐行演算法和視覺呈現交給既有 Monaco 前端，避免
另造一套 diff 格式。

## 前端邊界

`SourceCode.tsx` 已是教案載入、bundle 組裝與儲存的唯一入口，因此它負責保留「最新
提交快照」並開啟兩個小型 React modal：

| 元件 | 職責 |
|---|---|
| `LessonCommitDialog` | 標題 old/new、Monaco diff editor、取消／確認提交 |
| `LessonHistoryDialog` | 讀取版本樹、選版的父子差異、還原到工作區 |
| `lessonVersion.ts` | 純函式：判斷 bundle/title 是否變更、整理單親版本樹與 Monaco 資料 |

差異 editor 使用既有 Monaco 依賴的原生 `DiffEditor`；不新增 diff 函式庫，也不手寫
LCS 演算法。版本圖以小型 SVG/CSS 繪製：版本由新到舊排列，純函式根據 `parent_version_id`
分配樹枝欄位並畫出連線；因為沒有 merge、每個節點只有一個父節點，不需要通用 DAG
layout 函式庫。`SourceCode.tsx` 只協調 API、工作區與 dialog，資料比較及版圖資料留在
純函式中，讓前端測試不需要掛載 Monaco。

最新版快照取自載入教案時的 GET 回應，並保存其版本 id 作為預設提交父節點；第一次
成功建立或更新後，直接用已提交的 title/bundle 與新版本 id 更新前端基準。歷史選版的
還原呼叫既有 `applyProjectBundle()`，並把該版本設為下一次提交的父節點，因此 source
code、行內註解、程式輸入和斷點都一起回到該版。

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 自己的工作區與最新提交完全相同 | 不送出；說明沒有變更可提交 |
| 別人的教案尚未修改就按儲存 | 建立自己名下副本與 v1，不讀取或複製原作者歷史 |
| 取消預覽 | 不寫資料、不改目前基準 |
| 版本列表／快照讀取失敗 | 顯示錯誤，工作區不變 |
| 確認提交失敗 | 工作區與預覽維持，使用者可修正或重試 |
| 非擁有者請求歷史 | 404；不顯示版本紀錄按鈕 |
| 還原舊版 | 只改工作區並選它為下次提交父節點；確認後建立分支版本 |

## 測試

### Python

* 建立教案會同時有唯一的 v1；正常更新會保留 v1 並建立以目前版本為父的 v2。
* 還原 v3、修改、提交會建立 v6 並記錄 v3 為父節點；既有 v4→v5 與快照不變，
  目前版本指標改指向 v6。
* 同一個 title/bundle 的更新不會由前端送出；若 API 仍收到它，也不新增空版本。
* 版本快照保存 title、`source_code`、`//@` 註解、program input 與 breakpoints。
* 刪除教案會 CASCADE 刪除其版本。
* 快照計入帳號配額；配額不足時目前教案與歷史都不變。
* 非擁有者列出或讀取版本得到 404；對他人教案即使內容相同的 PUT fork 也產生自己的
  獨立 v1，並且不複製原作者版本。
* API 回傳每個版本的 parent 與目前版本資訊，讀取不存在版本得到 404。

### Jest

* `lessonVersion.ts` 對相同／不同 title、原始碼、行內註解判斷正確。
* 還原快照會產生可交給 `applyProjectBundle()` 的原 bundle，不遺失欄位。

### E2E

* 修改標題、程式碼和 `//@` 註解後，按儲存會先見到 diff；取消後伺服器內容未變。
* 確認提交後，版本清單有 v2，且 v2 diff 顯示三種變更。
* 選 v1 還原只變工作區；確認下一次提交後出現以 v1 為父的分支版本，原來的 v2
  仍可讀取，版本圖正確標示新的 `HEAD`。
* 非作者開啟同一公開教案時看不到原作者版本紀錄；不改內容按儲存後切換到自己的 v1，
  之後才可看到自己的版本樹。

## 實作順序

1. migration、DB 快照讀寫與 API，先用 Python 測試鎖定交易與權限。
2. 純前端 snapshot 比較 helper 與 Jest。
3. 提交預覽 dialog，接入既有儲存流程。
4. 版本樹 dialog、工作區還原與從舊版分支。
5. E2E 涵蓋提交、取消、歷史和權限。
