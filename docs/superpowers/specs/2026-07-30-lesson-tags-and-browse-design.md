# 教案標籤與主頁瀏覽

2026-07-30

## 要解決什麼

教案庫目前是一條依 `updated_at` 排序的清單，只能翻頁。教案累積到幾十篇之後，
「找到我要的那一篇」就沒有辦法了——沒有搜尋，也沒有任何分類。

同時，主頁 `/` 是除錯器。一個以「看別人的教案」為主要用途的站，把最常被打開
的網址留給編輯器，等於要求每個人都先知道 `/lessons` 存在。

這個設計做兩件事：**給教案加上全站共用的標籤**，以及**把主頁換成可搜尋的教案
清單**，除錯器搬到 `/edit`。

## 不做什麼

* 不做標籤的重新命名、合併、刪除介面。標籤是使用者自己打的字串，錯了就改那篇
  教案的標籤。沒有管理者身分，所以也沒有「整理別人的標籤」這件事。
* 不做 FTS5 全文檢索。使用者量級 200、教案量級幾千，`LIKE` 掃描是毫秒級；
  FTS5 要多一張虛擬表與三個同步觸發器，現在加是白付維護成本。
* 不做標籤的自動建議／自動完成。先讓人打得出來，再看要不要幫他打。
* 不碰教案本身的 bundle 格式。標籤是教案的中繼資料，不進 `bundle_json`——
  否則搜尋就得解析每一篇的 JSON。

## 路由

| 網址 | 現在 | 之後 |
|---|---|---|
| `/` | 除錯器 | 教案瀏覽＋搜尋 |
| `/?q=…&tag=…` | — | 同上，帶篩選條件 |
| `/edit` | — | 除錯器（空白起手）|
| `/edit?lesson=42` | — | 除錯器載入第 42 篇 |
| `/?lesson=42` | 除錯器載入 | 302 → `/edit?lesson=42` |
| `/lessons` | 教案庫 | 302 → `/` |
| `/u/<username>` | 個人檔案 | 不變，加標籤編輯 |
| `POST /api/lessons/<id>/tags` | — | 設定某篇教案的標籤 |

兩條 302 是為了保住現有書籤，也保住 `/?lesson=` 那條剛修好的載入路徑——它的
行為完全不變，只是換了網址。轉址保留 query string 裡的其他參數。

**登入門檻不變。** 全站的 `require_login` 是掛在 `before_request` 上的，所以
`/` 換成瀏覽頁之後，未登入者看到的仍然是登入頁而不是教案清單。這一點值得寫
出來，因為「首頁變成公開的作品集」是一個很自然的誤解，而目前的決定是
**全部公開給登入者**，不是公開給所有人。`/edit` 同樣要 `@authenticate`。

瀏覽頁沿用 `/lessons` 現有的伺服器端渲染（Jinja + `_auth_base.html` 的設計
語言），**不寫成 React**。它只是一個清單加一個搜尋框；為了它把整個前端 bundle
拉進最常被打開的那一頁，只會讓它變慢。

## 資料

```sql
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    -- 正規化後的形式（見下）。UNIQUE 保證「同一個標籤在全站是同一列」，
    -- 這正是「全域標籤」的意思。
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_tags (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (lesson_id, tag_id)
);

-- 「有這個標籤的教案有哪些」——標籤篩選的查詢型態。
CREATE INDEX IF NOT EXISTS lesson_tags_tag_idx ON lesson_tags (tag_id);
```

`PRIMARY KEY (lesson_id, tag_id)` 同時是「同一篇不會重複掛同一個標籤」的保證，
以及「這篇有哪些標籤」的索引，所以不需要第二個索引。

`ON DELETE CASCADE` 會真的生效：`db.connect()` 每條連線都設 `PRAGMA
foreign_keys=ON`。

**為什麼是關聯表而不是 `lessons` 上的一個 TEXT 欄位**：要的是全域標籤——同一個
標籤在不同教案之間必須是同一個東西，才能列出全站標籤、算使用次數、日後改名。
TEXT 欄位搜尋得到，但這三件都做不到。

孤兒標籤（沒有任何教案在用）留著不刪。刪它要在每次解除關聯時多一次查詢，換來
的是一列幾十個位元組；而且使用者常常是先拿掉再加回來。

### 正規化

一個標籤字串進資料庫之前：

1. Unicode NFKC 正規化
2. 去頭尾空白，連續空白收成一個半形空格
3. `casefold()`

所以 `BST`、`bst`、`Bst`、`  BST  ` 是同一個標籤。存進 `tags.name` 的是正規化
後的形式，顯示的也是它——不另外存「顯示用原文」，否則「誰的大小寫算數」會變成
一個沒有好答案的問題（先貼的人？最後貼的人？）。

### 限制（輸入驗證，不簡化）

