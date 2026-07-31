-- Anonymous live classroom quiz sessions and immutable question snapshots.
-- Every statement is idempotent because db.migrate() may replay a partially applied file.

CREATE TABLE IF NOT EXISTS live_quiz_sessions (
    id                 INTEGER PRIMARY KEY,
    lesson_id          INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    lesson_version_id  INTEGER REFERENCES lesson_versions(id) ON DELETE SET NULL,
    owner_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    join_nonce         TEXT NOT NULL UNIQUE,
    state              TEXT NOT NULL CHECK (state IN ('lobby', 'ended')),
    created_at         TEXT NOT NULL,
    ended_at           TEXT
);

CREATE TABLE IF NOT EXISTS live_quiz_questions (
    id                  INTEGER PRIMARY KEY,
    session_id          INTEGER NOT NULL REFERENCES live_quiz_sessions(id) ON DELETE CASCADE,
    question_key        TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    options_json        TEXT NOT NULL,
    correct_option_id   TEXT NOT NULL,
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
    option_counts_json  TEXT NOT NULL,
    UNIQUE (session_id, question_key),
    UNIQUE (session_id, position)
);

CREATE TABLE IF NOT EXISTS live_quiz_participants (
    id              INTEGER PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES live_quiz_sessions(id) ON DELETE CASCADE,
    nickname        TEXT NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    UNIQUE (session_id, credential_hash)
);

CREATE TABLE IF NOT EXISTS live_quiz_responses (
    participant_id     INTEGER NOT NULL REFERENCES live_quiz_participants(id) ON DELETE CASCADE,
    question_id        INTEGER NOT NULL REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL,
    is_correct         INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
    answered_at        TEXT NOT NULL,
    PRIMARY KEY (participant_id, question_id)
);

CREATE INDEX IF NOT EXISTS live_quiz_session_owner_idx
    ON live_quiz_sessions (owner_user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS live_quiz_question_session_idx
    ON live_quiz_questions (session_id, position);
CREATE INDEX IF NOT EXISTS live_quiz_participant_session_idx
    ON live_quiz_participants (session_id);
