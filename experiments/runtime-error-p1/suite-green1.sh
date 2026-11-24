# P1 quick GREEN suite inside iris-preview:p1-builder (run by run_p1.sh run NAME <this file>).
# Usage of $SUITE_CORPUS: a --test-name-pattern for the corpus test, or "all".
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
grep -E "headers.tar" /tmp/assets.txt
cd /app
echo "== node: trace unit + localgdb"
node --test --test-concurrency=1 tests/engine/runtime_errors_trace.test.mjs tests/engine/localgdb/runtime_errors.test.mjs > /tmp/n1.txt 2>&1
echo "rc=$?"; grep -E "^(not ok|ok) |^# (tests|pass|fail)" /tmp/n1.txt; grep -E "^ *(error|expected|actual|code|name): " /tmp/n1.txt | head -n 60
echo "== node: corpus"
node --test --test-concurrency=1 --test-name-pattern='div0_input|ovf_add|vec_oob|intmin_div|missing_return|assert_fail|stoi_bad|inf_recursion|ex_err_array_oob|48 programs|without the runtime checks' tests/engine/runtime_errors.test.mjs > /tmp/n2.txt 2>&1
echo "rc=$?"; grep -E "^(not ok|ok) |^# (tests|pass|fail)|^# [a-z0-9_]+: " /tmp/n2.txt; grep -E "^ *(error|expected|actual|code): " /tmp/n2.txt | head -n 30
echo "== jest"
npx jest --ci --runInBand gdbgui/src/js/tests/runtimeErrorStop.jest.ts gdbgui/src/js/tests/localEngine.jest.ts > /tmp/j.txt 2>&1
echo "rc=$?"; grep -E "✓|✕|Tests:|Test Suites:|●" /tmp/j.txt | head -n 80
