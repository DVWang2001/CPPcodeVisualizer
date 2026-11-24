# P2 jest subset (run_p1.sh run NAME suite-p2jest.sh): the runtime-error picture tests, the P1 stop test and the
# sidebar (the runtime-error panel stays open in edit mode), serial,
# complete output. RED/GREEN cycles use this; the verdict is suite-jestall.sh.
set -u
cd /app
npx jest --ci --runInBand gdbgui/src/js/tests/runtimeDiag.jest.ts gdbgui/src/js/tests/RuntimeErrorView.jest.ts \
  gdbgui/src/js/tests/runtimeErrorState.jest.ts gdbgui/src/js/tests/runtimeErrorStop.jest.ts \
  gdbgui/src/js/tests/RightSidebar.jest.ts > /tmp/j.txt 2>&1
echo "jest rc=$?"; grep -E "^Tests:|^Test Suites:" /tmp/j.txt
echo "== full jest output"; cat /tmp/j.txt
