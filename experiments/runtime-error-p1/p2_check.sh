#!/usr/bin/env bash
# P2 checks on lab-david, strictly one after another: full jest (serial), tsc 5.4.5 (changed vs base), preview rebuild
# with the P2 files, then a fresh throwaway account and the P2 demo lessons on the preview.
# Start: nohup bash ~/iris-a-tests/p1/p2_check.sh > /dev/null 2>&1 < /dev/null &   (writes p2check.pid, run-p2check.log)
set -u
DIR="$HOME/iris-a-tests/p1"
cd "$DIR" || exit 3
echo $$ > "$DIR/p2check.pid"
exec >>"$DIR/run-p2check.log" 2>&1
last_block() { tac "$1" | sed "/$2/q" | tac; }
echo "== p2check start $(date -Is)"
bash run_p1.sh run p2jestall2 suite-jestall.sh
echo "-- jest: $(head -1 log-p2jestall2.txt) | $(grep -E '^Tests:|^Test Suites:' log-p2jestall2.txt | head -2 | tr '\n' ' ')"
grep -E "^FAIL|✕" log-p2jestall2.txt | sort -u | head -20
bash tsc_p2.sh
echo "-- tsc:"; last_block run-tsc.log "== tsc start"
bash run_p1.sh preview
echo "-- preview:"; last_block run-preview.log "== preview start"
echo "-- fill:"; bash preview_fill_p2.sh
echo "== p2check end $(date -Is)"
echo "EXIT=0"
