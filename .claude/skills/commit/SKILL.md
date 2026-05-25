---
name: commit
description: Safe commit workflow — runs tests and build before committing. Use instead of running git commit directly to avoid breaking the animation pipeline.
argument-hint: "[commit message]"
---

Commit using this exact sequence. Abort at any failing step.

## Current state

```!
cd "c:/碩士/研究/papper/CPPcodeVisualizer" && git status --short && echo "---" && git diff --stat HEAD
```

## Steps

1. **Tests** — run `npm test`.
   - If any test fails: show the failure, stop, do NOT proceed to step 2.
   - If all pass: continue.

2. **Build** — run `$env:NODE_OPTIONS="--openssl-legacy-provider"; npm run build` (PowerShell) or `NODE_OPTIONS=--openssl-legacy-provider npm run build` (bash).
   - If build errors appear: show the error, stop, do NOT proceed to step 3.
   - If build succeeds: continue.

3. **Stage & commit**
   - Ask me which files to stage if `$arguments` (the commit message) was not provided.
   - Stage only the relevant files (never `node_modules`, `.env`, `dist/`).
   - Commit with message: `$arguments` (or ask me for one if not provided).
   - End the message with `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.

4. **Report** — show the final `git log --oneline -3`.

## Rules
- Never use `--no-verify` to bypass the pre-commit hook.
- Never `git add .` or `git add -A` — always stage specific files.
- If the commit message is empty, ask before proceeding.
