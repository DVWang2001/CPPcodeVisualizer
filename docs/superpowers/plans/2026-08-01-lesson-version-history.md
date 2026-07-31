# Lesson Version History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, Git-like lesson version history: preview a complete lesson diff before an owner commits, retain every committed snapshot, restore an older snapshot to create a branch on the next commit, and let a non-owner save a public lesson as an independent v1 fork.

**Architecture:** Keep `lessons` as the materialized current lesson for existing browse/share paths. Add immutable `lesson_versions` snapshots and a separate `lesson_current_versions` HEAD pointer table. The database/API enforce ownership, version numbering, parent links, quota accounting, and fork isolation; React renders the diff and a small SVG version tree with the already-installed Monaco `DiffEditor`.

**Tech Stack:** SQLite migrations, Flask routes, Python pytest, React/TypeScript, `@monaco-editor/react` `DiffEditor`, Jest, Playwright. No new package or graph library.

## Global Constraints

- Preserve the existing title, bundle validation, CSRF protection, public lesson browsing, and `PUT /api/lessons/<id>` fork behavior.
- A version stores complete `title` and `bundle_json`; the bundle includes source code, inline `//@` annotations, breakpoints, program input, and future bundle fields.
- Every ordinary owner submission with changed content creates one immutable child of the selected/current parent. Version numbers are monotonically increasing per lesson, while the parent is any owned version of that same lesson.
- Restoring is local editor state only. Saving that restored state creates a new child rather than rewriting history. There are no merge commits and each version has zero or one parent.
- History routes reveal nothing for a nonexistent lesson or a lesson owned by another user: return the existing 404 lesson-not-found response in both cases.
- Opening another user's lesson and pressing Save creates a new lesson owned by the viewer at v1 even if unchanged. It copies only the current title/bundle, never version rows or parent links.
- Account/global storage counts each stored `lesson_versions.bundle_json` once. The duplicate materialized `lessons.bundle_json` is not counted; deleting a lesson cascades to all of its versions and frees that storage.
- Keep implementation minimal: reuse existing project-bundle machinery and the installed Monaco diff editor; implement the tree layout as a small pure helper and render it with SVG.

---

## File Map

| File | Responsibility |
| --- | --- |
| `gdbgui/server/migrations/0004_lesson_versions.sql` | Idempotently create snapshot/HEAD tables and backfill v1 for legacy lessons. |
| `gdbgui/server/db.py` | Atomic snapshot writes, current-HEAD lookup, owner-only history reads, and snapshot quota accounting. |
| `gdbgui/server/http_routes.py` | Version metadata in lesson responses and owner-only history/diff endpoints. |
| `tests/test_lesson_sharing.py` | API coverage for version writes, fork isolation, history privacy, restore branching. |
| `tests/test_lesson_quotas.py` | Quota behavior when immutable snapshots are retained. |
| `tests/test_lesson_migrations.py` | Legacy-data migration/backfill coverage. |
| `gdbgui/src/js/lessonVersion.ts` | Snapshot types, stable content comparison, and pure tree layout. |
| `gdbgui/src/js/LessonCommitDialog.tsx` | Read-only full-code diff and confirm/cancel UI. |
| `gdbgui/src/js/LessonHistoryDialog.tsx` | SVG version tree, version selection, read-only snapshot diff, restore action. |
| `gdbgui/src/js/SourceCode.tsx` | Save interception, fork-v1 handling, history fetching, and restore-to-editor flow. |
| `gdbgui/src/js/tests/lessonVersion.jest.ts` | Unit tests for comparison and graph layout. |
| `e2e/tests/zz_lesson_sharing.spec.ts` | Update existing fork regression coverage. |
| `e2e/tests/zz_lesson_versions.spec.ts` | Browser flow for diff, commit, history, restore, and branching. |

## Task 1: Add immutable snapshot persistence and make quota accounting historical

**Files:**
- Create: `gdbgui/server/migrations/0004_lesson_versions.sql`
- Modify: `gdbgui/server/db.py`
- Create: `tests/test_lesson_migrations.py`
- Modify: `tests/test_lesson_quotas.py`

