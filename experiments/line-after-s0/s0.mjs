// S0 experiment (line-after plan, docs/superpowers/plans/2026-11-05-line-after-result-plan.md).
// Measures, without changing any product file:
//   E1  probe placement: is a step's state the state BEFORE its line runs?
//   E2  stdout attribution: which trace record is stdout written after (cout buffering, flush, endl)?
//   E4  loop attribution
//   D   per-record stamping overhead and stop/limit counts on the existing lesson bundles
// Method: runProgram(returnWasm) gives the linked module; we re-instantiate it with the engine's own
// createWasi() and wrap fd_write so that each fd-3 (trace) write records how many stdout bytes exist
// at that moment. Sanity checks: our stdout equals the engine's stdout; stamp count equals trace records.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../../gdbgui/static/engine/index.js";
import { createWasi } from "../../gdbgui/static/engine/exec.worker.js";
import { createNodeEnv } from "../../tests/engine/node_driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_EXAMPLES = path.join(HERE, "..", "..", "examples", "cpp");
const dec = new TextDecoder();

/** Run an already-linked module; optionally stamp stdout length at each trace (fd 3) write. */
async function runModule(module, stdin, wrap) {
  const wasi = createWasi({ stdin });
  const fns = { ...wasi.imports.wasi_snapshot_preview1 };
  const stamps = [];
  if (wrap) {
    const orig = fns.fd_write;
    fns.fd_write = (fd, iovs, n, p) => {
      if (fd === 3) stamps.push(wasi.sinks[1].bytes().length);
      return orig(fd, iovs, n, p);
    };
  }
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: fns });
  wasi.bindMemory(instance.exports.memory);
  const t0 = performance.now();
  let exit;
  try { instance.exports._start(); exit = { reason: "exit" }; }
  catch (e) { exit = { reason: "threw", message: String((e && e.message) || e) }; }
  const ms = performance.now() - t0;
  return { exit, stdout: wasi.sinks[1].bytes(), trace: wasi.sinks[3].bytes(), stamps, ms };
}

function parseTrace(bytes) {
  return dec.decode(bytes).split("\n").filter((l) => l.length).map((l) => JSON.parse(l)).filter((r) => r.p !== undefined);
}

/** Text written to stdout after record k and before record k+1 (belongs to the line of record k). */
function segments(stamps, stdout, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = stamps[k];
    const b = k + 1 < stamps.length ? stamps[k + 1] : stdout.length;
    out.push(dec.decode(stdout.subarray(a, b)));
  }
  return out;
}

const engine = await loadEngine({ env: createNodeEnv() });
const report = { meta: { node: process.version, engine: "s1-0.1.0", date: new Date().toISOString() }, programs: {}, lessons: {}, errors: [] };

async function analyzeProgram(file) {
  const src = fs.readFileSync(path.join(HERE, "programs", file), "utf8");
  const r = await engine.runProgram(src, "", { returnWasm: true });
  if (!r.wasm) throw new Error("runProgram did not return wasm");
  const module = await WebAssembly.compile(r.wasm);
  const s = await runModule(module, new Uint8Array(0), true);
  const recs = parseTrace(s.trace);
  const same = dec.decode(s.stdout) === r.stdout;
  const segs = segments(s.stamps, s.stdout, s.stamps.length);
  return {
    engineOk: r.ok, engineExit: r.exit, engineStdout: r.stdout,
    sanity: { stdoutMatchesEngine: same, stampCount: s.stamps.length, traceRecords: recs.length, rawStepsCount: r.rawSteps ? r.rawSteps.length : null },
    // E1: merged steps as the engine reports them (state before each line)
    steps: r.steps.map((st) => ({ line: st.line, fn: st.fn, depth: st.depth, vars: st.vars, uninit: st.uninit })),
    // E2/E4: per raw record, the stdout text emitted between this probe and the next one
    perRecord: recs.map((rec, k) => ({ k, line: rec.line, fn: rec.fn, depth: rec.depth, d: rec.d, outAfter: segs[k] ?? null })),
    stdoutAtEnd: dec.decode(s.stdout),
    exitStamped: s.exit,
  };
}

for (const f of ["e1_before.cpp", "e2_noflush.cpp", "e2_flush.cpp", "e2_endl.cpp", "e4_loop.cpp"]) {
  if (!fs.existsSync(path.join(HERE, "programs", f))) continue;
  try { report.programs[f] = await analyzeProgram(f); }
  catch (e) { report.errors.push({ file: f, message: String((e && e.message) || e) }); }
}

// D: lesson bundles from examples/cpp, timing with and without stamping, stop counts and limits.
const bundles = fs.readdirSync(REPO_EXAMPLES).filter((f) => f.endsWith(".gdbgui.json")).sort();
for (const f of bundles) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(REPO_EXAMPLES, f), "utf8"));
    const stdin = b.program_input || "";
    const r = await engine.runProgram(b.source_code, stdin, { returnWasm: true });
    if (!r.wasm) throw new Error("no wasm");
    const module = await WebAssembly.compile(r.wasm);
    const times = { plain: [], stamped: [] };
    let last = null;
    for (let i = 0; i < 3; i++) {
      times.plain.push((await runModule(module, new TextEncoder().encode(stdin), false)).ms);
      last = await runModule(module, new TextEncoder().encode(stdin), true);
      times.stamped.push(last.ms);
    }
    const recs = parseTrace(last.trace);
    report.lessons[f] = {
      engineOk: r.ok, engineExit: r.exit, steps: r.steps.length, rawRecords: recs.length,
      stampMatchesRecords: last.stamps.length === recs.length,
      stdoutMatchesEngine: dec.decode(last.stdout) === r.stdout,
      limitHit: r.errors ? r.errors.map((e) => e.kind) : [],
      msPlainMedian: median(times.plain), msStampedMedian: median(times.stamped),
    };
  } catch (e) {
    report.errors.push({ file: f, message: String((e && e.message) || e) });
  }
}

function median(a) { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)] * 10) / 10; }

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(0);
