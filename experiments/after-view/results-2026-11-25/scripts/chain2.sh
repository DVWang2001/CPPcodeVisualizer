#!/usr/bin/env bash
# chain2.sh: after chain.sh ends — the base engine suite (the image as built from BASE, no mounts) for the failure
# baseline, then lesson_tokens.mjs over every lesson bundle with the change mounted (out/lesson_tokens.json).
# Start: bash go.sh bash ./chain2.sh   (writes chain2.pid, appends to run-chain2.log, ends with CHAIN2-EXIT=<code>)
cd "$(dirname "$0")" || exit 3
DIR="$(pwd)"
echo $$ > chain2.pid
exec >> run-chain2.log 2>&1
echo "== chain2 start $(date -Is)"
[ -f chain.pid ] && tail --pid="$(cat chain.pid)" -f /dev/null
echo "chain.sh done $(date -Is)"
L=tests/engine/localgdb
ENG="$L/addresses.test.mjs $L/arrays.test.mjs $L/cell_jump.test.mjs $L/class_support.test.mjs \
$L/commands.test.mjs $L/compare.test.mjs $L/container_refs.test.mjs $L/containers.test.mjs $L/expr.test.mjs \
$L/fastforward_template.test.mjs $L/ghostSnapshots.test.mjs $L/lessons_corpus.test.mjs $L/lines.test.mjs \
$L/pointers.test.mjs $L/protocol.test.mjs $L/real_gdb_refs.test.mjs $L/replay.test.mjs $L/runtime_errors.test.mjs \
$L/s4_line_after.test.mjs $L/types_scopes.test.mjs tests/engine/s1_stamps.test.mjs tests/engine/s2_flush.test.mjs \
tests/engine/s3_after.test.mjs"
bash ./engine_check.sh base suite $ENG; echo "base-suite rc=$?"
IMG="iris-preview:$(basename "$DIR")-builder"
M=()
while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
mkdir -p out && chmod 777 out
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" \
  -v "$DIR/lesson_tokens.mjs:/app/lesson_tokens.mjs:ro" -v "$DIR/out:/out" -w /app "$IMG" \
  node lesson_tokens.mjs /out/lesson_tokens.json > log-tokens.txt 2>&1
echo "tokens rc=$? in $(( $(date +%s) - t0 )) s"; tail -3 log-tokens.txt
echo "CHAIN2-EXIT=0"
