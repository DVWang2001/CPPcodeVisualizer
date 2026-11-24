#!/usr/bin/env bash
# IRIS runtime-error S0 follow-up: fid2.mjs (see its header), with the image built by run_s0.sh build.
# Start: nohup bash ~/iris-a-tests/errspike/run_fid2.sh > /dev/null 2>&1 < /dev/null &
# Writes run-fid2.log (ends with EXIT=<code>), log-fid2.txt, results-fid2.json, diag-*.cpp; the script's PID is in fid2.pid.
set -u
BASE="$HOME/iris-a-tests/errspike"
IMG=iris-preview:errspike-builder
cd "$BASE" || exit 3
echo $$ > "$BASE/fid2.pid"
exec >>"$BASE/run-fid2.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/login)  online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"; }
echo "== fid2 start $(date -Is)"
live
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "image $IMG is gone"; finish 4; }
# the user's rule: start only after two zero-connection readings in a row, at most 60 minutes
zeros=0
for i in $(seq 1 60); do
  n=$(ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l)
  if [ "$n" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
  [ "$zeros" -ge 2 ] && break
  sleep 60
done
[ "$zeros" -ge 2 ] || { echo "people stayed online for 60 minutes, nothing was run"; finish 2; }
t0=$(date +%s)
docker run --rm --name errspike-fid2 --cpus 2 -m 3g --network none --security-opt no-new-privileges:true \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e REPO=/app -v "$BASE:/spike" -w /spike \
  "$IMG" node fid2.mjs > "$BASE/log-fid2.txt" 2>&1
rc=$?
echo "fid2 rc=$rc $(( $(date +%s) - t0 )) s: $(tail -n 1 "$BASE/log-fid2.txt")"
live
finish "$rc"
