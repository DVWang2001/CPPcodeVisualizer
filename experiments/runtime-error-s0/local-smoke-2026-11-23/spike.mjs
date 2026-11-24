// Spike harness (read-only use of the IRIS engine). Usage:
//   node spike.mjs cur|o0      -> engine.runProgram as production runs it (-O1 default / -O0)
//   node spike.mjs san|san0    -> same instrumenter, plus UBSan + libc++ debug hardening + vgerr.h, at -O1 / -O0
//   optional 2nd arg: comma-separated case ids
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL, fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = "C:/碩士/研究/papper/CPPcodeVisualizer";
const ENGINE = REPO + "/gdbgui/static/engine";
const BOOT = REPO + "/tests/engine/node_worker_bootstrap.mjs";
const nd = await import(pathToFileURL(REPO + "/tests/engine/node_driver.mjs").href);
const { Driver } = await import(pathToFileURL(ENGINE + "/driver.js").href);
const { instrument } = await import(pathToFileURL(ENGINE + "/instrument.js").href);
const { decodeTrace } = await import(pathToFileURL(ENGINE + "/trace.js").href);
const { LINK_FLAGS } = await import(pathToFileURL(ENGINE + "/pipeline.worker.js").href);

const config = process.argv[2] || "cur";
const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const cases = CASES.filter((c) => !only || only.has(c.id));
const VGERR = fs.readFileSync(path.join(HERE, "vgerr.h"), "utf8");
export const SAN_FLAGS = [
  "-fsanitize=undefined", "-fno-sanitize=vptr,function", "-fno-sanitize-recover=all",
  "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG",
];

const short = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
function vgerrOf(stderr) {
  const m = /\{"vgerr".*\}/.exec(stderr || "");
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return { raw: m[0] }; }
}
function summarize(c, r, extra = {}) {
  const st = r.steps || [];
  const last = st.length ? st[st.length - 1] : null;
  return {
    id: c.id, config, ok: r.ok,
    errors: (r.errors || []).map((e) => ({ kind: e.kind, msg: short(e.message, 160) })),
    exit: r.exit, steps: st.length, last: last ? { line: last.line, fn: last.fn, depth: last.depth } : null,
    stdout: short(r.stdout, 120), stderr: short(r.stderr, 300), vgerr: vgerrOf(r.stderr), ...extra,
  };
}

function execInWorker(module, stdin, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const w = new Worker(BOOT, { workerData: { url: pathToFileURL(ENGINE + "/exec.worker.js").href } });
    const empty = { stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0) };
    const t = setTimeout(() => { w.terminate(); resolve({ exit: { reason: "timeout" }, ...empty }); }, timeoutMs);
    w.on("message", (m) => { if (m && m.type === "exec-result") { clearTimeout(t); w.terminate(); resolve(m); } });
    w.on("error", (e) => { clearTimeout(t); w.terminate(); resolve({ exit: { reason: "worker-error", message: String(e) }, ...empty }); });
    w.postMessage({ module, stdin });
  });
}

const out = [];
if (config === "cur" || config === "o0") {
  const eng = await nd.loadNodeEngine();
  for (const c of cases) {
    const t0 = performance.now();
    const r = await eng.runProgram(c.src, c.stdin ? c.stdin + "\n" : "", config === "o0" ? { opt: "O0" } : {});
    out.push(summarize(c, r, { ms: Math.round(performance.now() - t0), tCompile: Math.round(r.timings.compile || 0), tExec: Math.round(r.timings.exec || 0) }));
    console.error(c.id, "done");
  }
  eng.dispose();
} else {
  const opt = config.endsWith("0") ? "O0" : "O1";
  const useSan = config.startsWith("san");
  const assets = await nd.createNodeEnv().loadAssets();
  const d = new Driver(assets);
  const base = ["-std=c++17", "-fno-exceptions", "-" + opt];
  for (const c of cases) {
    const t0 = performance.now();
    let ins;
    try { ins = await instrument(d, c.src, { flags: [...base, "-include", "vg.h"], files: {} }); }
    catch (e) { out.push({ id: c.id, config, stage: "instrument-throw", msg: short(String(e.message || e), 300) }); continue; }
    if (!ins.ok) { out.push({ id: c.id, config, stage: "instrument", log: short(ins.log, 600) }); continue; }
    const flags = useSan ? [...base, ...SAN_FLAGS, "-include", "vg.h", "-include", "/vgerr.h", ...LINK_FLAGS] : [...base, "-include", "vg.h", ...LINK_FLAGS];
    const cl = await d.compileLink(ins.text, { flags, files: useSan ? { "vgerr.h": VGERR } : {} });
    const tCompile = Math.round(performance.now() - t0);
    if (!cl.ok) { out.push({ id: c.id, config, stage: cl.stage, log: short(cl.log, 2500) }); console.error(c.id, "FAILED", cl.stage); continue; }
    const module = await WebAssembly.compile(cl.wasm);
    const t1 = performance.now();
    const x = await execInWorker(module, c.stdin ? c.stdin + "\n" : "");
    const tExec = Math.round(performance.now() - t1);
    const td = new TextDecoder();
    let steps = [], derr = [];
    if (x.trace && x.trace.length) { const dd = decodeTrace(x.trace, ins.meta, { stamps: x.stamps || null }); steps = dd.steps; derr = dd.errors; if (dd.limit) x.exit = { reason: "step-limit" }; }
    out.push(summarize(c, { ok: true, errors: derr, exit: x.exit, steps, stdout: td.decode(x.stdout), stderr: td.decode(x.stderr) },
      { tCompile, tExec, wasmBytes: cl.wasm.length, warnings: short((cl.log || "").split("\n").filter((l) => /warning:/.test(l)).join(" | "), 400) }));
    console.error(c.id, "done");
  }
}
const file = path.join(HERE, `results-${config}${only ? "-part" : ""}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log("wrote", file, out.length, "rows");
