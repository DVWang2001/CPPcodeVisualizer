// @ts-check
// vgdb pipeline worker: PCH -> AST analysis -> instrument -> compile -> link, and trace decoding.
// It never fetches anything: the main thread (index.js) downloads the compiler assets with
// `fetch(url, {integrity})`, compiles clang/lld to WebAssembly.Module and posts them here, so this
// worker can run under `connect-src 'none'` (plan §1.5(c)). It does not start the execution
// worker either (the page does), so a CSP can also forbid nested workers here.
// The page watches stage messages and terminates + respawns this worker when a compile exceeds its
// time budget (template/constexpr bombs), see index.js.
import { Driver } from "./driver.js";
import { instrument, Unsupported } from "./instrument.js";
import { scanPrelude } from "./userast.js";
import { decodeTrace } from "./trace.js";
import { PchCache, pchKey, createIdbStore, createMemoryStore } from "./pch.js";
import { sha256Hex } from "./sha256.js";

export const LINK_FLAGS = Object.freeze([
  "-Wl,--max-memory=536870912",   // 512 MiB linear memory cap (same budget as the server's ulimit -v)
  "-Wl,--stack-first",            // stack at the bottom: an overflow traps instead of corrupting data
  "-Wl,-z,stack-size=8388608",    // 8 MiB, the Linux default stack the GDB path gets (no ulimit -s)
]);
export const STD_ALLOWED = Object.freeze(["c++17", "c++20", "c++23"]);
const PCH_USE = ["-Xclang", "-include-pch", "-Xclang", "/vg.pch", "-fpch-validate-input-files-content", "-Xclang", "-fmodules-validate-system-headers"];

/** @type {Driver | null} */
let driver = null;
/** @type {PchCache | null} */
let pchCache = null;
/** @type {Map<string, Uint8Array>} */
const hotPch = new Map();
let hashes = { clang: "", sysroot: "", headers: "", vg: "" };

const g = /** @type {any} */ (globalThis);
const post = (/** @type {any} */ m, /** @type {Transferable[]} */ t = []) => g.postMessage(m, t);
const now = () => performance.now();