| 項目 | 上限 | 理由 |
|---|---|---|
| 每篇教案的標籤數 | 8 | 超過就不是分類是筆記 |
| 單一標籤長度 | 1–24 字元（正規化後）| 標籤是標籤，不是句子 |
| 允許字元 | 排除 Unicode 控制字元 | 其餘全開，中文必須可用 |
| 搜尋字串 `q` 長度 | 100 字元 | |
| 一次篩選的標籤數 | 8 | 見下 |

`tag` 是可重複的 query 參數，不設上限就是「一個網址就能點的 DoS」——跟先前
`?page=99999999` 那個是同一類問題。超過 8 個直接截斷，不報錯。

## 搜尋

一個文字框（`q`）加上可複選的標籤（`tag`，可重複）。**全部都是 AND**：
每多一個條件就是再縮小一次。標籤之間也是 AND。

```sql
SELECT l.id, l.title, l.updated_at, l.user_id, u.username, u.display_name
  FROM lessons l
  JOIN users u ON u.id = l.user_id
 WHERE ( :q = ''
         OR l.title         LIKE :pat ESCAPE '\'
         OR u.display_name  LIKE :pat ESCAPE '\'
         OR u.username      LIKE :pat ESCAPE '\'
         OR EXISTS (SELECT 1 FROM lesson_tags lt JOIN tags t ON t.id = lt.tag_id
                     WHERE lt.lesson_id = l.id AND t.name LIKE :pat ESCAPE '\') )
   -- 只有選了標籤才加這一段
   AND l.id IN ( SELECT lt.lesson_id
                   FROM lesson_tags lt JOIN tags t ON t.id = lt.tag_id
                  WHERE t.name IN (:tag1, :tag2, …)
                  GROUP BY lt.lesson_id
                 HAVING COUNT(DISTINCT t.id) = :ntags )
 ORDER BY l.updated_at DESC, l.id DESC
 LIMIT :per_page OFFSET :offset
```

`HAVING COUNT(DISTINCT t.id) = :ntags` 就是「這些標籤全都有」。

用 `EXISTS` 而不是 `LEFT JOIN tags` + `DISTINCT`：後者會讓一篇教案有幾個標籤
就產生幾列，再靠 `DISTINCT` 收掉。那跟 `ORDER BY` + `LIMIT/OFFSET` 分頁一起
用很脆，而 `EXISTS` 從一開始就不產生重複列。

`q` 裡的 `%`、`_`、`\` 一律跳脫（`ESCAPE '\'`），否則使用者打一個 `%` 就是
無條件全表掃描。

排序不變：`updated_at DESC, id DESC`。第二個鍵是必要的，理由見
`0002_lessons_recent_index.sql`——`updated_at` 只到秒，不是全序的話分頁會漏。

現有的 `lessons_recent_idx` 涵蓋沒有篩選時的排序。有篩選時走
`lesson_tags_tag_idx` 再排序，量級之下可接受。

### 標籤列

標籤列**只列出目前結果集裡真的存在的標籤**，計數是結果集內的計數：

```sql
SELECT t.name, COUNT(*) AS n
  FROM lesson_tags lt JOIN tags t ON t.id = lt.tag_id
 WHERE lt.lesson_id IN ( <上面那個 WHERE，不含 LIMIT/OFFSET> )
 GROUP BY t.id
 ORDER BY n DESC, t.name ASC
 LIMIT 12
```

這樣點不出空清單——會讓結果變空的標籤根本不會出現在列上。已選的標籤一律顯示
（帶 ✕ 可移除），即使它已經不在前 12 名。

超過 12 個時列尾放「全部 N 個 →」，展開成完整清單（同一頁，`?alltags=1`）。
刻意不叫 `tags=all`——跟篩選用的 `tag` 只差一個字母，兩個意思完全不同的參數
長得像是日後改壞它的最好方法。

計數跨頁一致：它算的是整個結果集，不是當前這一頁。

## 標籤怎麼編輯

在**個人檔案頁** `/u/<username>`，每篇教案一個逗號分隔的小表單，看自己的頁面
時才出現。

不放在除錯器的儲存流程裡：那裡目前是 `window.prompt`，塞不下第二個欄位——要放
就得先把它改寫成真的 modal，那是另一件事。而且分類的自然場所是清單頁，人會想
一次整理好幾篇，不是每次存檔時想一篇。

`POST /api/lessons/<id>/tags`，body `{"tags": "BST, STL, 二分搜尋"}`，
回應是正規化後的標籤陣列。整批取代，不是增量——送什麼就是什麼。

### 權限

**只有教案的作者能改它的標籤。** 標籤名是全站共用的，任何人都能打出一個新的，
但一篇教案掛什麼標籤只有它的作者說了算。

