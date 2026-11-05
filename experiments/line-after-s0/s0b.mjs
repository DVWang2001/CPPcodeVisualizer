// S0b: remaining S0 experiments, run in one pass.
//   P  programs (printf, calls, return, stderr, stdin, big loop) and the 7 error programs (traps)
//   F  auto-flush emulation: append `std::cout.flush();` to every statement line inside a function body
//      (same line, so line numbers do not change), then check (1) stdout/stderr unchanged and the
//      control-flow sequence unchanged (differential), (2) attribution.
//   L  the 22 lesson bundles, original vs flush-emulated (differential on output and step sequence).
// Same method as s0.mjs: re-instantiate the engine's linked module with createWasi() and stamp the
// stdout and stderr lengths at every fd-3 (trace) write. Nothing in the product is changed.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../../gdbgui/static/engine/index.js";
import { createWasi } from "../../gdbgui/static/engine/exec.worker.js";
import { createNodeEnv } from "../../tests/engine/node_driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const dec = new TextDecoder();
const enc = new TextEncoder();

/** Insert `std::cout.flush();` at the end of each statement line inside a function body. */
function flushEmulate(src) {
  let depth = 0;
  return src.split("\n").map((line) => {
    const before = depth;
    // crude brace count outside string/char literals and // comments
    let inStr = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
      if (c === "/" && line[i + 1] === "/") break;
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const t = line.trimEnd();
    const isStmt = before >= 1 && t.endsWith(";") && !/^\s*(return\b)/.test(t) && !/#/.test(t) && !/\/\/@/.test(t);
    return isStmt ? t + " std::cout.flush();" : line;
  }).join("\n");
}

/** Run a linked module; stamp stdout and stderr lengths at each trace (fd 3) write. */
async function runModule(module, stdinText) {
  const stdin = enc.encode(stdinText || "");
  const wasi = createWasi({ stdin });
  const fns = { ...wasi.imports.wasi_snapshot_preview1 };
  const stampOut = [], stampErr = [];
  const orig = fns.fd_write;
  fns.fd_write = (fd, iovs, n, p) => {
    if (fd === 3) { stampOut.push(wasi.sinks[1].bytes().length); stampErr.push(wasi.sinks[2].bytes().length); }
    return orig(fd, iovs, n, p);
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: fns });
  wasi.bindMemory(instance.exports.memory);
  const t0 = performance.now();
  let exit;
  try { instance.exports._start(); exit = { reason: "exit" }; }
  catch (e) { exit = { reason: "threw", message: String((e && e.message) || e).slice(0, 200) }; }
  const ms = performance.now() - t0;
  return { exit, out: wasi.sinks[1].bytes(), err: wasi.sinks[2].bytes(), trace: wasi.sinks[3].bytes(), stampOut, stampErr, ms };
}

function parseTrace(bytes) {
  return dec.decode(bytes).split("\n").filter((l) => l.length).map((l) => JSON.parse(l)).filter((r) => r.p !== undefined);
}

function segs(stamps, total, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = stamps[k];
    const b = k + 1 < stamps.length ? stamps[k + 1] : total.length;
    out.push(a === undefined ? "" : (k === n - 1 ? total.subarray(a) : total.subarray(a, b)));
  }
  return out;
}

async function execVariant(engine, src, stdin) {
  const r = await engine.runProgram(src, stdin, { returnWasm: true });
  if (!r.wasm) return { engineOk: r.ok, engineErrors: r.errors, engineExit: r.exit, note: "no wasm" };
  const module = await WebAssembly.compile(r.wasm);
  const s = await runModule(module, stdin);
  const recs = parseTrace(s.trace);
  const outSegs = segs(s.stampOut, s.out, recs.length).map((b) => dec.decode(b));
  const errSegs = segs(s.stampErr, s.err, recs.length).map((b) => dec.decode(b));
  return {
    engineOk: r.ok, engineExit: r.exit, engineErrors: (r.errors || []).map((e) => e.kind),
    engineStdout: r.stdout, engineStderr: r.stderr,
    stampedStdout: dec.decode(s.out), stampedStderr: dec.decode(s.err), exit: s.exit,
    sanity: { stdoutMatchesEngine: dec.decode(s.out) === r.stdout, stderrMatchesEngine: dec.decode(s.err) === (r.stderr || ""),
      stampCount: s.stampOut.length, traceRecords: recs.length },
    sequence: recs.map((x) => `${x.line}|${x.fn}|${x.depth}`),
    perRecord: recs.map((x, k) => ({ k, line: x.line, fn: x.fn, depth: x.depth, d: x.d, outAfter: outSegs[k], errAfter: errSegs[k] })),
    ms: Math.round(s.ms * 10) / 10,
  };
}

const engine = await loadEngine({ env: createNodeEnv() });
const report = { meta: { node: process.version, engine: "s1-0.1.0", date: new Date().toISOString() }, programs: {}, lessons: {}, errors: [] };

// P + F: our programs and the 7 error programs
const progs = [];
for (const f of fs.readdirSync(path.join(HERE, "programs")).filter((x) => x.endsWith(".cpp")).sort()) progs.push({ name: "programs/" + f, file: path.join(HERE, "programs", f), stdin: f === "p_stdin.cpp" ? "5\n" : "" });
for (const f of fs.readdirSync(path.join(ROOT, "examples", "cpp", "errors")).filter((x) => x.endsWith(".cpp")).sort()) progs.push({ name: "errors/" + f, file: path.join(ROOT, "examples", "cpp", "errors", f), stdin: "" });

for (const p of progs) {
  try {
    const src = fs.readFileSync(p.file, "utf8");
    const emu = flushEmulate(src);
    const a = await execVariant(engine, src, p.stdin);
    const b = await execVariant(engine, emu, p.stdin);
    report.programs[p.name] = {
      original: a, flushEmulated: b,
      differential: {
        stdoutSame: a.engineStdout === b.engineStdout,
        stderrSame: (a.engineStderr || "") === (b.engineStderr || ""),
        sequenceSame: JSON.stringify(a.sequence) === JSON.stringify(b.sequence),
        exitSame: JSON.stringify(a.engineExit) === JSON.stringify(b.engineExit),
      },
    };
  } catch (e) { report.errors.push({ file: p.name, message: String((e && e.message) || e) }); }
}

// L: lesson bundles, original vs flush-emulated
const bdir = path.join(ROOT, "examples", "cpp");
for (const f of fs.readdirSync(bdir).filter((x) => x.endsWith(".gdbgui.json")).sort()) {
  try {
    const bundle = JSON.parse(fs.readFileSync(path.join(bdir, f), "utf8"));
    const stdin = bundle.program_input || "";
    const a = await execVariant(engine, bundle.source_code, stdin);
    const b = await execVariant(engine, flushEmulate(bundle.source_code), stdin);
    report.lessons[f] = {
      origStdout: a.engineStdout, origSequence: a.sequence, origPerRecord: a.perRecord,
      originalOk: a.engineOk, flushOk: b.engineOk,
      stdoutSame: a.engineStdout === b.engineStdout,
      sequenceSame: JSON.stringify(a.sequence) === JSON.stringify(b.sequence),
      records: a.sequence ? a.sequence.length : null,
      stampMatches: a.sanity && a.sanity.stampCount === a.sanity.traceRecords,
      msOriginal: a.ms, msFlush: b.ms,
      flushCompileErrors: b.engineErrors,
    };
  } catch (e) { report.errors.push({ file: f, message: String((e && e.message) || e) }); }
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(0);
