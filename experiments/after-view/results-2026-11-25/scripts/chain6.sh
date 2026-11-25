#!/usr/bin/env bash
# chain6.sh: the three tutorial bundles whose narration changed (c4, l2, t2) under the after-view engine,
# and gen_tutorial.py regenerating exactly the files under test.  Start: bash go.sh bash ./chain6.sh
cd "$(dirname "$0")" || exit 3
DIR="$(pwd)"
echo $$ > chain6.pid
exec >> run-chain6.log 2>&1
echo "== chain6 start $(date -Is)  online: $(ss -Htn state established "( sport = :443 or sport = :5000 )" | wc -l)  live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)"
IMG="iris-preview:$(basename "$DIR")-builder"
M=(); while IFS= read -r f; do M+=(-v "$DIR/files/$f:/app/$f:ro"); done < <(cd "$DIR/files" && find . -type f | sed 's|^\./||' | sort)
P=(); while IFS= read -r f; do P+=(-v "$DIR/pyfiles3/$f:/app/$f:ro"); done < <(cd "$DIR/pyfiles3" && find . -type f | sed 's|^\./||' | sort)
(cd "$DIR/pyfiles3" && find . -type f | sed 's|^\./||' | sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -c1-12)" "$f"; done)
docker run --rm --cpus 2 -m 3g --network none --security-opt no-new-privileges:true "${M[@]}" \
  -v "$DIR/pyfiles3/gdbgui/static/tutorial:/tut:ro" -v "$DIR/lesson_tokens.mjs:/app/lesson_tokens.mjs:ro" -v "$DIR/out:/out" -w /app "$IMG" \
  node lesson_tokens.mjs /out/lesson_tokens_tut3.json /tut/tutorial_c4.json /tut/tutorial_l2.json /tut/tutorial_t2.json > log-tokens_tut3.txt 2>&1
echo "tokens rc=$?"; tail -1 log-tokens_tut3.txt
docker run --rm --network none "${P[@]}" -w /app --entrypoint sh iris-preview:pyt -c \
  'python scripts/gen_tutorial.py /tmp/tut > /tmp/gen.log 2>&1; echo "gen rc=$? $(tail -1 /tmp/gen.log)"; diff -r /tmp/tut gdbgui/static/tutorial > /tmp/d.txt; echo "diff rc=$? lines=$(wc -l < /tmp/d.txt)"; head -20 /tmp/d.txt'
echo "CHAIN6-EXIT=0"