伺服器端以 `session` 裡的 `user_id` 判斷，跟現有的 `update_lesson_owned_by` /
`delete_lesson_owned_by` 同一個模式：非作者回 **404**，不是 403——403 等於確認
「這篇存在但不是你的」。

**不沿用 PUT `/api/lessons/<id>` 的 fork 行為。** 那條在教案不屬於你時會另存
一份副本，因為改內容是創作。改標籤不是——「幫別人的教案分類」與「複製一份他的
教案」是兩件不同的事，靜默 fork 會讓使用者以為自己整理了教案庫，其實只是替
自己複製了一堆。

CSRF：走現有的全域 `before_request`，前端 `fetch` 要帶 `x-csrftoken`。

配額：標籤不計入 `MAX_BUNDLE_BYTES` / `MAX_USER_BYTES`。那些配額防的是
bundle 撐爆磁碟；標籤有自己的上限（每篇 8 個 × 24 字元），本身就有界。

## 模組邊界

| 檔案 | 職責 |
|---|---|
| `gdbgui/server/migrations/0003_tags.sql` | 上面兩張表與索引 |
| `gdbgui/server/tags.py`（新） | 正規化、驗證、`set_lesson_tags`、`tags_for_lessons` |
| `gdbgui/server/db.py` | 加 `search_lessons()` 與 `tag_counts()`；既有函式不動 |
| `gdbgui/server/http_routes.py` | `/` 改成瀏覽頁、新增 `/edit`、兩條轉址、標籤 API |
| `gdbgui/templates/browse.html`（新） | 瀏覽頁，繼承 `_auth_base.html` |
| `gdbgui/templates/profile.html` | 加標籤顯示與編輯表單 |

正規化與驗證單獨放 `tags.py`，因為它是純函式、規則會被三個地方用到（API、
模板顯示、搜尋比對），而且是最需要被測試的部分。

`db.py` 已經很長，但搜尋查詢跟現有的 `recent_lessons` / `lesson_count` 是同一
類東西，拆出去反而讓「教案怎麼查」散在兩個檔案。

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 標籤太多 / 太長 / 全空白 | 400，訊息說明哪一條規則 |
| 改別人的教案標籤 | 404 |
| 教案不存在 | 404 |
| `q` 超過 100 字元 | 截斷，照常搜尋（不報錯）|
| `tag` 超過 8 個 | 截斷 |
| `tag` 是不存在的標籤名 | 結果為空，不是錯誤 |
| `page` 超出範圍 | 夾到 `[1, last_page]`，同現行做法 |

搜尋參數一律「修正後照常做」，不對使用者報錯——網址是可以被亂改的，把它當成
輸入而不是契約。標籤寫入則相反：那是明確的使用者動作，錯了要說清楚。

## 測試

**Python（`tests/test_tags.py`）**

* 正規化：大小寫、前後空白、連續空白、NFKC；`BST` 與 `bst` 進同一列
* 每篇 8 個上限、單標籤 24 字元上限、空標籤被丟掉、控制字元被拒
* 中文標籤可用
* 整批取代語意：送兩個標籤蓋掉原本三個
* 非作者改標籤得到 404，且標籤沒有被改動
* 刪教案時 `lesson_tags` 跟著消失（CASCADE 真的生效）
* 標籤不影響配額

**Python（`tests/test_lesson_search.py`）**

* 搜尋比對標題、作者顯示名、帳號、標籤四者
* `%` 與 `_` 被當成字面字元，不是萬用字元 ← 這條最重要
* 多標籤是 AND 不是 OR
* `q` 與 `tag` 同時給時也是 AND
* 標籤計數只算結果集內
* 空 `q` 且無 `tag` 時，結果與現行 `recent_lessons` 一致
* 分頁不重複、不遺漏

**e2e（`e2e/tests/zz_lesson_tags.spec.ts`）**

* 貼標籤 → 在 `/` 搜尋得到那篇
* 點標籤 → 網址出現 `?tag=`，清單縮小
* 兩條轉址真的成立（`/lessons` → `/`、`/?lesson=N` → `/edit?lesson=N`）

**要改的現有測試**：`zz_lesson_sharing` 裡所有 `page.goto('/')` 改成 `/edit`，
`/?lesson=N` 改成 `/edit?lesson=N`；但**保留一條**驗舊網址仍會轉址。

## 實作順序

1. migration + `tags.py` + 它的測試（沒有 UI，純資料層）
2. `search_lessons()` / `tag_counts()` + 測試
3. 標籤 API + 個人檔案頁的編輯表單
4. `browse.html` 與 `/` 的換位、`/edit`、兩條轉址
5. 改現有 e2e，加新的 e2e

前兩步做完就能用 pytest 驗證整個資料層，UI 出錯時可以立刻分清楚是哪一層。
第 4 步是唯一會弄壞現有東西的一步，所以放在資料層確定沒問題之後。
