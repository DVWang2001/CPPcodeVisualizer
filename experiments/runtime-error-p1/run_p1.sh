#!/usr/bin/env bash
# IRIS runtime errors P1 on lab-david. Builds the base builder image once, then runs engine tests with the changed
# files mounted read-only over /app, so an iteration needs no image rebuild. Files to mount live under
# ~/iris-a-tests/p1/files/<repo path> (same relative path as in the repo).
#   bash run_p1.sh build                 wait for an empty classroom, build iris-preview:p1-builder from ~/iris-preview at $BASE
#   bash run_p1.sh test NAME FILE...     node --test --test-concurrency=1 FILE... with the mounted files (assets rebuilt first)
#   bash run_p1.sh run NAME SCRIPT       sh SCRIPT (a file in this directory) inside the container, with the mounted files
#   bash run_p1.sh run-base NAME SCRIPT  the same without mounting files/ (the base commit as built into the image)
#   bash run_p1.sh preview               copy files/ into ~/iris-preview, build iris-preview:p1 (runtime), restore the
#                                        worktree, run it as iris-preview-p1 on 127.0.0.1:5002 (own volume)
#   bash run_p1.sh finish                remove the image (and the preview container, volume and image)
# The container runs as root without any writable host mount; everything it prints goes to log-NAME.txt.
# Start: nohup bash ~/iris-a-tests/p1/run_p1.sh <phase> [...] > /dev/null 2>&1 < /dev/null &
# Each phase writes <tag>.pid first, appends to run-<tag>.log and ends with EXIT=<code> (tag = build | test-NAME | finish).
set -u
PHASE="${1:-}"; shift || true
DIR="$HOME/iris-a-tests/p1"
BASE=42b297e9
IMG=iris-preview:p1-builder
cd "$DIR" || exit 3
TAG="$PHASE"; case "$PHASE" in test|run|run-base) TAG="$PHASE-${1:-x}" ;; esac
echo $$ > "$DIR/$TAG.pid"
exec >>"$DIR/run-$TAG.log" 2>&1
finish() { echo "EXIT=$1"; exit "$1"; }
live() { echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/login)  online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"; }
# the user's rule: start only after two zero-connection readings in a row ($1 s apart), at most 60 minutes
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
echo "== $TAG start $(date -Is)"
live
RC=0
case "$PHASE" in
  build)
    wait_empty 60 || { echo "people stayed online for 60 minutes, nothing was built"; finish 2; }
    cd "$HOME/iris-preview" || finish 4
    if [ -n "$(git status --short)" ]; then echo "worktree ~/iris-preview is dirty:"; git status --short; finish 5; fi
    [ "$(git rev-parse --short HEAD)" = "$BASE" ] || { echo "worktree is at $(git rev-parse --short HEAD), not $BASE"; finish 6; }
    t0=$(date +%s)
    docker build -q -f Dockerfile.gdbgui --target frontend-builder -t "$IMG" . || finish 8
    echo "built $IMG in $(( $(date +%s) - t0 )) s"
    ;;
  test|run|run-base)
    NAME="$1"; shift
    wait_empty 20 || { echo "people stayed online for 60 minutes, nothing was run"; finish 2; }
    docker image inspect "$IMG" > /dev/null 2>&1 || { echo "image $IMG is missing"; finish 4; }
    mounts=()
    if [ "$PHASE" != run-base ] && [ -d "$DIR/files" ]; then
      while IFS= read -r f; do mounts+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
      echo "mounted $(( ${#mounts[@]} / 2 )) files:"
      (cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort | xargs -r sha256sum | cut -c1-12,65-)
    fi
    if [ "$PHASE" != test ]; then
      [ -f "$DIR/$1" ] || { echo "no script $DIR/$1"; finish 7; }
      echo "script $1 $(sha256sum "$DIR/$1" | cut -c1-12)"
      mounts+=(-v "$DIR/$1:/p1/run.sh:ro"); set -- sh /p1/run.sh
    else
      set -- sh -c 'cd gdbgui/static/engine && node scripts/build-assets.mjs > /dev/null && cd /app && node --test --test-concurrency=1 "$@"' sh "$@"
    fi
    t0=$(date +%s)
    docker run --rm --name "p1-$NAME" --cpus 2 -m 3g --network none --security-opt no-new-privileges:true \
      "${mounts[@]}" -w /app "$IMG" "$@" > "$DIR/log-$NAME.txt" 2>&1
    RC=$?
    echo "$PHASE $NAME rc=$RC $(( $(date +%s) - t0 )) s: $(grep -E '^# (tests|pass|fail|cancelled)|^Tests:' "$DIR/log-$NAME.txt" | tr '\n' ' ')"
    ;;
  preview)
    wait_empty 60 || { echo "people stayed online for 60 minutes, nothing was built"; finish 2; }
    cd "$HOME/iris-preview" || finish 4
    if [ -n "$(git status --short)" ]; then echo "worktree ~/iris-preview is dirty:"; git status --short; finish 5; fi
    [ "$(git rev-parse --short HEAD)" = "$BASE" ] || { echo "worktree is at $(git rev-parse --short HEAD), not $BASE"; finish 6; }
    (cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort) > "$DIR/preview-files.txt"
    while IFS= read -r f; do mkdir -p "$(dirname "$f")"; cp "$DIR/files/$f" "$f"; done < "$DIR/preview-files.txt"
    echo "worktree now differs in $(git status --short --untracked-files=all | wc -l) paths (copied $(wc -l < "$DIR/preview-files.txt") files)"
    restore() {
      git checkout -- .
      while IFS= read -r f; do git ls-files --error-unmatch "$f" > /dev/null 2>&1 || rm -f "$f"; done < "$DIR/preview-files.txt"
      find gdbgui/static/engine/include tests -type d -empty -delete
      echo "worktree restored: $(git status --short --untracked-files=all | wc -l) changed paths"
    }
    t0=$(date +%s)
    docker build -q -f Dockerfile.gdbgui --target runtime -t iris-preview:p1 . || { restore; finish 8; }
    echo "built iris-preview:p1 in $(( $(date +%s) - t0 )) s"
    restore
    docker rm -f iris-preview-p1 > /dev/null 2>&1; docker volume rm iris-preview-p1-data > /dev/null 2>&1
    docker run -d --name iris-preview-p1 --init --security-opt no-new-privileges:true --cpus 1 -m 600m \
      -p 127.0.0.1:5002:5000 -v iris-preview-p1-data:/var/lib/gdbgui \
      -e PYTHONUNBUFFERED=1 -e PYTHONDONTWRITEBYTECODE=1 -e GDBGUI_REQUIRE_ISOLATION=1 \
      -e MOBILE_JOIN_BASE_URL=http://120.125.77.193:5002 iris-preview:p1 > /dev/null || finish 9
    for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5002/login)" = 200 ] && break; sleep 1; done
    echo "preview /login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5002/login)"
    ;;
  finish)
    docker rm -f iris-preview-p1 > /dev/null 2>&1 && echo "removed container iris-preview-p1"
    docker volume rm iris-preview-p1-data > /dev/null 2>&1 && echo "removed volume iris-preview-p1-data"
    docker rmi iris-preview:p1 > /dev/null 2>&1 && echo "removed iris-preview:p1"
    docker rmi "$IMG" > /dev/null && echo "removed $IMG"
    ;;
  *) echo "unknown phase '$PHASE'"; finish 9 ;;
esac
live
finish "$RC"
