#!/usr/bin/env bash
# chain5.sh: last checks before the after-view deploy (no frontend or engine file changed since chain/chain3).
#  1. lesson_tokens (after-view engine: files/ mounted) over the tutorial bundles (~/iris-preview at BASE, unchanged)
#     and the 7 edited repo lessons (pyfiles2/)
#  2. pytest with pyfiles2/ mounted vs chain4's base list; check_lesson over examples/lessons vs chain4's base log
#  3. scripts/gen_tutorial.py regenerated into /tmp vs gdbgui/static/tutorial, base and change
# Start: bash go.sh bash ./chain5.sh   (chain5.pid, run-chain5.log, CHAIN5-EXIT=)
cd "$(dirname "$0")" || exit 3
DIR="$(pwd)"
echo $$ > chain5.pid
exec >> run-chain5.log 2>&1
online() { ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l; }
echo "== chain5 start $(date -Is)  online: $(online)  live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)"
IMG="iris-preview:$(basename "$DIR")-builder"
for i in "$IMG" iris-preview:pyt; do docker image inspect "$i" > /dev/null 2>&1 || { echo "missing image $i"; echo "CHAIN5-EXIT=4"; exit 4; }; done
[ -z "$(git -C "$HOME/iris-preview" status --short)" ] || { echo "worktree dirty"; echo "CHAIN5-EXIT=5"; exit 5; }
echo "worktree at $(git -C "$HOME/iris-preview" rev-parse --short HEAD)"
M=(); while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
P=(); while IFS= read -r f; do P+=(-v "$DIR/pyfiles2/$f:/app/$f:ro"); done < <(cd "$DIR/pyfiles2" && find . -type f | sed 's|^\./||' | sort)
L=(); ARGS=()
while IFS= read -r f; do L+=(-v "$DIR/pyfiles2/$f:/app/$f:ro"); ARGS+=("/app/$f"); done < <(cd "$DIR/pyfiles2" && find examples/lessons -name '*.json' | sort)
while IFS= read -r f; do ARGS+=("/tut/$f"); done < <(cd "$HOME/iris-preview/gdbgui/static/tutorial" && ls tutorial_*.json | sort)
echo "engine mounts: $(( ${#M[@]} / 2 ))  python/lesson mounts: $(( ${#P[@]} / 2 ))  token bundles: ${#ARGS[@]}"
(cd "$DIR/pyfiles2" && find . -type f | sed 's|^\./||' | sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -c1-12)" "$f"; done)
mkdir -p out && chmod 777 out
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" "${L[@]}" \
  -v "$HOME/iris-preview/gdbgui/static/tutorial:/tut:ro" -v "$DIR/lesson_tokens.mjs:/app/lesson_tokens.mjs:ro" -v "$DIR/out:/out" -w /app "$IMG" \
  node lesson_tokens.mjs /out/lesson_tokens_tutorial.json "${ARGS[@]}" > log-tokens_tutorial.txt 2>&1
echo "tokens rc=$? in $(( $(date +%s) - t0 )) s"; tail -2 log-tokens_tutorial.txt
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${P[@]}" -w /app iris-preview:pyt \
  sh -c 'python -m pytest -q -p no:cacheprovider tests 2>&1 | tail -n 400' > log-pytest5-new.txt 2>&1
echo "pytest new in $(( $(date +%s) - t0 )) s: $(grep -E '[0-9]+ (passed|failed)' log-pytest5-new.txt | tail -1)"
echo "pytest base (chain4, same image): $(grep -E '[0-9]+ (passed|failed)' log-pytest-base.txt | tail -1)"
grep -E '^FAILED' log-pytest5-new.txt | sed 's/ - .*//' | sort > pytest5-failed-new.txt
echo "== pytest FAILED only with the change:"; comm -13 pytest-failed-base.txt pytest5-failed-new.txt
echo "== pytest FAILED only at base:"; comm -23 pytest-failed-base.txt pytest5-failed-new.txt
docker run --rm --network none "${P[@]}" -w /app --entrypoint sh iris-preview:pyt -c \
  'for f in examples/lessons/*/*.json; do echo "## $f"; python scripts/check_lesson.py "$f"; done' > log-check5-new.txt 2>&1
echo "check_lesson base log: $(grep -c '^## ' log-check-base.txt) bundles, $(grep -c '靜態檢查通過' log-check-base.txt) passed, $(grep -c '個問題' log-check-base.txt) with problems"
echo "check_lesson new log:  $(grep -c '^## ' log-check5-new.txt) bundles, $(grep -c '靜態檢查通過' log-check5-new.txt) passed, $(grep -c '個問題' log-check5-new.txt) with problems"
echo "== check_lesson diff (base -> change):"; diff log-check-base.txt log-check5-new.txt | head -80
for side in base new; do
  if [ $side = base ]; then MM=(); else MM=("${P[@]}"); fi
  docker run --rm --network none "${MM[@]}" -w /app --entrypoint sh iris-preview:pyt -c \
    'python scripts/gen_tutorial.py /tmp/tut > /tmp/gen.log 2>&1; echo "gen rc=$? $(tail -1 /tmp/gen.log)"; diff -r /tmp/tut gdbgui/static/tutorial > /tmp/d.txt; echo "diff rc=$? lines=$(wc -l < /tmp/d.txt)"; head -20 /tmp/d.txt' > "log-gentut-$side.txt" 2>&1
  echo "gen_tutorial $side: $(head -2 "log-gentut-$side.txt" | tr '\n' ' ')"
done
echo "online: $(online)  live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)"
echo "CHAIN5-EXIT=0"
