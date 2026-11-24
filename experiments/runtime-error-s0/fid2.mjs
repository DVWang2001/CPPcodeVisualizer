// IRIS runtime-error S0, follow-up of the fidelity run (2026-11-23). Run ONLY on lab-david (run_fid2.sh).
//   node fid2.mjs
// Part "diag": CC-2607A/B timed out without checks and stopped with a null-reference report with checks.
//   Keeps the instrumented source, runs the production path (engine.runProgram), plain with a 60 s limit, and san
//   with the report extended by the file name (in memory only; vgerr.h itself is unchanged).
// Part "cmp": every program whose plain and san traces differed in results-fidelity.json without an error report.
//   Compares the WHOLE traces. Skeleton = every step field except vars, plus the variable names. Value differences
//   are classified: "uninit" = the variable is in that step's uninit list; "layout" = the same value also changes in
//   a layout-only control (plain + a 4 KB global appended after instrumentation, so no line moves); "other" = kept
//   in full for review.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || "/app";
const ENGINE = REPO + "/gdbgui/static/engine";
const BOOT = REPO + "/tests/engine/node_worker_bootstrap.mjs";
const nd = await import(pathToFileURL(REPO + "/tests/engine/node_driver.mjs").href);
const { Driver } = await import(pathToFileURL(ENGINE + "/driver.js").href);
const { instrument } = await import(pathToFileURL(ENGINE + "/instrument.js").href);
const { decodeTrace } = await import(pathToFileURL(ENGINE + "/trace.js").href);
const { LINK_FLAGS } = await import(pathToFileURL(ENGINE + "/pipeline.worker.js").href);

const VGERR = fs.readFileSync(path.join(HERE, "vgerr.h"), "utf8");
const ASSERT_H = fs.readFileSync(path.join(HERE, "assertion_handler.h"), "utf8");
const V1 = VGERR.replace('\\"vgerr\\":\\"%s\\",\\"line\\":%u', '\\"vgerr\\":\\"%s\\",\\"file\\":\\"%s\\",\\"line\\":%u');
const VGERR_FILE = V1.replace(/kind,(\s*)l \? \(unsigned\)l->line/, 'kind, l && l->file ? l->file : "?",$1l ? (unsigned)l->line');
if (V1 === VGERR || VGERR_FILE === V1) throw new Error("vgerr.h file-name patch did not apply");
const UB = ["-fsanitize=undefined", "-fno-sanitize=vptr,function"];
const SAN = [...UB, "-fno-sanitize-recover=all", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE"];
const sanFiles = (vg) => ({ "vgerr.h": vg, "include/c++/v1/__assertion_handler": ASSERT_H });
const PAD = '\nextern "C" { __attribute__((used)) volatile char __vg_layout_pad[4096] = {1}; }\n';

const short = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
const vgerrsOf = (stderr) => [...(stderr || "").matchAll(/\{"vgerr".*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return { raw: m[0] }; } });
const slim = (s) => ({ line: s.line, fn: s.fn, depth: s.depth, vars: short(JSON.stringify(s.vars), 300), uninit: s.uninit });

function execInWorker(module, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const w = new Worker(BOOT, { workerData: { url: pathToFileURL(ENGINE + "/exec.worker.js").href } });
    const empty = { stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0) };
    const t = setTimeout(() => { w.terminate(); resolve({ exit: { reason: "timeout" }, ...empty }); }, timeoutMs);
    w.on("message", (m) => { if (m && m.type === "exec-result") { clearTimeout(t); w.terminate(); resolve(m); } });
    w.on("error", (e) => { clearTimeout(t); w.terminate(); resolve({ exit: { reason: "worker-error", message: String(e) }, ...empty }); });
    w.postMessage({ module, stdin });
  });
}

/** same build as spike3.mjs (no PCH, -O1); opts: { san, vgerr, append } */
async function build(d, src, opts) {
  const base = ["-std=c++17", "-fno-exceptions", "-O1"];
  let ins;
  try { ins = await instrument(d, src, { flags: [...base, "-include", "vg.h"], files: {} }); }
  catch (e) { return { fail: "instrument-throw", log: short(String(e.message || e), 300) }; }
  if (!ins.ok) return { fail: "instrument", log: short(ins.log, 600) };
  const files = opts.san ? sanFiles(opts.vgerr || VGERR) : {};
  const flags = [...base, ...(opts.san ? SAN : []), "-include", "vg.h"];
  if (opts.san) flags.push("-include", "/vgerr.h");
  flags.push(...LINK_FLAGS);
  const cl = await d.compileLink(ins.text + (opts.append || ""), { flags, files });
  if (!cl.ok) return { fail: cl.stage, log: short(cl.log, 2500) };
  return { module: await WebAssembly.compile(cl.wasm), meta: ins.meta, text: ins.text };
}

