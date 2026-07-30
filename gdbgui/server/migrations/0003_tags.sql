-- 教案標籤。詞彙是全站共用的：同一個標籤在不同教案之間是 tags 裡的同一列，
-- 這正是「全域標籤」的意思，也是計數與列出標籤的前提。存 TEXT 欄位搜尋得到，
-- 但那兩件做不到。
--
-- ★ Migration 必須寫成冪等的 ★（理由見 0001 與 db.migrate() 的說明）

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    -- 正規化後的形式（NFKC → 去控制字元 → 收斂空白 → casefold）。
    -- UNIQUE 是「BST 與 bst 是同一個標籤」的實際保證。
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_tags (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id),
    -- 這個 PK 同時是「同一篇不會重複掛同一個標籤」的保證，以及
    -- 「這篇有哪些標籤」的索引，所以不需要第二個索引。
    PRIMARY KEY (lesson_id, tag_id)
);

-- 反向：「有這個標籤的教案有哪些」——標籤篩選的查詢型態。
CREATE INDEX IF NOT EXISTS lesson_tags_tag_idx ON lesson_tags (tag_id);