- [ ] **Step 1: Write failing database tests.**

  In `tests/test_lesson_migrations.py`, construct a temporary database at schema version 3, insert one legacy lesson, run `db.migrate()`, then assert it has `lesson_versions` v1 with `parent_version_id IS NULL` and a matching `lesson_current_versions` pointer. Run `db.migrate()` again and assert there is still exactly one v1 row.

  In `tests/test_lesson_quotas.py`, replace update-delta assumptions with immutable-history assertions: creating v1 consumes the bundle size; each changed update consumes the entire next snapshot size; a no-change owner save consumes no additional space; deleting the lesson frees every snapshot's space.

  Add database-level behavior tests in `tests/test_lesson_sharing.py` for: a created lesson starts at v1; owner update creates v2 parented to v1; update using `parent_version=1` after v2 creates v3 parented to v1; rejected parent values are a boolean, non-positive integer, unknown version, or a version from another lesson; and a same-content save returns `changed=False` without another row.

- [ ] **Step 2: Run the focused tests to establish red.**

  Run:

  ```powershell
  docker run --rm -v "${PWD}:/work" -w /work cppcodevisualizer-gdbgui sh -lc "pip install --quiet pytest && python -m pytest -p no:cacheprovider -q tests/test_lesson_migrations.py tests/test_lesson_quotas.py tests/test_lesson_sharing.py"
  ```

  Expected: failures because tables and version-aware write helpers do not exist.

- [ ] **Step 3: Add retry-safe migration `0004_lesson_versions.sql`.**

  Use only idempotent statements because the migration runner may retry after a partial `executescript` failure. Create:

  ```sql
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
      ON lesson_versions(lesson_id, version);
  CREATE TABLE IF NOT EXISTS lesson_current_versions (
      lesson_id INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
      version_id INTEGER NOT NULL REFERENCES lesson_versions(id) ON DELETE CASCADE
  );
  ```

  Backfill only rows that do not already have a version with `INSERT OR IGNORE ... SELECT`, using `version = 1`, `parent_version_id = NULL`, and the legacy lesson title/bundle. Then backfill the pointer with `INSERT OR IGNORE` selecting that v1 id. Do not alter `lessons`: retaining its current title/bundle avoids a wide compatibility rewrite and makes repeatable migration safe.

- [ ] **Step 4: Implement one atomic version-aware write path in `db.py`.**

  Introduce a frozen `LessonWriteResult(lesson_id: int, version: int, changed: bool)`. Keep `create_lesson(...) -> int` as a compatibility wrapper around a new `create_lesson_with_version(...) -> LessonWriteResult`, so unrelated callers/tests retain their contract.

  `create_lesson_with_version` must begin `BEGIN IMMEDIATE`, validate payload size and quotas, insert `lessons`, insert `lesson_versions` v1, insert the pointer, commit, and roll back on every error.

  Change `update_lesson_owned_by` to accept `parent_version: Optional[int]` and return `Optional[LessonWriteResult]`. Within the same immediate transaction:

  1. Find the lesson and current pointer while enforcing `lessons.user_id = user_id`; return `None` if not owned/not found.
  2. Resolve omitted parent to the pointer; otherwise load the requested parent by `(lesson_id, version)` and raise `LessonRejected` if it is not an integer positive version belonging to this lesson.
  3. Compare the candidate title/bundle with the current materialized lesson. If equal, commit and return the current version with `changed=False`.
  4. Check quota using the full new `bundle_json` byte size, choose `MAX(version) + 1`, insert the child snapshot with the resolved parent row id, update `lessons.title`, `lessons.bundle_json`, and `updated_at`, upsert `lesson_current_versions`, and return `changed=True`.

  Do not mutate any historical row. The SQL uniqueness constraint, transaction, and `MAX(version)+1` make repeated concurrent writers serialize safely under SQLite's immediate write lock.

- [ ] **Step 5: Make storage queries count snapshots once.**

  Replace `_USED_BYTES_SQL` with a sum over `lesson_versions.bundle_json` joined to `lessons`; adapt `_check_quotas` to accept bytes being added rather than a replacement delta. Call it before each new snapshot insert. Keep existing per-bundle size validation, global quota validation, and integer error behavior.

- [ ] **Step 6: Add owner-only read helpers.**

  Add small queries returning rows for `lesson_versions_owned_by(lesson_id, user_id)`, `lesson_version_owned_by(lesson_id, user_id, version)`, and `lesson_version_diff_owned_by(lesson_id, user_id, version)`. Each query joins `lessons` and filters its `user_id` so callers cannot distinguish another owner's lesson from a missing one. Include `version`, `parent_version`, `title`, `bundle_json`, and `created_at`; list rows newest first.

  Extend `lesson_by_id` to include `current_version` using a left join through `lesson_current_versions`/`lesson_versions`, without changing its visibility rule.

