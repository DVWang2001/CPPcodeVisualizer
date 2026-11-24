#!/usr/bin/env bash
# IRIS runtime-error S0 on lab-david. Files live in ~/iris-a-tests/errspike (see README.md).
#   bash run_s0.sh build    wait for an empty classroom, check out 42b297e9 in ~/iris-preview, build the builder image
#   bash run_s0.sh smoke    a few cases of san / sanrec / sanpch / cur (catches harness bugs before the long run)
#   bash run_s0.sh all [cfg...]  the listed configs, default all of them (results-<config>.json, log-<config>.txt)
#   bash run_s0.sh finish   remove the image, check the live container, pack every raw file
# Start each phase with: nohup bash ~/iris-a-tests/errspike/run_s0.sh <phase> > /dev/null 2>&1 < /dev/null &
# Each phase appends to run-<phase>.log and ends with "EXIT=<code>".
set -u
PHASE="${1:-}"
BASE="$HOME/iris-a-tests/errspike"
COMMIT=42b297e9
IMG=iris-preview:errspike-builder
cd "$BASE" || exit 3
exec >>"$BASE/run-$PHASE.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
echo "== $PHASE start $(date -Is)"
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/login)  online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"; }
run_cfg() { # config [case ids]
  local cfg="$1" ids="${2:-}" t0 rc tag
  tag="$cfg"; [ -n "$ids" ] && tag="$cfg-part"
  t0=$(date +%s)
  docker run --rm --name "errspike-$cfg" --cpus 2 -m 3g --network none --security-opt no-new-privileges:true \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e REPO=/app -v "$BASE:/spike" -w /spike \
    "$IMG" node spike3.mjs "$cfg" $ids > "$BASE/log-$tag.txt" 2>&1
  rc=$?
  echo "$tag rc=$rc $(( $(date +%s) - t0 )) s: $(tail -n 1 "$BASE/log-$tag.txt")"
}
live
case "$PHASE" in
  build)
    zeros=0
    for i in $(seq 1 60); do
      n=$(ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l)
      if [ "$n" -eq 0 ]; then zeros=$((zeros + 1)); else zeros=0; fi
      [ "$zeros" -ge 2 ] && break
      sleep 60
    done
    [ "$zeros" -ge 2 ] || { echo "people stayed online for 60 minutes, nothing was built"; finish 2; }
    cd "$HOME/iris-preview" || finish 4
    if [ -n "$(git status --short)" ]; then echo "worktree ~/iris-preview is dirty:"; git status --short; finish 5; fi
    git cat-file -e "$COMMIT^{commit}" || finish 6
    git checkout -q --detach "$COMMIT" || finish 7
    echo "worktree at $(git rev-parse --short HEAD), status lines: $(git status --short | wc -l)"
    t0=$(date +%s)
    docker build -q -f Dockerfile.gdbgui --target frontend-builder -t "$IMG" . || finish 8
    echo "builder image built in $(( $(date +%s) - t0 )) s"
    ;;
  smoke)
    run_cfg san div0_input,vec_oob,stack_empty_top,assert_fail
    run_cfg sanrec ovf_fact,arr_oob_write
    run_cfg sanpch div0_input,vec_oob
    run_cfg cur div0_input,mod0_input
    ;;
  all)
    shift
    cfgs="$*"
    [ -n "$cfgs" ] || cfgs="san sanrec cur o0 plain sandebug plainpch sanpch depth fidelity"
    for cfg in $cfgs; do run_cfg "$cfg"; done
    ;;
  finish)
    docker rmi "$IMG" >/dev/null && echo "removed $IMG"
    tar czf "$BASE/s0-results-$(date +%Y%m%d-%H%M).tgz" -C "$BASE" $(cd "$BASE" && ls results-*.json log-*.txt run-*.log 2>/dev/null)
    ls -la "$BASE"/s0-results-*.tgz
    ;;
  *) echo "unknown phase '$PHASE'"; finish 9 ;;
esac
live
finish 0
