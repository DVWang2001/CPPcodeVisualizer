-- 題目長出 kind 維度：單選題（choice）與填表題（table）並存於同一份題目清單。
--
-- 為什麼是重建而不是 ALTER：0005 把單選題專屬欄位全部寫成 NOT NULL，而填表題沒有
-- 選項。SQLite 無法直接放寬 NOT NULL，只能建新表→複製→改名。
--
-- 若腳本已完成、只差 schema_version 落盤，db.migrate() 會由兩張表的新欄位判定並
-- 直接補版本號；SQLite 靜態 SQL 無法同時 SELECT「可能存在、也可能不存在」的欄位。
-- 腳本內的 IF NOT EXISTS / WHERE NOT EXISTS 則處理建表與複製途中可安全重試的步驟。
--
-- 為什麼開頭要關 foreign_keys：db.connect() 每條連線都開著 PRAGMA foreign_keys=ON
-- （見 db.py），而 live_quiz_responses 有 FK 指向 live_quiz_questions(id)。FK 開著時
-- DROP TABLE live_quiz_questions 會被擋下，或是連帶把既有的作答資料級聯刪掉。
-- PRAGMA foreign_keys 在交易內是 no-op，但 executescript() 執行前會隱式 COMMIT，
-- 所以先關 FK、再以明確交易包住整段重建：即使中斷在 DROP→ALTER 之間也會整段
-- rollback。COMMIT 後才把 FK 開回去，不把連線層級副作用外洩。
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS live_quiz_questions_v2 (
    id                  INTEGER PRIMARY KEY,
    session_id          INTEGER NOT NULL REFERENCES live_quiz_sessions(id) ON DELETE CASCADE,
    question_key        TEXT NOT NULL,
    -- DEFAULT 'choice'：live_quiz.py 建題目的既有程式碼還不會寫 kind（那是
    -- 之後任務的事），沒有預設值的話現有的單選題建立流程會立刻被 NOT NULL 擋下。
    kind                TEXT NOT NULL DEFAULT 'choice' CHECK (kind IN ('choice', 'table')),
    prompt              TEXT NOT NULL,
    explanation         TEXT NOT NULL,
    source_file         TEXT NOT NULL,
    trigger_line        INTEGER NOT NULL CHECK (trigger_line > 0),
    trigger_anchor_json TEXT NOT NULL,
    position            INTEGER NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('ready', 'open', 'closed')),
    opened_at           TEXT,
    closed_at           TEXT,
    answer_count        INTEGER NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
    correct_count       INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),

    -- kind='choice' 專屬
    options_json        TEXT,
    correct_option_id   TEXT,
    option_counts_json  TEXT,

    -- kind='table' 專屬。correct_table_json 與 cell_stats_json 在 trigger 時才寫入，
    -- 所以這裡不能要求 NOT NULL——題目在 ready 狀態下還沒有正解。
    table_spec_json     TEXT,
    correct_table_json  TEXT,
    cell_stats_json     TEXT,

    UNIQUE (session_id, question_key),
    UNIQUE (session_id, position),
    CHECK (
        CASE kind
            WHEN 'choice' THEN options_json IS NOT NULL
                           AND correct_option_id IS NOT NULL
                           AND option_counts_json IS NOT NULL
            WHEN 'table'  THEN table_spec_json IS NOT NULL
        END
    )
);

INSERT INTO live_quiz_questions_v2 (
    id, session_id, question_key, kind, prompt, explanation, source_file,
    trigger_line, trigger_anchor_json, position, state, opened_at, closed_at,
    answer_count, correct_count, options_json, correct_option_id, option_counts_json
)
SELECT
    id, session_id, question_key, 'choice', prompt, explanation, source_file,
    trigger_line, trigger_anchor_json, position, state, opened_at, closed_at,
    answer_count, correct_count, options_json, correct_option_id, option_counts_json
FROM live_quiz_questions
WHERE NOT EXISTS (SELECT 1 FROM live_quiz_questions_v2 WHERE live_quiz_questions_v2.id = live_quiz_questions.id);

DROP TABLE IF EXISTS live_quiz_questions;
ALTER TABLE live_quiz_questions_v2 RENAME TO live_quiz_questions;

CREATE TABLE IF NOT EXISTS live_quiz_responses_v2 (
    participant_id     INTEGER NOT NULL REFERENCES live_quiz_participants(id) ON DELETE CASCADE,
    question_id        INTEGER NOT NULL REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
    answered_at        TEXT NOT NULL,

    selected_option_id TEXT,
    is_correct         INTEGER CHECK (is_correct IN (0, 1)),

    answer_json        TEXT,
    correct_cells      INTEGER CHECK (correct_cells >= 0),
    total_cells        INTEGER CHECK (total_cells >= 0),

    PRIMARY KEY (participant_id, question_id)
);

INSERT INTO live_quiz_responses_v2 (
    participant_id, question_id, answered_at, selected_option_id, is_correct
)
SELECT participant_id, question_id, answered_at, selected_option_id, is_correct
FROM live_quiz_responses
WHERE NOT EXISTS (
    SELECT 1 FROM live_quiz_responses_v2 v
    WHERE v.participant_id = live_quiz_responses.participant_id
      AND v.question_id = live_quiz_responses.question_id
);

DROP TABLE IF EXISTS live_quiz_responses;
ALTER TABLE live_quiz_responses_v2 RENAME TO live_quiz_responses;

CREATE INDEX IF NOT EXISTS live_quiz_question_session_idx
    ON live_quiz_questions (session_id, position);

COMMIT;
PRAGMA foreign_keys=ON;
