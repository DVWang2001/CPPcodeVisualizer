# P1 full GREEN suite inside iris-preview:p1-builder (run_p1.sh run NAME suite-full.sh): every tests/engine file
# (including the new runtime-error corpus) serially, then the whole jest suite serially.
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
grep -E "headers.tar" /tmp/assets.txt
cd /app
T0=$(date +%s)
echo "== engine: all tests/engine files (serial)"
node --test --test-concurrency=1 tests/engine/*.test.mjs tests/engine/localgdb/*.test.mjs > /tmp/eng.txt 2>&1
echo "rc=$? $(( $(date +%s) - T0 )) s"
grep -E "^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) " /tmp/eng.txt
echo "-- not ok:"; grep -nE "not ok " /tmp/eng.txt | head -60
echo "-- corpus:"; grep -E "^# [a-z0-9_]+: (exit|trap|stack|step|fail)" /tmp/eng.txt | head -60
echo "-- details:"; grep -E "^ *(error|expected|actual|failureType|location): " /tmp/eng.txt | head -120
T1=$(date +%s)
echo "== jest (serial)"
npx jest --ci --runInBand > /tmp/j.txt 2>&1
echo "rc=$? $(( $(date +%s) - T1 )) s"
grep -E "^Tests:|^Test Suites:|✕|● " /tmp/j.txt | head -60
