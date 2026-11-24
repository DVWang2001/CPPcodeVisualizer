# The whole jest suite, serial, complete output (run_p1.sh run NAME suite-jestall.sh).
set -u
cd /app
npx jest --ci --runInBand > /tmp/j.txt 2>&1
echo "jest rc=$?"; grep -E "^Tests:|^Test Suites:|✕|● " /tmp/j.txt | head -40
echo "== full jest output"; cat /tmp/j.txt
