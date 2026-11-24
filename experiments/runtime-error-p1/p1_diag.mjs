// P1 diagnostic, run ONLY on lab-david inside iris-preview:p1-builder with the P1 files mounted (run_p1.sh run NAME
// suite-diag.sh): every lesson bundle (examples/**/*.json with source_code, its program_input) and every E3 case through
// runProgram, as production runs them (PCH, budgets). Prints one JSON line per program: ok/errors, exit, steps, the
// runtime errors (kind, fatal, file, line, col, step line, message) and the compile time. Lessons whose behaviour P1
// changes are the ones with runtime errors.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const REPO = "/app";
const nd = await import(pathToFileURL(REPO + "/tests/engine/node_driver.mjs").href);
const { e3Cases } = await import(pathToFileURL(REPO + "/tests/engine/e3_cases.mjs").href);
const corpus = [], seen = new Set();
const add = (id, src, stdin) => {
  const k = crypto.createHash("sha256").update(src + "\0" + stdin).digest("hex");
  if (!seen.has(k)) { seen.add(k); corpus.push({ id, src, stdin }); }
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of walk(REPO + "/examples").filter((f) => f.endsWith(".json")).sort()) {
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (typeof j.source_code === "string" && j.source_code.trim()) add(path.relative(REPO, f), j.source_code, j.program_input || "");
  } catch { /* not a lesson */ }
}
for (const c of e3Cases()) add("e3-" + c.id + " " + c.name, c.source, c.stdin || "");
const eng = await nd.loadNodeEngine();
let n = 0;
for (const c of corpus) {
  const t0 = performance.now();
  const r = await eng.runProgram(c.src, c.stdin);
  const errs = (r.runtimeErrors || []).map((e) => ({ kind: e.kind, fatal: e.fatal, file: e.file, line: e.line, col: e.col, inUser: e.inUser, step: e.step,
    stepLine: e.step >= 0 && r.steps[e.step] ? r.steps[e.step].line : null, message: e.message }));
  console.log(JSON.stringify({ i: n++, id: c.id, ok: r.ok, errors: (r.errors || []).map((e) => e.kind), exit: r.exit, steps: r.steps.length,
    compileMs: Math.round(r.timings.compile || 0), ms: Math.round(performance.now() - t0), runtimeErrors: errs }));
}
eng.dispose();
console.log(JSON.stringify({ done: n }));
