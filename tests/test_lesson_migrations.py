"""教案版本 migration：舊教案在升級後有一個可安全重跑的 v1 快照。"""

from contextlib import closing

from gdbgui.server import db


def test_v3_lesson_is_backfilled_to_one_version_without_duplication(tmp_path, monkeypatch):
    """少了 v1 或重跑又插一份，都會讓既有教案的歷史不可信。"""
    monkeypatch.setattr(db, "DATA_DIR", tmp_path / "legacy-data")
    with closing(db.connect()) as conn:
        conn.execute(db._SCHEMA_VERSION_DDL)
        for path in db.migration_files():
            if int(path.name[:4]) > 3:
                continue
            conn.executescript(path.read_text(encoding="utf-8"))
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (int(path.name[:4]), "2026-08-01T00:00:00+00:00"),
            )
        conn.execute(
            "INSERT INTO users (id, username, password_hash, display_name, created_at) "
            "VALUES (1, 'legacy', 'hash', 'Legacy', '2026-07-01T00:00:00+00:00')"
        )
        conn.execute(
            "INSERT INTO lessons (id, user_id, title, bundle_json, created_at, updated_at) "
            "VALUES (7, 1, '舊教案', '{\"source_code\":\"old\"}', "
            "'2026-07-01T00:00:00+00:00', '2026-07-01T00:00:00+00:00')"
        )
        # Simulate a crash after 0004's DDL/backfill committed but before its
        # schema_version record was written. Re-running migrate must not add a
        # second v1 or pointer.
        migration = next(path for path in db.migration_files() if path.name.startswith("0004_"))
        conn.executescript(migration.read_text(encoding="utf-8"))
        conn.commit()

    assert db.schema_version() == 3
    assert db.migrate() == 1

    with closing(db.connect()) as conn:
        versions = list(
            conn.execute(
                "SELECT version, parent_version_id, title, bundle_json "
                "FROM lesson_versions WHERE lesson_id = 7"
            )
        )
        pointer = conn.execute(
            "SELECT cv.version_id, v.version "
            "FROM lesson_current_versions cv JOIN lesson_versions v ON v.id = cv.version_id "
            "WHERE cv.lesson_id = 7"
        ).fetchone()
    assert [tuple(row) for row in versions] == [(1, None, "舊教案", '{"source_code":"old"}')]
    assert pointer is not None
    assert pointer["version"] == 1

    assert db.migrate() == 0
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM lesson_versions WHERE lesson_id = 7").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM lesson_current_versions WHERE lesson_id = 7").fetchone()[0] == 1
