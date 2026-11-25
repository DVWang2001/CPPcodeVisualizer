#!/usr/bin/env bash
# tokens_live.sh: lesson_tokens.mjs over the live library's bundles (live/*.json, read with GET /api/lessons/<id>) with
# the change mounted; out/lesson_tokens_live.json. Waits for an empty classroom first (the user's rule).
# Start: bash go.sh bash ./tokens_live.sh   (writes tokens_live.pid, appends to run-tokens_live.log, ends with EXIT=<code>)
cd "$(dirname "$0")" || exit 3
DIR="$(pwd)"
echo $$ > tokens_live.pid
exec >> run-tokens_live.log 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
online() { ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l; }
wait_empty() {
  local zeros=0 i
  for i in $(seq 1 180); do
    if [ "$(online)" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
    [ "$zeros" -ge 2 ] && return 0
    sleep 20
  done
  echo "people stayed online for 60 minutes, nothing was run"; return 1
}
echo "== tokens_live start $(date -Is)  online: $(online)"
wait_empty || finish 2
echo "empty classroom at $(date -Is)"
IMG="iris-preview:$(basename "$DIR")-builder"
M=()
while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
mkdir -p out && chmod 777 out
ARGS=()
for f in $(cd "$DIR/live" && ls *.json | sort); do ARGS+=("/live/$f"); done
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" \
  -v "$DIR/lesson_tokens.mjs:/app/lesson_tokens.mjs:ro" -v "$DIR/live:/live:ro" -v "$DIR/out:/out" -w /app "$IMG" \
  node lesson_tokens.mjs /out/lesson_tokens_live.json "${ARGS[@]}" > log-tokens_live.txt 2>&1
rc=$?
echo "tokens rc=$rc in $(( $(date +%s) - t0 )) s  online: $(online)"; tail -3 log-tokens_live.txt
finish "$rc"