/** System include lines usable for the PCH, or null when the prelude is not PCH-safe. @param {string} source */
export function pchIncludes(source) {
  const pre = scanPrelude(source);
  if (!pre.onlyIncludesBefore || pre.codeBefore !== null) return null;
  const incs = [];
  for (const l of source.split("\n").map((x) => x.replace(/\r$/, ""))) {
    const m = /^\s*#\s*include\s*<([\w./+-]+)>\s*(\/\/.*)?$/.exec(l);
    if (m) incs.push(m[1]);
    else if (/^\s*#\s*include\b/.test(l)) return null; // quoted or unusual include: no PCH
  }
  return [...new Set(incs)];
}

/** @param {string} std @param {string[]} includes @param {(s: string) => void} stage */
async function getPch(std, includes, stage) {
  const key = await pchKey({ std, includes, vgSha256: hashes.vg, headersSha256: hashes.headers, clangSha256: hashes.clang, sysrootSha256: hashes.sysroot });
  const src = "#include <vg.h>\n" + includes.map((i) => `#include <${i}>\n`).join("");
  let bytes = hotPch.get(key), from = "memory";
  if (!bytes && pchCache) { const b = await pchCache.get(key); if (b) { bytes = b; from = "cache"; } }
  if (!bytes) {
    stage("pch");
    bytes = await /** @type {Driver} */ (driver).buildPch(src, [`-std=${std}`, "-fno-exceptions", "-O0"]);
    from = "built";
    if (pchCache) await pchCache.put(key, bytes);
  }
  hotPch.set(key, bytes);
  if (hotPch.size > 3) hotPch.delete(/** @type {string} */ (hotPch.keys().next().value));
  return { files: { "vg.pch": bytes, "pch_src.h": src }, flags: PCH_USE, from, key };
}

/**
 * @param {string} source
 * @param {{ std?: string, instrument?: boolean, pch?: boolean, returnWasm?: boolean }} opts
 * @param {(s: string) => void} stage
 */
async function compileProgram(source, opts, stage) {
  const d = /** @type {Driver} */ (driver);
  const std = opts.std || "c++17";
  if (!STD_ALLOWED.includes(std)) return { ok: false, errors: [{ kind: "bad-request", message: "unsupported -std " + std }] };
  const base = [`-std=${std}`, "-fno-exceptions", "-O0"];
  /** @type {Record<string, number>} */
  const T = {};
  let t0 = now();
  const doInstrument = opts.instrument !== false;
  let pch = null;
  if (doInstrument && opts.pch !== false) {
    const incs = pchIncludes(source);
    if (incs) {
      try { pch = await getPch(std, incs, stage); } catch { pch = null; /* e.g. unknown header: fall back */ }
    }
  }
  T.pch = now() - t0;

  const diagnose = async () => {
    stage("syntax");
    const r = await d.syntaxCheck(source, { flags: [...base, "-include", "vgcompat.h"] });
    return r.err;
  };
  /** Classify a failure using the diagnostics of the ORIGINAL source. @param {string} diag @param {string} internalLog */
  const failure = (diag, internalLog) => {
    const ex = /main\.cpp:(\d+):\d+: error: cannot use '(try|throw)' with exceptions disabled/.exec(diag);
    if (ex) return { kind: "unsupported", construct: ex[2], line: Number(ex[1]), message: `unsupported construct: ${ex[2]} (line ${ex[1]})` };
    if (/\berror\b/.test(diag)) return { kind: "compile", message: diag };
    // the program itself is valid C++: the analysis/instrumentation step is at fault
    return { kind: "instrumentation-failed", message: (internalLog || "").slice(0, 4000) };
  };

  let text = source, meta = null;
  if (doInstrument) {
    stage("ast");
    t0 = now();
    const astFlags = pch ? [...base, ...pch.flags] : [...base, "-include", "vg.h"];
    let ins;
    try {
      ins = await instrument(d, source, { flags: astFlags, files: pch ? pch.files : {} });
    } catch (e) {
      if (e instanceof Unsupported) return { ok: false, errors: [{ kind: "unsupported", construct: e.construct, line: e.line, message: e.message }], timings: T };
      throw e;
    }
    T.ast = now() - t0;
    if (!ins.ok) return { ok: false, errors: [failure(await diagnose(), ins.log || "")], timings: T };
    text = /** @type {string} */ (ins.text);
    meta = ins.meta;
  }

  t0 = now();
  const flags = doInstrument
    ? (pch ? [...base, ...pch.flags, ...LINK_FLAGS] : [...base, "-include", "vg.h", ...LINK_FLAGS])
    : [...base, "-include", "vgcompat.h", ...LINK_FLAGS];
  const c = await d.compileLink(text, { flags, files: pch ? pch.files : {}, onStage: stage });
  T.compileLink = now() - t0;
  if (!c.ok || !c.wasm) {
    // Distinguish "the program is wrong" from "the instrumenter produced invalid C++".
    if (doInstrument) return { ok: false, errors: [failure(await diagnose(), c.log || "")], timings: T };
    const f = failure(c.log || "", c.log || "");
    return { ok: false, errors: [f.kind === "instrumentation-failed" ? { kind: c.stage === "link" ? "link" : "compile", message: c.log } : f], timings: T };
  }
  const module = await WebAssembly.compile(c.wasm);
  return { ok: true, module, meta, log: c.log, timings: T, pchFrom: pch ? pch.from : null, wasm: opts.returnWasm ? c.wasm : undefined, instrumented: doInstrument };
}

const isWorker = typeof g.WorkerGlobalScope !== "undefined" || g.__vgNodeWorker === true;
if (isWorker) g.onmessage = async (/** @type {MessageEvent} */ ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "init") {
      driver = new Driver({ clangModule: m.clangModule, lldModule: m.lldModule, sysroot: m.sysroot, headers: m.headers });
      hashes = { clang: m.hashes.clang, sysroot: m.hashes.sysroot, headers: m.hashes.headers, vg: await sha256Hex(driver.vgH) };
      if (m.pchStore === "indexeddb" && typeof indexedDB !== "undefined") pchCache = new PchCache({ store: createIdbStore(), ...(m.pchLimits || {}) });
      else if (m.pchStore === "memory") pchCache = new PchCache({ store: createMemoryStore(), ...(m.pchLimits || {}) });
      else pchCache = null;
      post({ type: "ready" });
    } else if (m.type === "compile") {
      if (!driver) throw new Error("pipeline worker not initialised");
      const stage = (/** @type {string} */ s) => post({ type: "stage", id: m.id, stage: s });
      const r = await compileProgram(m.source, m.opts || {}, stage);
      post({ type: "compiled", id: m.id, ...r });
    } else if (m.type === "decode") {
      const r = decodeTrace(m.trace, m.meta);
      post({ type: "decoded", id: m.id, ...r });
    }
  } catch (e) {
    post({ type: "failed", id: m.id, error: String(/** @type {any} */ (e)?.stack || e) });
  }
};
