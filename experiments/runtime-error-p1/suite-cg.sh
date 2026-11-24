# Call-graph depth cap (P2 follow-up): the three affected jest files, serial, complete output
# (run_p1.sh run NAME suite-cg.sh).
set -u
cd /app
npx jest --ci --runInBand gdbgui/src/js/tests/callTree.jest.ts gdbgui/src/js/tests/ghostTree.jest.ts gdbgui/src/js/tests/CallGraphStateLabels.jest.ts > /tmp/j.txt 2>&1
echo "jest rc=$?"; grep -E "^Tests:|^Test Suites:|✕|● " /tmp/j.txt | head -40
echo "== full jest output"; cat /tmp/j.txt
