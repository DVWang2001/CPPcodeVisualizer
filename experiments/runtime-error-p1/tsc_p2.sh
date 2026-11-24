#!/usr/bin/env bash
# P2 type check on lab-david: TypeScript 5.4.5 (the repo's TS 3.9 cannot parse newer @types) run with node inside the
# base builder image, without and with the changed files mounted over /app; prints the errors that exist only with the
# change. The compiler tarball is fetched on the host (sha1 checked against the npm registry) and mounted read-only, so
# both containers run with --network none.
# Start: nohup bash ~/iris-a-tests/p1/tsc_p2.sh > /dev/null 2>&1 < /dev/null &   (writes tsc.pid, run-tsc.log, EXIT=)
set -u
DIR="$HOME/iris-a-tests/p1"
IMG=iris-preview:p1-builder
TSV=5.4.5
cd "$DIR" || exit 3
echo $$ > "$DIR/tsc.pid"
exec >>"$DIR/run-tsc.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"; }
echo "== tsc start $(date -Is)"
live
if [ ! -f "$DIR/ts$TSV/package/bin/tsc" ]; then
  want=$(curl -sSf "https://registry.npmjs.org/typescript/$TSV" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist"]["shasum"])') || finish 10
  curl -sSfL "https://registry.npmjs.org/typescript/-/typescript-$TSV.tgz" -o "$DIR/ts$TSV.tgz" || finish 11
  got=$(sha1sum "$DIR/ts$TSV.tgz" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "typescript-$TSV.tgz sha1 $got, registry says $want"; finish 12; }
  rm -rf "$DIR/ts$TSV"; mkdir -p "$DIR/ts$TSV" && tar -xzf "$DIR/ts$TSV.tgz" -C "$DIR/ts$TSV" || finish 13
  rm -f "$DIR/ts$TSV.tgz"
  echo "typescript $TSV fetched; sha1 $got matches the registry"
fi
# the user's rule: start only after two zero-connection readings in a row (20 s apart), at most 60 minutes
zeros=0
for i in $(seq 1 180); do
  n=$(ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l)
  if [ "$n" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
  [ "$zeros" -ge 2 ] && break
  sleep 20
done
[ "$zeros" -ge 2 ] || { echo "people stayed online for 60 minutes, nothing was run"; finish 2; }
docker image inspect "$IMG" > /dev/null 2>&1 || { echo "image $IMG is missing"; finish 4; }
mounts=()
while IFS= read -r f; do mounts+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
echo "mounting $(( ${#mounts[@]} / 2 )) files for the changed run"
tsc_run() {
  docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true \
    -v "$DIR/ts$TSV/package:/ts:ro" "$@" -w /app "$IMG" sh -c 'node /ts/bin/tsc --noEmit -p . 2>&1; echo "tsc rc=$?"'
}
t0=$(date +%s)
tsc_run > "$DIR/tsc-base-raw.txt"; echo "base: $(tail -1 "$DIR/tsc-base-raw.txt") in $(( $(date +%s) - t0 )) s"
t0=$(date +%s)
tsc_run "${mounts[@]}" > "$DIR/tsc-new-raw.txt"; echo "new:  $(tail -1 "$DIR/tsc-new-raw.txt") in $(( $(date +%s) - t0 )) s"
norm() { grep -E "error TS[0-9]+" "$1" | sed -E 's/\(([0-9]+),([0-9]+)\)/(L,C)/' | sort; }
norm "$DIR/tsc-base-raw.txt" > "$DIR/tsc-base.txt"; norm "$DIR/tsc-new-raw.txt" > "$DIR/tsc-new.txt"
echo "error lines: base $(wc -l < "$DIR/tsc-base.txt"), new $(wc -l < "$DIR/tsc-new.txt")"
echo "== only with the change:"; comm -13 "$DIR/tsc-base.txt" "$DIR/tsc-new.txt"
echo "== only in base:"; comm -23 "$DIR/tsc-base.txt" "$DIR/tsc-new.txt"
echo "== with the change, raw lines naming the P2 files:"
grep -nE "runtimeDiag|RuntimeError|runtimeErrorState|LineAfterPanel|RightSidebar|SourceCode|GdbApi|process_gdb_response|localEngine" "$DIR/tsc-new-raw.txt" | head -60
live
finish 0
