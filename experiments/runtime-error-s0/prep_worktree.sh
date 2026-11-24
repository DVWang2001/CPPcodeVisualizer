#!/usr/bin/env bash
# One-off: ~/iris-preview holds the 7 live-quiz files of commit 42b297e9 as uncommitted CRLF copies
# (checked 2026-11-23: identical to the commit except line endings). Keep a diff, then restore and detach at 42b297e9.
set -u
BASE="$HOME/iris-a-tests/errspike"
cd "$HOME/iris-preview" || { echo "EXIT=4"; exit 4; }
git diff > "$BASE/worktree-before-20261123.diff"
echo "saved diff: $(wc -c < "$BASE/worktree-before-20261123.diff") bytes"
git checkout -- $(git diff --name-only)
git checkout -q --detach 42b297e9
echo "HEAD $(git rev-parse --short HEAD); status lines: $(git status --short | wc -l)"
echo "EXIT=0"
