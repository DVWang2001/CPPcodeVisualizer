# P1 full suite, complete output (run_p1.sh run NAME suite-full2.sh, or run-base for the base commit): every
# tests/engine file serially with the whole TAP stream in the log, then the whole jest suite serially.
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
grep -E "headers.tar" /tmp/assets.txt
cd /app
FILES="${SUITE_FILES:-$(ls tests/engine/*.test.mjs tests/engine/localgdb/*.test.mjs | tr '\n' ' ')}"
T0=$(date +%s)
echo "== engine files: $FILES"
node --test --test-concurrency=1 $FILES > /tmp/eng.txt 2>&1
echo "engine rc=$? $(( $(date +%s) - T0 )) s"
grep -E "^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) " /tmp/eng.txt
if [ -z "${SKIP_JEST:-}" ]; then
  T1=$(date +%s)
  npx jest --ci --runInBand > /tmp/j.txt 2>&1
  echo "jest rc=$? $(( $(date +%s) - T1 )) s"
  grep -E "^Tests:|^Test Suites:|✕" /tmp/j.txt | head -40
fi
echo "== TAP"
cat /tmp/eng.txt