async function run(b, stdin, timeoutMs) {
  const t0 = performance.now();
  const x = await execInWorker(b.module, stdin, timeoutMs);
  const ms = Math.round(performance.now() - t0);
  const td = new TextDecoder();
  let steps = [], errors = [];
  if (x.trace && x.trace.length) { const dd = decodeTrace(x.trace, b.meta, { stamps: x.stamps || null }); steps = dd.steps; errors = dd.errors; if (dd.limit) x.exit = { reason: "step-limit" }; }
  return { exit: x.exit, steps, errors, stdout: td.decode(x.stdout), stderr: td.decode(x.stderr), ms, traceBytes: x.trace ? x.trace.length : 0 };
}

const flat = (v, p, acc) => {
  if (v && typeof v === "object" && Object.keys(v).length) for (const [k, x] of Object.entries(v)) flat(x, p + "." + k, acc);
  else acc.set(p, JSON.stringify(v));
  return acc;
};
function cmpTraces(A, B) {
  let skelDiffAt = -1, skel = null;
  const vals = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const a = A[i], b = B[i];
    if (!a || !b) { skelDiffAt = i; skel = { a: a ? "step" : "none", b: b ? "step" : "none" }; break; }
    const { vars: va, ...ra } = a, { vars: vb, ...rb } = b;
    const sa = JSON.stringify([ra, Object.keys(va || {})]), sb = JSON.stringify([rb, Object.keys(vb || {})]);
    if (sa !== sb) { skelDiffAt = i; skel = { a: short(sa, 300), b: short(sb, 300) }; break; }
    const fa = flat(va || {}, "", new Map()), fb = flat(vb || {}, "", new Map());
    for (const k of new Set([...fa.keys(), ...fb.keys()])) if (fa.get(k) !== fb.get(k)) vals.push({ i, k, a: fa.get(k), b: fb.get(k) });
  }
  return { skelDiffAt, skel, vals };
}

// corpus, exactly as spike3.mjs "fidelity"
const crypto = await import("node:crypto");
const { e3Cases } = await import(pathToFileURL(REPO + "/tests/engine/e3_cases.mjs").href);
const corpus = new Map(), seen = new Set();
const add = (id, src, stdin) => { const k = crypto.createHash("sha256").update(src + "\0" + stdin).digest("hex"); if (!seen.has(k)) { seen.add(k); corpus.set(id, { id, src, stdin }); } };
for (const c of e3Cases()) add("e3-" + c.id + " " + c.name, c.source, c.stdin || "");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const f of walk(REPO + "/examples").filter((f) => f.endsWith(".json")).sort()) {
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (typeof j.source_code === "string" && j.source_code.trim()) add(path.relative(REPO, f), j.source_code, j.program_input ? j.program_input + "\n" : ""); } catch { /* not a lesson */ }
}
const fid = JSON.parse(fs.readFileSync(path.join(HERE, "results-fidelity.json"), "utf8")).rows;
const DIAG = ["examples/lessons/UML物件圖_CC系列/CC-2607A.json", "examples/lessons/UML物件圖_CC系列/CC-2607B.json"];
const CMP = fid.filter((r) => !r.skip && !r.fail && !r.sameSteps && !(r.vgerr && r.vgerr.length)).map((r) => r.id);
const out = { meta: { started: new Date().toISOString(), repo: REPO, node: process.version, corpus: corpus.size, cmp: CMP.length }, diag: [], cmp: [] };
console.error("corpus", corpus.size, "cmp", CMP.length);

