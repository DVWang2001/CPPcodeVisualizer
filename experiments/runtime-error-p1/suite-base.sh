# Base comparison (run_p1.sh run-base NAME suite-base.sh): the test files that failed with the P1 files, on the base
# commit exactly as built into iris-preview:p1-builder (no files mounted, assets as built). Whole TAP in the log.
set -u
cd /app
FILES="tests/engine/e3.test.mjs tests/engine/golden.test.mjs tests/engine/wasi_oracle.test.mjs tests/engine/compile_support.test.mjs tests/engine/differential.test.mjs tests/engine/localgdb/commands.test.mjs tests/engine/localgdb/containers.test.mjs tests/engine/localgdb/pointers.test.mjs tests/engine/localgdb/addresses.test.mjs tests/engine/localgdb/lessons_corpus.test.mjs tests/engine/localgdb/replay.test.mjs"
T0=$(date +%s)
node --test --test-concurrency=1 $FILES > /tmp/eng.txt 2>&1
echo "engine rc=$? $(( $(date +%s) - T0 )) s"
grep -E "^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) " /tmp/eng.txt
echo "== TAP"
cat /tmp/eng.txt
