-- 第一個垂直切片：使用者 + 教案。
--
-- ★ Migration 必須寫成冪等的 ★
-- sqlite3 的 executescript() 執行前會隱式 COMMIT，沒辦法把整個腳本包進一個
-- 交易。db.migrate() 因此只在腳本整個跑完之後才寫 schema_version；跑到一半
-- 失敗就靠冪等性在下次啟動重跑。詳見 db.migrate() 的說明。

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    -- 登入帳號，同時是個人檔案網址 /u/<username>。
    -- 大小寫在應用層一律轉小寫後才進來，所以 UNIQUE 就等於「不會有兩個看起來
    -- 一樣的帳號」。
    username      TEXT NOT NULL UNIQUE,
    -- werkzeug.security.generate_password_hash（預設 scrypt）的輸出，含 salt。
    -- 這一欄絕不進入任何模板或 API 回應。
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    -- .gdbgui.json bundle 原文。
    bundle_json TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 個人檔案頁的唯一查詢型態：WHERE user_id = ?
CREATE INDEX IF NOT EXISTS lessons_user_id_idx ON lessons (user_id);
