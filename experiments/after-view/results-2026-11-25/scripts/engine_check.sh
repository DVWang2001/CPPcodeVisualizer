#!/usr/bin/env bash
# IRIS display "after" (docs/superpowers/plans/2026-11-25-after-view-plan.md): engine tests on lab-david in the builder
# image that frontend_check.sh build made (iris-preview:<dir name>-builder), with files/ mounted read-only over /app
# (the same files/ frontend_check.sh uses). No image rebuild per edit; the localgdb change needs no engine asset rebuild.
#   node NAME FILE...   node --test --test-concurrency=1 FILE... with files/ mounted; complete TAP in log-node-NAME.txt
#   base NAME FILE...   the same without mounts: the base commit as built into the image
# Start: bash go.sh bash ./engine_check.sh <phase> NAME FILE...   (go.sh detaches it and prints the PID)
# Writes <phase>-NAME.pid first, appends to run-<phase>-NAME.log and ends with EXIT=<code>.
set -u
PHASE="${1:-}"; NAME="${2:-x}"
shift 2 2>/dev/null || shift $#
DIR="$(cd "$(dirname "$0")" && pwd)"
IMG="iris-preview:$(basename "$DIR")-builder"
TAG="$PHASE-$NAME"
cd "$DIR" || exit 3
echo $$ > "$DIR/$TAG.pid"
exec >>"$DIR/run-$TAG.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
online() { ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l; }
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  online: $(online)"; }
# the user's rule: start only after two zero-connection readings in a row (20 s apart), at most 60 minutes
wait_empty() {
  local zeros=0 i
  for i in $(seq 1 180); do
    if [ "$(online)" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
    [ "$zeros" -ge 2 ] && return 0
    sleep 20
  done
  echo "people stayed online for 60 minutes, nothing was run"; return 1
}
echo "== $TAG start $(date -Is)"
live
case "$PHASE" in node|base) ;; *) echo "usage: engine_check.sh node|base NAME FILE..."; finish 64 ;; esac
[ $# -gt 0 ] || { echo "name the test files"; finish 64; }
docker image inspect "$IMG" > /dev/null 2>&1 || { echo "image $IMG is missing: run frontend_check.sh build first"; finish 4; }
wait_empty || finish 2
M=()
if [ "$PHASE" = node ] && [ -d "$DIR/files" ]; then
  while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
  echo "mounted $(( ${#M[@]} / 2 )) files:"
  (cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort | xargs -r sha256sum | cut -c1-12,65-)
fi
echo "test files: $*"
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" -w /app "$IMG" \
  node --test --test-concurrency=1 "$@" > "$DIR/log-$TAG.txt" 2>&1
rc=$?
echo "rc=$rc in $(( $(date +%s) - t0 )) s: $(grep -E '^# (tests|pass|fail|cancelled|skipped) ' "$DIR/log-$TAG.txt" | tr '\n' ' ')"
echo "-- not ok:"; grep -nE '^ *not ok ' "$DIR/log-$TAG.txt" | head -60
live
finish "$rc"
