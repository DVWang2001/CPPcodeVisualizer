# P2 design data (run_p1.sh run NAME suite-p2data.sh): the example program of each first-batch error type through the
# P1 engine (runProgram, as production runs it). One "P2DATA <json>" line per program: the runtime-error records, the
# exit, stdout, and the trace steps (all of them, or the first 60 and last 40 of a long one). The P2 mock-ups take every
# value from here.
set -u
cat > /tmp/p2data.mjs <<'EOF'
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const nd = await import(pathToFileURL("/app/tests/engine/node_driver.mjs").href);
const { CASES } = await import(pathToFileURL("/app/tests/engine/runtime_errors/cases.mjs").href);
const pick = ["div0_input", "vec_oob", "stack_empty_top", "vec_empty_back", "queue_empty_front", "missing_return", "inf_recursion"];
const progs = pick.map((id) => { const c = CASES.find((x) => x.id === id); if (!c) throw new Error("no case " + id); return { id, src: c.src, stdin: c.stdin || "" }; });
for (const f of ["err_int_overflow", "err_array_oob", "err_null_deref"])
  progs.push({ id: "ex_" + f, src: fs.readFileSync("/app/examples/cpp/errors/" + f + ".cpp", "utf8"), stdin: "" });
const eng = await nd.loadNodeEngine();
const clip = (v) => { const s = JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + "…" : s; };
for (const p of progs) {
  const r = await eng.runProgram(p.src, p.stdin);
  const steps = r.steps || [];
  const idx = steps.length <= 200 ? steps.map((_, i) => i) : [...Array(60).keys(), ...Array.from({ length: 40 }, (_, k) => steps.length - 40 + k)];
  console.log("P2DATA " + JSON.stringify({
    id: p.id, src: p.src, stdin: p.stdin, ok: r.ok, keys: Object.keys(r), exit: r.exit, errors: r.errors,
    stdout: typeof r.stdout === "string" ? r.stdout.slice(0, 2000) : r.stdout, runtimeErrors: r.runtimeErrors,
    nSteps: steps.length, maxDepth: steps.reduce((m, s) => Math.max(m, s.depth || 0), 0),
    steps: idx.map((i) => ({ i, line: steps[i].line, fn: steps[i].fn, depth: steps[i].depth, frame: steps[i].frame,
      vars: Object.fromEntries(Object.entries(steps[i].vars || {}).map(([k, v]) => [k, clip(v)])), uninit: steps[i].uninit })),
  }));
}
eng.dispose();
console.log("P2DONE " + progs.length);
EOF
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
cd /app && node /tmp/p2data.mjs