- [ ] **Step 7: Run focused database tests to green.**

  Re-run the Step 2 command. Then run all server lesson tests:

  ```powershell
  docker run --rm -v "${PWD}:/work" -w /work cppcodevisualizer-gdbgui sh -lc "pip install --quiet pytest && python -m pytest -p no:cacheprovider -q tests/test_lesson_sharing.py tests/test_lesson_quotas.py tests/test_lesson_migrations.py tests/test_lesson_tags.py"
  ```

- [ ] **Step 8: Commit the persistence slice.**

  ```powershell
  git add gdbgui/server/migrations/0004_lesson_versions.sql gdbgui/server/db.py tests/test_lesson_migrations.py tests/test_lesson_quotas.py tests/test_lesson_sharing.py
  git commit -m "feat: 保存教案版本歷史"
  ```

## Task 2: Expose version-aware lesson API while preserving fork semantics

**Files:**
- Modify: `gdbgui/server/http_routes.py`
- Modify: `tests/test_lesson_sharing.py`

- [ ] **Step 1: Add failing route tests.**

  Cover `GET /api/lessons/<id>` exposing `current_version`; owner save responding with `{id, forked: false, version, changed}`; owner save with a selected `parent_version`; and a non-owner saving an unchanged visible lesson returning `{forked: true, version: 1, changed: true}` with a new id.

  Add authenticated owner success tests for:

  ```text
  GET /api/lessons/<id>/versions
  GET /api/lessons/<id>/versions/<version>
  GET /api/lessons/<id>/versions/<version>/diff
  ```

  Assert the list includes parent links and current version, snapshot endpoint returns title and decoded bundle, diff endpoint returns selected snapshot plus its parent or `null` for v1. Assert another user receives 404 for all three endpoints, including when the target lesson exists.

- [ ] **Step 2: Run focused API tests to establish red.**

  ```powershell
  docker run --rm -v "${PWD}:/work" -w /work cppcodevisualizer-gdbgui sh -lc "pip install --quiet pytest && python -m pytest -p no:cacheprovider -q tests/test_lesson_sharing.py"
  ```

- [ ] **Step 3: Update POST/PUT responses and parent validation.**

  Keep `_lesson_payload()` as the single title/bundle validation path. Parse an optional JSON `parent_version` only after determining the request is from the existing lesson's owner. Reject bools, non-integers, and values less than one with `db.LessonRejected`; leave non-owner forks independent of any supplied parent.

  Use `db.create_lesson_with_version` for POST and the non-owner PUT fork path. Use the version-aware `db.update_lesson_owned_by` for owned PUT. Return the existing status codes (201 for create/fork; 200 for owner update) and JSON containing `id`, `forked`, `version`, and `changed`.

  For a non-owner PUT, always create a new v1 from the submitted title/bundle, even when its bytes equal the source lesson; do not call an owner history query and do not duplicate original version records.

- [ ] **Step 4: Add three owner-gated GET handlers.**

  Convert database rows into the public shape:

  ```json
  {"version": 3, "parent_version": 1, "title": "...", "bundle": {}, "created_at": "..."}
  ```

  The list returns `{"versions": [...], "current_version": 3}` and does not need bundle payloads. Snapshot and diff endpoints decode `bundle_json`. When any helper returns no owner-visible row, call the existing `_lesson_not_found()` response so non-owners receive the same 404 as nonexistent data. Do not add a restore endpoint: restore remains a client-side selection until the next normal save.

- [ ] **Step 5: Run API regressions to green.**

  Run the Step 2 command, then:

  ```powershell
  docker run --rm -v "${PWD}:/work" -w /work cppcodevisualizer-gdbgui sh -lc "pip install --quiet pytest && python -m pytest -p no:cacheprovider -q tests/test_lesson_sharing.py tests/test_lesson_quotas.py tests/test_lesson_tags.py"
  ```

- [ ] **Step 6: Commit the route slice.**

  ```powershell
  git add gdbgui/server/http_routes.py tests/test_lesson_sharing.py
  git commit -m "feat: 提供教案版本歷史 API"
  ```

## Task 3: Build the small, testable frontend version model

**Files:**
- Create: `gdbgui/src/js/lessonVersion.ts`
- Create: `gdbgui/src/js/tests/lessonVersion.jest.ts`