const d = new Driver(await nd.createNodeEnv().loadAssets());
const eng = await nd.loadNodeEngine();
for (const id of DIAG) {
  const c = corpus.get(id);
  if (!c) { out.diag.push({ id, missing: true }); continue; }
  const row = { id };
  const t0 = performance.now();
  const r = await eng.runProgram(c.src, c.stdin, {});
  row.cur = { ms: Math.round(performance.now() - t0), exit: r.exit, errors: (r.errors || []).map((e) => ({ kind: e.kind, msg: short(e.message, 200) })),
    steps: (r.steps || []).length, stdout: short(r.stdout, 300), first: (r.steps || []).slice(0, 4).map(slim), last: (r.steps || []).slice(-2).map(slim) };
  const b0 = await build(d, c.src, {});
  if (b0.module) {
    const lines = b0.text.split("\n");
    row.instrumentedLines = lines.length;
    row.instrumented45to56 = lines.slice(44, 56).map((l, i) => `${45 + i}: ${short(l, 400)}`);
    fs.writeFileSync(path.join(HERE, `diag-${path.basename(id, ".json")}.cpp`), b0.text);
    const r0 = await run(b0, c.stdin, 60000);
    row.plain60 = { ms: r0.ms, exit: r0.exit, steps: r0.steps.length, traceBytes: r0.traceBytes, errors: r0.errors.map((e) => ({ kind: e.kind, msg: short(e.message, 200) })), stdout: short(r0.stdout, 300), first: r0.steps.slice(0, 4).map(slim) };
  } else row.plainBuild = { fail: b0.fail, log: b0.log };
  const b1 = await build(d, c.src, { san: true, vgerr: VGERR_FILE });
  if (b1.module) {
    const r1 = await run(b1, c.stdin, 20000);
    row.san = { ms: r1.ms, exit: r1.exit, steps: r1.steps.length, vgerr: vgerrsOf(r1.stderr), first: r1.steps.slice(0, 4).map(slim) };
  } else row.sanBuild = { fail: b1.fail, log: b1.log };
  out.diag.push(row);
  console.error("diag", id, JSON.stringify({ cur: row.cur.exit, curSteps: row.cur.steps, plain60: row.plain60 && row.plain60.exit, san: row.san && row.san.vgerr }));
}
eng.dispose();

for (const id of CMP) {
  const c = corpus.get(id);
  if (!c) { out.cmp.push({ id, missing: true }); continue; }
  const b0 = await build(d, c.src, {}), b1 = await build(d, c.src, { san: true }), b2 = await build(d, c.src, { append: PAD });
  if (!b0.module || !b1.module || !b2.module) { out.cmp.push({ id, buildFail: [b0.fail, b1.fail, b2.fail] }); console.error(id, "BUILD FAILED"); continue; }
  const r0 = await run(b0, c.stdin, 20000), r1 = await run(b1, c.stdin, 20000), r2 = await run(b2, c.stdin, 20000);
  const s = cmpTraces(r0.steps, r1.steps), p = cmpTraces(r0.steps, r2.steps);
  const padKeys = new Set(p.vals.map((v) => v.i + "|" + v.k));
  const cls = { uninit: [], layout: [], other: [] };
  for (const v of s.vals) {
    const top = v.k.split(".")[1];
    const e = { ...v, line: r0.steps[v.i].line, fn: r0.steps[v.i].fn };
    if ((r0.steps[v.i].uninit || []).includes(top)) cls.uninit.push(e);
    else if (padKeys.has(v.i + "|" + v.k)) cls.layout.push(e);
    else cls.other.push(e);
  }
  out.cmp.push({
    id, steps: [r0.steps.length, r1.steps.length, r2.steps.length], exit: [r0.exit, r1.exit, r2.exit],
    stdoutSame: r0.stdout === r1.stdout, stdoutSamePad: r0.stdout === r2.stdout, vgerr: vgerrsOf(r1.stderr),
    skelDiffAt: s.skelDiffAt, skel: s.skel, skelDiffAtPad: p.skelDiffAt,
    nDiff: s.vals.length, nDiffPad: p.vals.length, nUninit: cls.uninit.length, nLayout: cls.layout.length, nOther: cls.other.length,
    exUninit: cls.uninit.slice(0, 3), exLayout: cls.layout.slice(0, 3), other: cls.other.slice(0, 200),
  });
  console.error(id, JSON.stringify({ skel: s.skelDiffAt, n: s.vals.length, uninit: cls.uninit.length, layout: cls.layout.length, other: cls.other.length }));
}
out.meta.finished = new Date().toISOString();
fs.writeFileSync(path.join(HERE, "results-fid2.json"), JSON.stringify(out, null, 1));
console.log("wrote results-fid2.json diag", out.diag.length, "cmp", out.cmp.length);
