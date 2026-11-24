// IRIS runtime-error S0 harness. Read-only use of the engine in /app (frontend-builder image); writes results-*.json
// next to this file. Run ONLY on lab-david (see run_s0.sh / README.md).
//   node spike3.mjs <config> [comma-separated case ids]
// configs
//   cur | o0          engine.runProgram exactly as production (default -O1) / opt O0 (PCH, watchdogs, decode)
//   plain             same instrumenter, no PCH, production flags (baseline for the rows below)
//   san               + UBSan (fatal) + libc++ EXTENSIVE hardening + replacement __assertion_handler + vgerr.h
//   sanrec            san, but overflow/shift/bounds/float-cast/pointer-overflow report once per site and keep running
//   sandebug          san with libc++ DEBUG mode instead (shows its extra comparator calls in sort_user_cmp)
//   plainpch | sanpch like plain / san with a PCH of <vg.h> + <bits/stdc++.h> (realistic compile time)
//   depth             max recursion depth of deep_recursion, plain vs san, worker stack 1 MB (browser-like) and 4 MB
//   fidelity          every lesson program (tests/engine/e3_cases.mjs + examples/**/*.json with source_code):
//                     plain vs san must give identical steps and stdout; lists programs where san reports an error
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

const config = process.argv[2] || "cur";
const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const EX_DIR = REPO + "/examples/cpp/errors"; // the 7 programs of the paused 2026-11-05 work, unchanged
const EXAMPLES = fs.existsSync(EX_DIR)
  ? fs.readdirSync(EX_DIR).filter((f) => f.endsWith(".cpp")).sort().map((f) => ({ id: "ex_" + f.replace(/\.cpp$/, ""), label: "examples/cpp/errors/" + f, stdin: "", src: fs.readFileSync(path.join(EX_DIR, f), "utf8") }))
  : [];