- [ ] **Step 1: Add failing Jest tests for comparison and graph layout.**

  Define tests proving that `hasSnapshotChanges` returns true for title-only changes, source-code changes, and inline `//@` annotation changes; returns false when recursively equivalent bundle object keys arrive in a different order; and notices program input/breakpoint changes.

  Test a branch graph with `v1 -> v2 -> v3`, `v3 -> v4`, and `v3 -> v5` where head is v5. Assert exactly four valid parent edges, at least two lanes, v5 alone has `isHead`, and malformed/missing parent references do not throw or create an edge.

- [ ] **Step 2: Run the focused unit test to establish red.**

  ```powershell
  cd gdbgui; npm test -- --runInBand src/js/tests/lessonVersion.jest.ts
  ```

- [ ] **Step 3: Implement only pure helpers and types.**

  Add exported structural types for lesson bundle, complete snapshot, version summary, graph node, and graph edge. Implement a recursive stable JSON serializer that sorts object keys (leaving array order unchanged), then compare `{title, bundle}` serializations. This makes every bundle field participate without maintaining a duplicate field list.

  Implement `layoutVersionGraph(versions, headVersion)` with one parent-to-children map, children sorted newest first, and a depth-first lane assignment: leaves take the next lane; each parent reuses its first child's lane. Return version rows in descending version order and edges only when both endpoints exist. This is sufficient for the single-parent version tree and requires no graph dependency.

- [ ] **Step 4: Run unit and type/build checks to green.**

  ```powershell
  cd gdbgui; npm test -- --runInBand src/js/tests/lessonVersion.jest.ts
  cd gdbgui; npm run build
  ```

- [ ] **Step 5: Commit the frontend model slice.**

  ```powershell
  git add gdbgui/src/js/lessonVersion.ts gdbgui/src/js/tests/lessonVersion.jest.ts
  git commit -m "feat: 加入教案版本樹模型"
  ```

## Task 4: Gate owner saves with a full Monaco diff preview

**Files:**
- Create: `gdbgui/src/js/LessonCommitDialog.tsx`
- Modify: `gdbgui/src/js/SourceCode.tsx`

- [ ] **Step 1: Locate and preserve the current lesson save test hooks.**

  Keep `data-testid="save-lesson-to-account"` so existing E2E actions remain valid. Add stable dialog controls: `lesson-commit-dialog`, `lesson-commit-confirm`, and `lesson-commit-cancel`.

- [ ] **Step 2: Implement the minimal read-only commit dialog.**

  Reuse the installed `DiffEditor` export from `@monaco-editor/react`. `LessonCommitDialog` accepts baseline snapshot, candidate `{title, bundle}`, `onConfirm`, and `onCancel`. Show old/new titles as text and render a read-only, side-by-side diff with original and modified `source_code`, fixed height around 360px. Inline annotations need no special parser: they are part of the source string and Monaco highlights their changed lines.

- [ ] **Step 3: Make `SourceCode` maintain one commit baseline.**

  Add narrowly scoped state/instance data for current lesson ownership, current/selected parent version, baseline snapshot, and a pending candidate. On loading a lesson, set the baseline from the API title/bundle/current version and record `is_mine`.

  On first-ever user lesson save, POST directly to create v1, then set ownership, id, version, and baseline from the submitted snapshot. On a non-owner lesson save, PUT directly to fork independent v1, then replace the current lesson identity/baseline with the fork response. Neither path opens commit history or copies history.

  On owner save, build the existing project bundle and candidate title. If `hasSnapshotChanges(baseline, candidate)` is false, show the existing-style user feedback and skip the request. If true, store the candidate and open `LessonCommitDialog`. Confirm sends the existing PUT with `title`, `bundle`, and `parent_version` equal to selected/current version; success updates the baseline and current version. Cancel only clears pending UI state and leaves the editor/server untouched.

- [ ] **Step 4: Add/update Playwright coverage for pre-submit behavior.**

  In `e2e/tests/zz_lesson_versions.spec.ts`, authenticate an owner, create/load v1, change the title, source code, and a `//@` annotation, click save, and assert the commit dialog appears. Click cancel and verify the API's current version/title/bundle remain v1. Repeat, click confirm, and verify v2 is now current. This test must use the live UI and not directly create v2 by API.

- [ ] **Step 5: Run frontend checks.**

  ```powershell
  cd gdbgui; npm test -- --runInBand
  cd gdbgui; npm run build
  ```

- [ ] **Step 6: Commit the commit-preview slice.**

  ```powershell
  git add gdbgui/src/js/LessonCommitDialog.tsx gdbgui/src/js/SourceCode.tsx e2e/tests/zz_lesson_versions.spec.ts
  git commit -m "feat: 儲存前顯示教案差異"
  ```

