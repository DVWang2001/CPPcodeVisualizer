---
name: test
description: Run the Jest test suite and report results. Use before committing, after editing AnimScheduler / BSTPlugin / ContainerPlugin / ContainerVisualizer.
argument-hint: "[test-file-pattern]"
---

Run `npm test` (optionally filtered to `$arguments` if provided).

## Workflow

1. Run the test suite:
   - If `$arguments` is given: `npm test -- --testPathPattern="$arguments"`
   - Otherwise: `npm test`
2. Report: total passed / failed / skipped, and which test file each failure is in.
3. If any test failed:
   - Show the exact failure message.
   - Identify which source file caused the regression (AnimScheduler.ts / BSTPlugin.ts / etc.).
   - Propose a fix, but do NOT commit anything.
4. If all tests passed: confirm with the count and time taken.

## Context

```!
cd "c:/碩士/研究/papper/CPPcodeVisualizer" && echo "Branch: $(git branch --show-current)" && echo "Modified: $(git diff --name-only | tr '\n' ' ')"
```
