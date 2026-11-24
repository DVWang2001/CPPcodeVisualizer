# P1 diagnostic: every lesson and E3 program through runProgram with the P1 files (run_p1.sh run NAME suite-diag.sh).
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
cd /app
T0=$(date +%s)
node experiments/runtime-error-p1/p1_diag.mjs 2> /tmp/diag.err
echo "rc=$? $(( $(date +%s) - T0 )) s"
tail -n 20 /tmp/diag.err
