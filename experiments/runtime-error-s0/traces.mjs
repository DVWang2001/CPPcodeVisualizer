// IRIS runtime-error S0: full traces for the visual mock-ups. Same build as spike3.mjs (no PCH, -O1, instrumented),
// but keeps every step (long traces: first 150 + last 150 steps and a per-depth summary) so the mock can show where a
// value came from. Run ONLY on lab-david, after spike3.mjs (see run_s0.sh phase "traces").
//   node traces.mjs <san|sanrec> <comma-separated case ids>
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL, fileURLToPath } from "node:url";
import { CASES } from "./cases_v2.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || "/app";
const ENGINE = REPO + "/gdbgui/static/engine";
const BOOT = REPO + "/tests/engine/node_worker_bootstrap.mjs";
const nd = await import(pathToFileURL(REPO + "/tests/engine/node_driver.mjs").href);
const { Driver } = await import(pathToFileURL(ENGINE + "/driver.js").href);
const { instrument } = await import(pathToFileURL(ENGINE + "/instrument.js").href);
const { decodeTrace } = await import(pathToFileURL(ENGINE + "/trace.js").href);
const { LINK_FLAGS } = await import(pathToFileURL(ENGINE + "/pipeline.worker.js").href);

const config = process.argv[2];
const ids = (process.argv[3] || "").split(",").filter(Boolean);
const EX_DIR = REPO + "/examples/cpp/errors";
const EXAMPLES = fs.existsSync(EX_DIR)
  ? fs.readdirSync(EX_DIR).filter((f) => f.endsWith(".cpp")).sort().map((f) => ({ id: "ex_" + f.replace(/\.cpp$/, ""), label: "examples/cpp/errors/" + f, stdin: "", src: fs.readFileSync(path.join(EX_DIR, f), "utf8") }))
  : [];
const ALL = [...CASES, ...EXAMPLES];
const VGERR = fs.readFileSync(path.join(HERE, "vgerr.h"), "utf8");
const ASSERT_H = fs.readFileSync(path.join(HERE, "assertion_handler.h"), "utf8");
const UB = ["-fsanitize=undefined", "-fno-sanitize=vptr,function"];
const SAN = {
  san: [...UB, "-fno-sanitize-recover=all", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE"],
  sanrec: [...UB, "-fno-sanitize-recover=all", "-fsanitize-recover=signed-integer-overflow,shift,bounds,float-cast-overflow,pointer-overflow",
    "-DVGERR_RECOVER", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE"],
};
if (!SAN[config]) throw new Error("config must be san or sanrec");
const FILES = { "vgerr.h": VGERR, "include/c++/v1/__assertion_handler": ASSERT_H };
const vgerrsOf = (stderr) => [...(stderr || "").matchAll(/\{"vgerr".*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return { raw: m[0] }; } });

function execInWorker(module, stdin, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const w = new Worker(BOOT, { workerData: { url: pathToFileURL(ENGINE + "/exec.worker.js").href } });
    const empty = { stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0) };
    const t = setTimeout(() => { w.terminate(); resolve({ exit: { reason: "timeout" }, ...empty }); }, timeoutMs);
    w.on("message", (m) => { if (m && m.type === "exec-result") { clearTimeout(t); w.terminate(); resolve(m); } });
    w.on("error", (e) => { clearTimeout(t); w.terminate(); resolve({ exit: { reason: "worker-error", message: String(e) }, ...empty }); });
    w.postMessage({ module, stdin });
  });
}

const d = new Driver(await nd.createNodeEnv().loadAssets());
const base = ["-std=c++17", "-fno-exceptions", "-O1"];
const out = [];
for (const id of ids) {
  const c = ALL.find((x) => x.id === id);
  if (!c) { out.push({ id, fail: "unknown case" }); continue; }
  const ins = await instrument(d, c.src, { flags: [...base, "-include", "vg.h"], files: {} }).catch((e) => ({ ok: false, log: String(e.message || e) }));
  if (!ins.ok) { out.push({ id, fail: "instrument", log: String(ins.log).slice(0, 600) }); console.error(id, "instrument failed"); continue; }
  const flags = [...base, ...SAN[config], "-include", "vg.h", "-include", "/vgerr.h", ...LINK_FLAGS];
  const cl = await d.compileLink(ins.text, { flags, files: FILES });
  if (!cl.ok) { out.push({ id, fail: cl.stage, log: String(cl.log).slice(0, 1500) }); console.error(id, "build failed"); continue; }
  const x = await execInWorker(await WebAssembly.compile(cl.wasm), c.stdin ? c.stdin + "\n" : "");
  const td = new TextDecoder();
  let steps = [], derr = [], limit = null, stepOffsets = null;
  if (x.trace && x.trace.length) {
    const dd = decodeTrace(x.trace, ins.meta, { stamps: x.stamps || null });
    steps = dd.steps; derr = dd.errors; limit = dd.limit || null; stepOffsets = dd.stepOffsets || null;
  }
  const slim = (s, i) => ({ i, line: s.line, fn: s.fn, depth: s.depth, frame: s.frame, vars: s.vars, uninit: s.uninit });
  const all = steps.map(slim);
  let kept = all, depthSummary = null;
  if (all.length > 400) {
    kept = [...all.slice(0, 150), { gap: all.length - 300 }, ...all.slice(-150)];
    const byDepth = new Map();
    for (const s of all) if (!byDepth.has(s.depth)) byDepth.set(s.depth, { depth: s.depth, firstStep: s.i, line: s.line, vars: s.vars });
    const ds = [...byDepth.values()];
    depthSummary = { maxDepth: Math.max(...ds.map((v) => v.depth)), first: ds.slice(0, 12), last: ds.slice(-12) };
  }
  out.push({
    id, label: c.label, config, src: c.src, stdin: c.stdin, exit: x.exit, limit, traceErrors: derr,
    stdout: td.decode(x.stdout).slice(0, 2000), vgerr: vgerrsOf(td.decode(x.stderr)), stepCount: all.length,
    steps: kept, depthSummary, stepOffsets: all.length <= 400 ? stepOffsets : null,
    decls: ins.meta.decls, uninitDecls: ins.meta.uninitDecls,
  });
  console.error(id, "done", all.length, "steps");
}
const file = path.join(HERE, `traces-${config}.json`);
fs.writeFileSync(file, JSON.stringify({ meta: { config, ids, finished: new Date().toISOString() }, rows: out }, null, 1));
console.log("wrote", file, out.length, "rows");
