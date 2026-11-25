#!/usr/bin/env bash
# chain.sh: the verdict runs in a row as one job (one watcher): the engine suite with the change mounted, then
# frontend_check.sh check (full serial jest, tsc 5.4.5 base vs change, previews on 5002 and 5003 with lessons/).
# Start: bash go.sh bash ./chain.sh   (writes chain.pid, appends to run-chain.log, ends with CHAIN-EXIT=<code>)
cd "$(dirname "$0")" || exit 3
echo $$ > chain.pid
exec >> run-chain.log 2>&1
echo "== chain start $(date -Is)"
L=tests/engine/localgdb
ENG="$L/addresses.test.mjs $L/after_view.test.mjs $L/arrays.test.mjs $L/cell_jump.test.mjs $L/class_support.test.mjs \
$L/commands.test.mjs $L/compare.test.mjs $L/container_refs.test.mjs $L/containers.test.mjs $L/expr.test.mjs \
$L/fastforward_template.test.mjs $L/ghostSnapshots.test.mjs $L/lessons_corpus.test.mjs $L/lines.test.mjs \
$L/pointers.test.mjs $L/protocol.test.mjs $L/real_gdb_refs.test.mjs $L/replay.test.mjs $L/runtime_errors.test.mjs \
$L/s4_line_after.test.mjs $L/types_scopes.test.mjs tests/engine/s1_stamps.test.mjs tests/engine/s2_flush.test.mjs \
tests/engine/s3_after.test.mjs"
bash ./engine_check.sh node suite $ENG; echo "node-suite rc=$?"
bash ./frontend_check.sh check; echo "check rc=$?"
echo "CHAIN-EXIT=0"
