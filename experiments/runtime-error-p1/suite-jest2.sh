# Quick check after the warm-up state attribute: the warm-up tests (Node) and the localEngine jest files.
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
cd /app
node --test --test-concurrency=1 tests/engine/warmup.test.mjs > /tmp/w.txt 2>&1
echo "warmup rc=$?"; grep -E "^(ok|not ok) |^# (tests|pass|fail)|warm |warmUp:|Run after" /tmp/w.txt
npx jest --ci --runInBand gdbgui/src/js/tests/localEnginePrewarm.jest.ts gdbgui/src/js/tests/localEngine.jest.ts gdbgui/src/js/tests/localEngineWiring.jest.ts gdbgui/src/js/tests/runtimeErrorStop.jest.ts > /tmp/j.txt 2>&1
echo "jest rc=$?"; grep -E "Tests:|Test Suites:|✕|●" /tmp/j.txt | head -40
echo "== full jest output"; cat /tmp/j.txt