## Task 5: Add the owner-only version tree, snapshot diff, and restore branch flow

**Files:**
- Create: `gdbgui/src/js/LessonHistoryDialog.tsx`
- Modify: `gdbgui/src/js/SourceCode.tsx`
- Modify: `e2e/tests/zz_lesson_sharing.spec.ts`
- Modify: `e2e/tests/zz_lesson_versions.spec.ts`

- [ ] **Step 1: Implement `LessonHistoryDialog` with no external graph library.**

  The dialog accepts summaries, selected snapshot/parent snapshot, current head, and select/restore/close callbacks. It calls `layoutVersionGraph`, draws lane lines/edges and nodes in a small SVG, labels each version, and visibly labels only the current node `HEAD`. Add `data-testid="lesson-version-node-<N>"` per selectable node, `lesson-history-dialog`, `lesson-history-close`, and `lesson-version-restore`.

  When a node is selected, show its title/metadata and render `DiffEditor` between its parent source (empty for v1) and its source. The same raw source comparison includes inline annotations. Do not add commit-message, merge, or branch-management UI.

- [ ] **Step 2: Wire owner history API requests in `SourceCode`.**

  Add a visible `lesson-history-open` toolbar control only when the currently loaded lesson is owned by the viewer. Fetch `/versions` on open. Fetch `/versions/<n>/diff` on node selection. If either request fails, add the existing console-style error entry and keep the editor unchanged.

  Restore applies the selected snapshot through existing `applyProjectBundle`, changes the current title, and changes only the pending parent/current baseline version in memory. It does not write immediately. The next confirmed owner save posts that selected version as `parent_version`, which creates the new child/HEAD on the server.

- [ ] **Step 3: Complete browser/API regression tests.**

  Extend `zz_lesson_versions.spec.ts`: after v2, open history, verify v1 and v2 plus HEAD v2, select/restore v1, verify the editor returns to its v1 source/title, make a new change, confirm save, then inspect the API list to verify v3 has `parent_version: 1`, v2 remains present, and v3 is current HEAD.

  Update `zz_lesson_sharing.spec.ts` so a second user loads a public lesson and saves it unchanged. Assert the result is a new owned lesson at independent v1, its `/versions` list has only that v1, and the source lesson's `/versions` endpoint is 404 to the second user. Verify the original lesson remains unchanged when retrieved as its owner.

- [ ] **Step 4: Run targeted end-to-end tests in Docker.**

  ```powershell
  docker compose up -d --build
  docker compose exec gdbgui sh -lc "cd /app/e2e && npx playwright test tests/zz_lesson_versions.spec.ts tests/zz_lesson_sharing.spec.ts --reporter=line"
  ```

- [ ] **Step 5: Run the full practical verification set.**

  ```powershell
  cd gdbgui; npm test -- --runInBand
  cd gdbgui; npm run build
  docker run --rm -v "${PWD}:/work" -w /work cppcodevisualizer-gdbgui sh -lc "pip install --quiet pytest && python -m pytest -p no:cacheprovider -q"
  docker compose exec gdbgui sh -lc "cd /app/e2e && npx playwright test --reporter=line"
  git diff --check
  ```

  Record any pre-existing full E2E failures separately; do not attribute them to this feature unless the targeted feature tests reproduce the same failure.

- [ ] **Step 6: Commit the history/restore slice.**

  ```powershell
  git add gdbgui/src/js/LessonHistoryDialog.tsx gdbgui/src/js/SourceCode.tsx e2e/tests/zz_lesson_sharing.spec.ts e2e/tests/zz_lesson_versions.spec.ts
  git commit -m "feat: 顯示教案版本樹並支援還原"
  ```

## Final Review Checklist

- [ ] Confirm migration `0004` is retry-safe and legacy lessons receive exactly one v1/HEAD pair.
- [ ] Confirm snapshot writes, materialized current lesson, pointer updates, and quota checks happen in one transaction.
- [ ] Confirm title, code, inline annotations, breakpoints, program input, and every bundle field participate in diff/change detection.
- [ ] Confirm a restore does not mutate a historical record and a later save branches from the restored version.
- [ ] Confirm all owner-only history routes return indistinguishable 404 responses for non-owners and nonexistent lessons.
- [ ] Confirm fork has exactly one independent v1 even for unchanged content and cannot see/copy source history.
- [ ] Confirm no new dependency, no merge support, no commit-message feature, and no code paths outside the file map were added without a concrete need.
