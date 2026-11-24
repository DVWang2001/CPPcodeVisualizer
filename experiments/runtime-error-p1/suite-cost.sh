# P1 compile-cost measurement inside iris-preview:p1-builder (run_p1.sh run NAME suite-cost.sh), with the P1 files and
# experiments/runtime-error-p1/p1_cost.mjs mounted. Nothing else may run on lab-david meanwhile (timed).
set -u
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
cd /app
T0=$(date +%s)
node experiments/runtime-error-p1/p1_cost.mjs 2> /tmp/cost.err > /tmp/cost.json
echo "rc=$? $(( $(date +%s) - T0 )) s"
tail -n 40 /tmp/cost.err
echo "== JSON"
cat /tmp/cost.json