const ALL = [...CASES, ...EXAMPLES];
const cases = ALL.filter((c) => !only || only.has(c.id));
const VGERR = fs.readFileSync(path.join(HERE, "vgerr.h"), "utf8");
const ASSERT_H = fs.readFileSync(path.join(HERE, "assertion_handler.h"), "utf8");
const UB = ["-fsanitize=undefined", "-fno-sanitize=vptr,function"];
const SAN = {
  san: [...UB, "-fno-sanitize-recover=all", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE"],
  sanrec: [...UB, "-fno-sanitize-recover=all", "-fsanitize-recover=signed-integer-overflow,shift,bounds,float-cast-overflow,pointer-overflow",
    "-DVGERR_RECOVER", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE"],
  sandebug: [...UB, "-fno-sanitize-recover=all", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG"],
};
SAN.sanpch = SAN.san;
const PCH_USE = ["-Xclang", "-include-pch", "-Xclang", "/vg.pch", "-fpch-validate-input-files-content", "-Xclang", "-fmodules-validate-system-headers"];
const sanFiles = (cfg) => (cfg === "sandebug" ? { "vgerr.h": VGERR } : { "vgerr.h": VGERR, "include/c++/v1/__assertion_handler": ASSERT_H });

const short = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
const vgerrsOf = (stderr) => [...(stderr || "").matchAll(/\{"vgerr".*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return { raw: m[0] }; } });
function summarize(c, r, extra = {}) {
  const st = r.steps || [];
  const last = st.length ? st[st.length - 1] : null;
  return {
    id: c.id, label: c.label, config, ok: r.ok,
    errors: (r.errors || []).map((e) => ({ kind: e.kind, msg: short(e.message, 160) })),
    exit: r.exit, steps: st.length, last: last ? { line: last.line, fn: last.fn, depth: last.depth, vars: last.vars } : null,
    stdout: short(r.stdout, 160), stderr: short(r.stderr, 400), vgerr: vgerrsOf(r.stderr), ...extra,
  };
}

function execInWorker(module, stdin, timeoutMs = 5000, stackSizeMb) {
  return new Promise((resolve) => {
    const w = new Worker(BOOT, { workerData: { url: pathToFileURL(ENGINE + "/exec.worker.js").href }, resourceLimits: stackSizeMb ? { stackSizeMb } : undefined });
    const empty = { stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0) };
    const t = setTimeout(() => { w.terminate(); resolve({ exit: { reason: "timeout" }, ...empty }); }, timeoutMs);
    w.on("message", (m) => { if (m && m.type === "exec-result") { clearTimeout(t); w.terminate(); resolve(m); } });
    w.on("error", (e) => { clearTimeout(t); w.terminate(); resolve({ exit: { reason: "worker-error", message: String(e) }, ...empty }); });
    w.postMessage({ module, stdin });
  });
}

async function buildPchWith(d, headerText, flags, files) {
  const { cc1 } = await d.commands("pch_src.h", ["-x", "c++-header", ...flags, "-Xclang", "-fno-pch-timestamp", "-o", "out.pch"]);
  const r = await d.cc1(cc1, { ...files, "pch_src.h": headerText }, { keep: "/out.pch" });
  if (r.code !== 0 || !r.kept) throw new Error("PCH build failed: " + r.err.slice(0, 800));
  return r.kept;
}

/** instrument + compile + link. san = extra flags or null; pch = {files} or null; files = extra MEMFS files */
async function build(d, src, san, pch, files) {
  const base = ["-std=c++17", "-fno-exceptions", "-O1"];
  const t0 = performance.now();
  let ins;
  try { ins = await instrument(d, src, { flags: [...base, "-include", "vg.h"], files: {} }); }
  catch (e) { return { fail: "instrument-throw", log: short(String(e.message || e), 300) }; }
  if (!ins.ok) return { fail: "instrument", log: short(ins.log, 600) };
  const tAst = performance.now() - t0;
  const all = { ...(files || {}) };
  const flags = [...base, ...(san || [])];
  if (pch) { flags.push(...PCH_USE); Object.assign(all, pch.files); } else flags.push("-include", "vg.h");
  if (san) flags.push("-include", "/vgerr.h");
  flags.push(...LINK_FLAGS);
  const t1 = performance.now();
  const cl = await d.compileLink(ins.text, { flags, files: all });
  const tCompileLink = performance.now() - t1;
  if (!cl.ok) return { fail: cl.stage, log: short(cl.log, 2500) };
  const module = await WebAssembly.compile(cl.wasm);
  return { module, meta: ins.meta, wasmBytes: cl.wasm.length, tAst: Math.round(tAst), tCompileLink: Math.round(tCompileLink), log: cl.log || "" };
}

async function runBuilt(b, stdin) {
  const x = await execInWorker(b.module, stdin);
  const td = new TextDecoder();
  let steps = [], derr = [];
  if (x.trace && x.trace.length) { const dd = decodeTrace(x.trace, b.meta, { stamps: x.stamps || null }); steps = dd.steps; derr = dd.errors; if (dd.limit) x.exit = { reason: "step-limit" }; }
  return { ok: true, errors: derr, exit: x.exit, steps, stdout: td.decode(x.stdout), stderr: td.decode(x.stderr) };
}

const out = [];
const meta = { config, started: new Date().toISOString(), repo: REPO, node: process.version };
if (config === "cur" || config === "o0") {
  const eng = await nd.loadNodeEngine();
  for (const c of cases) {
    const t0 = performance.now();
    const r = await eng.runProgram(c.src, c.stdin ? c.stdin + "\n" : "", config === "o0" ? { opt: "O0" } : {});
    out.push(summarize(c, r, { ms: Math.round(performance.now() - t0), tCompile: Math.round(r.timings.compile || 0), tExec: Math.round(r.timings.exec || 0), pchFrom: r.pchFrom }));
    console.error(c.id, "done");
  }
  eng.dispose();
} else if (config === "depth") {
  const d = new Driver(await nd.createNodeEnv().loadAssets());
  const src = CASES.find((c) => c.id === "deep_recursion").src;
  for (const [name, san] of [["plain", null], ["san", SAN.san]]) {
    const b = await build(d, src, san, null, san ? sanFiles("san") : {});
    if (!b.module) { out.push({ name, fail: b.fail, log: b.log }); continue; }
    for (const mb of [1, 4]) {
      const okAt = async (n) => { const x = await execInWorker(b.module, n + "\n", 20000, mb); return x.exit && x.exit.reason === "exit" && x.exit.code === 0 && new TextDecoder().decode(x.stdout).trim() === String(n); };
      let lo = 1, hi = 60000, res;
      if (!(await okAt(lo))) res = "fails at 1";
      else if (await okAt(hi)) res = ">= " + hi;
      else { while (hi - lo > Math.max(8, lo * 0.01)) { const mid = Math.floor((lo + hi) / 2); if (await okAt(mid)) lo = mid; else hi = mid; } res = { maxOk: lo, firstFail: hi }; }
      out.push({ name, stackSizeMb: mb, result: res });
      console.error(name, mb, JSON.stringify(res));
    }
  }
} else if (config === "fidelity") {
  const d = new Driver(await nd.createNodeEnv().loadAssets());
  const { e3Cases } = await import(pathToFileURL(REPO + "/tests/engine/e3_cases.mjs").href);
  const corpus = [], seen = new Set();
  const add = (id, src, stdin) => { const k = crypto.createHash("sha256").update(src + "\0" + stdin).digest("hex"); if (!seen.has(k)) { seen.add(k); corpus.push({ id, src, stdin }); } };
  for (const c of e3Cases()) add("e3-" + c.id + " " + c.name, c.source, c.stdin || "");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const f of walk(REPO + "/examples").filter((f) => f.endsWith(".json")).sort()) {
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (typeof j.source_code === "string" && j.source_code.trim()) add(path.relative(REPO, f), j.source_code, j.program_input ? j.program_input + "\n" : ""); } catch { /* not a lesson */ }
  }
  meta.corpus = corpus.length;
  for (const c of corpus.filter((c) => !only || only.has(c.id))) {
    const b0 = await build(d, c.src, null, null, {});
    if (!b0.module) { out.push({ id: c.id, skip: "plain " + b0.fail }); console.error(c.id, "skip"); continue; }
    const b1 = await build(d, c.src, SAN.san, null, sanFiles("san"));
    if (!b1.module) { out.push({ id: c.id, fail: "san " + b1.fail, log: b1.log }); console.error(c.id, "SAN BUILD FAILED"); continue; }
    const r0 = await runBuilt(b0, c.stdin), r1 = await runBuilt(b1, c.stdin);
    const s0 = r0.steps.map((s) => JSON.stringify(s)), s1 = r1.steps.map((s) => JSON.stringify(s));
    let diffAt = -1;
    for (let i = 0; i < Math.max(s0.length, s1.length); i++) if (s0[i] !== s1[i]) { diffAt = i; break; }
    out.push({
      id: c.id, sameSteps: diffAt < 0, diffAt, steps: [s0.length, s1.length], sameStdout: r0.stdout === r1.stdout,
      exit: [r0.exit, r1.exit], vgerr: vgerrsOf(r1.stderr), tCompileLink: [b0.tCompileLink, b1.tCompileLink], wasmBytes: [b0.wasmBytes, b1.wasmBytes],
      diff: diffAt < 0 ? undefined : { plain: short(s0[diffAt], 300), san: short(s1[diffAt], 300) },
    });
    console.error(c.id, diffAt < 0 ? "same" : "DIFF@" + diffAt);
  }
} else {
  const san = SAN[config] || null;
  if (!["plain", "plainpch", "san", "sanrec", "sandebug", "sanpch"].includes(config)) throw new Error("unknown config " + config);
  const files = san ? sanFiles(config) : {};
  const d = new Driver(await nd.createNodeEnv().loadAssets());
  let pch = null;
  if (config.endsWith("pch")) {
    const src = "#include <vg.h>\n#include <bits/stdc++.h>\n";
    const t0 = performance.now();
    const bytes = await buildPchWith(d, src, ["-std=c++17", "-fno-exceptions", "-O1", ...(san || [])], files);
    pch = { files: { "vg.pch": bytes, "pch_src.h": src } };
    meta.pch = { ms: Math.round(performance.now() - t0), bytes: bytes.length };
    console.error("pch built", meta.pch);
  }
  for (const c of cases) {
    if (pch && !/#include <bits\/stdc\+\+\.h>/.test(c.src)) continue; // this PCH covers bits/stdc++.h programs only
    const b = await build(d, c.src, san, pch, files);
    if (!b.module) { out.push({ id: c.id, label: c.label, config, fail: b.fail, log: b.log }); console.error(c.id, "FAILED", b.fail); continue; }
    const t1 = performance.now();
    const r = await runBuilt(b, c.stdin ? c.stdin + "\n" : "");
    const tExec = Math.round(performance.now() - t1);
    out.push(summarize(c, r, { tAst: b.tAst, tCompileLink: b.tCompileLink, tExec, wasmBytes: b.wasmBytes,
      warnings: short(b.log.split("\n").filter((l) => /warning:/.test(l)).join(" | "), 500) }));
    console.error(c.id, "done");
  }
}
meta.finished = new Date().toISOString();
const file = path.join(HERE, `results-${config}${only ? "-part" : ""}.json`);
fs.writeFileSync(file, JSON.stringify({ meta, rows: out }, null, 1));
console.log("wrote", file, out.length, "rows");
