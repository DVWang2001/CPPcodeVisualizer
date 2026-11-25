#!/usr/bin/env bash
# chain4.sh: checks for the lesson narration fix and the after-view authoring rules, before the deploy.
#  1. builder image at BASE; lesson_tokens.mjs over the 9 rewritten live lessons (live_new/) with files/ mounted
#  2. Python: test image at BASE + pytest; full pytest plain (base) and with pyfiles/ mounted (change); FAILED diff
#  3. check_lesson.py over every examples/lessons bundle, base vs change
# Start: bash go.sh bash ./chain4.sh   (chain4.pid, run-chain4.log, CHAIN4-EXIT=)
cd "$(dirname "$0")" || exit 3
DIR="$(pwd)"
echo $$ > chain4.pid
exec >> run-chain4.log 2>&1
online() { ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l; }
echo "== chain4 start $(date -Is)  online: $(online)"
bash ./frontend_check.sh build; echo "build rc=$?"
IMG="iris-preview:$(basename "$DIR")-builder"
M=(); while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
ARGS=(); for f in $(cd "$DIR/live_new" && ls *.json | sort); do ARGS+=("/live_new/$f"); done
mkdir -p out && chmod 777 out
t0=$(date +%s)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" \
  -v "$DIR/lesson_tokens.mjs:/app/lesson_tokens.mjs:ro" -v "$DIR/live_new:/live_new:ro" -v "$DIR/out:/out" -w /app "$IMG" \
  node lesson_tokens.mjs /out/lesson_tokens_new.json "${ARGS[@]}" > log-tokens_new.txt 2>&1
echo "tokens rc=$? in $(( $(date +%s) - t0 )) s"; tail -2 log-tokens_new.txt
cd "$HOME/iris-preview" || exit 4
[ -z "$(git status --short)" ] || { echo "worktree dirty"; git status --short; echo "CHAIN4-EXIT=5"; exit 5; }
t0=$(date +%s)
docker build -q -f Dockerfile.gdbgui --target test -t iris-preview:pyt-base . > /dev/null; echo "test image rc=$? in $(( $(date +%s) - t0 )) s"
printf 'FROM iris-preview:pyt-base\nRUN pip install -q pytest\n' | docker build -q -t iris-preview:pyt - > /dev/null; echo "pytest image rc=$?"
cd "$DIR" || exit 3
P=(); while IFS= read -r f; do P+=(-v "$DIR/pyfiles/$f:/app/$f:ro"); done < <(cd "$DIR/pyfiles" && find . -type f | sed 's|^\./||' | sort)
echo "python mounts: $(( ${#P[@]} / 2 ))"; (cd "$DIR/pyfiles" && find . -type f | sed 's|^\./||' | sort | xargs -r sha256sum | cut -c1-12,65-)
for side in base new; do
  if [ $side = base ]; then MM=(); else MM=("${P[@]}"); fi
  t0=$(date +%s)
  docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${MM[@]}" -w /app iris-preview:pyt \
    sh -c 'python -m pytest -q -p no:cacheprovider tests 2>&1 | tail -n 400' > "log-pytest-$side.txt" 2>&1
  echo "pytest $side in $(( $(date +%s) - t0 )) s: $(grep -E '[0-9]+ (passed|failed)' "log-pytest-$side.txt" | tail -1)"
  grep -E '^FAILED' "log-pytest-$side.txt" | sed 's/ - .*//' | sort > "pytest-failed-$side.txt"
  docker run --rm --network none "${MM[@]}" -w /app --entrypoint sh iris-preview:pyt -c \
    'for f in examples/lessons/*/*.json; do echo "## $f"; python scripts/check_lesson.py "$f"; done' > "log-check-$side.txt" 2>&1
done
echo "== pytest FAILED only with the change:"; comm -13 pytest-failed-base.txt pytest-failed-new.txt
echo "== pytest FAILED only at base:"; comm -23 pytest-failed-base.txt pytest-failed-new.txt
echo "== check_lesson diff (base -> change):"; diff log-check-base.txt log-check-new.txt | head -80
echo "online: $(online)"
echo "CHAIN4-EXIT=0"
