# The annotation-globals jest test alone (run_p1.sh run NAME suite-annot.sh), complete output.
set -u
cd /app
npx jest --ci --runInBand gdbgui/src/js/tests/annotationGlobals.jest.ts > /tmp/j.txt 2>&1
echo "jest rc=$?"; grep -E "^Tests:|^Test Suites:|✓|✕" /tmp/j.txt | head -20
echo "== full jest output"; cat /tmp/j.txt
