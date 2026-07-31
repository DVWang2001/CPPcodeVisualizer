-- 不可變的教案版本與目前版本指標。
--
-- ★ Migration 必須寫成冪等的 ★（理由見 0001 與 db.migrate() 的說明）

CREATE TABLE IF NOT EXISTS lesson_versions (
    id INTEGER PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    parent_version_id INTEGER REFERENCES lesson_versions(id),
    title TEXT NOT NULL,
    bundle_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (lesson_id, version)
);

CREATE INDEX IF NOT EXISTS idx_lesson_versions_lesson_version
    ON lesson_versions (lesson_id, version);

CREATE TABLE IF NOT EXISTS lesson_current_versions (
    lesson_id INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    version_id INTEGER NOT NULL REFERENCES lesson_versions(id) ON DELETE CASCADE
);

-- 舊 lessons 是目前內容的 materialized state；第一次升級時把它們各自變成 v1。
INSERT OR IGNORE INTO lesson_versions (lesson_id, version, parent_version_id, title, bundle_json)
SELECT id, 1, NULL, title, bundle_json FROM lessons;

INSERT OR IGNORE INTO lesson_current_versions (lesson_id, version_id)
SELECT l.id, v.id
FROM lessons l
JOIN lesson_versions v ON v.lesson_id = l.id AND v.version = 1;
