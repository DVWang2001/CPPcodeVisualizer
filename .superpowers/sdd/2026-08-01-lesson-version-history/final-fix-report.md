# Lesson version history — final fix report

## Result

Implemented the approved final fix wave. The product decision is enforced: a
save based on an explicitly selected old version creates a new child snapshot,
even when its complete title/bundle is identical to the current HEAD. A no-op
is limited to unchanged content whose resolved parent is the current HEAD.

Code and regression commit: `becae54 fix: 完善教案版本提交與差異`.

## Changes

1. Restore now leaves the materialized server HEAD as the comparison baseline
   and records the restored version separately as the pending parent. The next
   save therefore opens the confirmation dialog and branches from that selected
   version without modifying historical rows.
2. The data layer only short-circuits an unchanged write when its parent is the
   current pointer. It also validates SQLite signed-64-bit bounds before
   binding lesson IDs or version numbers.
3. The editor overlays its own source, breakpoint, program-input, filename,
   and format fields onto a retained complete bundle template. Unknown top-level
   fields survive load, restore, comparison, owner save, and fork; only legacy
   `line_data` is intentionally discarded after conversion to inline comments.
4. Commit and history dialogs retain source/title diffs and add read-only JSON
   `DiffEditor` views for all non-source bundle fields. Both dialogs focus a
   useful initial control, trap Tab/Shift+Tab, close with Escape, and restore
   focus to their invoking control.
5. Added regressions for old-parent same-content branches, migration replay
   after v4 DDL/backfill but before its schema record, oversized parent/version
   values, array ordering, graph lane selection, dialog keyboard behavior,
   restore-then-save with no editing, and opaque bundle preservation.

## Verification

Red checks observed before implementation:

- Python: old-parent same-content save incorrectly returned v2 unchanged;
  `2**63` parent/version inputs produced HTTP 500 from SQLite binding.
- Frontend: missing bundle merge helper and dialogs had no focus behavior.

Green checks:

```text
docker run ... pytest ... tests/test_lesson_migrations.py tests/test_lesson_sharing.py tests/test_lesson_quotas.py
60 passed

npm test -- --runInBand
22 suites, 293 tests passed

NODE_OPTIONS=--openssl-legacy-provider npm run build
Webpack production build passed

git diff --check
passed; working tree clean after the code commit
```

The commit hook reran the full Jest suite successfully (22 suites, 293 tests).

## Self-review

- No new dependency, merge operation, commit-message UI, or restore API.
- Historical snapshots remain immutable; the current lesson is only advanced by
  a normal confirmed save.
- Owner-only version reads return 404 for invalid/out-of-range version values
  instead of leaking an SQLite `OverflowError` as a 500.
- The SVG graph still uses the existing one-parent tree model; new tests assert
  array ordering affects snapshots and a parent reuses its newest child's lane.

## Known verification blockers

- Browser E2E collection remains unavailable because `e2e/package.json` is
  absent. This final wave adds the targeted Playwright regressions but does not
  repair that unrelated repository/infrastructure issue.
- `npm run lint` remains unavailable for the whole repository because its old
  Prettier parser rejects existing TypeScript `import type` syntax in unrelated
  files. The production build and Jest type/transpile paths both passed.
- Webpack emitted pre-existing bundle-size, Browserslist-age, and Tailwind
  deprecation warnings; the build completed successfully.
