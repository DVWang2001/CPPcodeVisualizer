#!/usr/bin/env bash
# Native g++ behaviour of the P2 design cases, on lab-david. Same rules as run_p1.sh: two zero-connection readings
# in a row first, a one-off container with --cpus 2 -m 3g --network none, sources mounted read-only, no core dumps.
# Start: nohup bash ~/iris-a-tests/p2native/run_native.sh > /dev/null 2>&1 < /dev/null &
set -u
DIR="$HOME/iris-a-tests/p2native"
cd "$DIR" || exit 3
echo $$ > "$DIR/native.pid"
exec >>"$DIR/run-native.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/login)  online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"; }
wait_empty() {
  local gap="$1" zeros=0 i n
  for i in $(seq 1 $((3600 / gap))); do
    n=$(ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l)
    if [ "$n" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
    [ "$zeros" -ge 2 ] && return 0
    sleep "$gap"
  done
  return 1
}
echo "== native start $(date -Is)"
echo "core_pattern: $(cat /proc/sys/kernel/core_pattern)"
live
wait_empty 20 || { echo "people stayed online for 60 minutes, nothing was run"; finish 2; }
docker image inspect gcc:14 > /dev/null 2>&1 || { echo "image gcc:14 is missing"; finish 4; }
echo "cases: $(ls cases/*.cpp | wc -l)  inner $(sha256sum inner.sh | cut -c1-12)"
t0=$(date +%s)
docker run --rm --name p2-native --cpus 2 -m 3g --network none --security-opt no-new-privileges:true \
  -v "$DIR/cases:/w/cases:ro" -v "$DIR/inner.sh:/w/inner.sh:ro" gcc:14 bash /w/inner.sh > "$DIR/log-native.txt" 2>&1
RC=$?
echo "native rc=$RC $(( $(date +%s) - t0 )) s, $(grep -c '^NATIVE ' "$DIR/log-native.txt") results"
live
finish $RC
