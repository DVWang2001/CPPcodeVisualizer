// @ts-check
// vgdb in-browser engine — public API (S1).
//
//   const engine = await loadEngine();                       // downloads + verifies assets once
//   const r = await engine.runProgram(source, stdin, opts);  // instrument, compile, run, decode
//   // or: await runProgram(source, stdin, opts) using a lazily created default engine
//
// Architecture (plan §1.5(c)): the page thread (this module) fetches the compiler assets with
// `fetch(url, {integrity})` using assets/manifest.json, compiles clang/lld into WebAssembly.Module
// objects and hands them to the pipeline worker; the compiled student program comes back as a
// Module and runs in a fresh execution worker. Both workers are static same-origin files (never
// blob:), so each can get its own CSP. Watchdogs here terminate a stuck worker:
//   * compile budget (AST+compile+link, default 8 s, max 9.5 s): terminate + respawn the pipeline worker,
//     return {errors:[{kind:"compile-timeout"}]} within 10 s;
//   * execution wall clock (default 5 s, max 30 s): terminate the execution worker.

export const VERSION = "s1-0.1.0";

/** Defaults and hard bounds. Callers may lower budgets; raising is clamped to the max values. */
export const LIMITS = Object.freeze({
  compileTimeoutMs: 8000, maxCompileTimeoutMs: 9500,
  pchTimeoutMs: 30000,
  execTimeoutMs: 5000, maxExecTimeoutMs: 30000,
  decodeTimeoutMs: 10000,
  maxSourceBytes: 256 * 1024,
  maxStdinBytes: 1 << 20,
  stdoutBytes: 1 << 20, stderrBytes: 256 << 10, traceBytes: 24 << 20,
  maxMemoryBytes: 536870912, stackBytes: 8388608, maxSteps: 200000,
});

const REQUIRED_ASSETS = ["clang.wasm", "lld.wasm", "sysroot.tar", "headers.tar"];

/**
 * Validate an assets manifest (shape only; the hashes are enforced by the fetch/read).
 * @param {any} m
 */
export function validateManifest(m) {
  if (!m || typeof m !== "object" || !m.files || typeof m.files !== "object") throw new Error("manifest: missing files");
  for (const name of REQUIRED_ASSETS) {
    const f = m.files[name];
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256) || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(f.integrity) || !Number.isSafeInteger(f.size)) {
      throw new Error("manifest: bad entry for " + name);
    }
  }
  return m;
}

/**
 * Browser environment: assets via fetch+SRI, module workers from static URLs, IndexedDB PCH cache.
 * @param {{ baseUrl?: string | URL }} [o]
 */
export function browserEnv(o = {}) {
  const base = new URL(String(o.baseUrl || new URL("./", import.meta.url)));
  return {
    pchStore: "indexeddb",
    async loadAssets() {
      const res = await fetch(new URL("assets/manifest.json", base), { cache: "no-cache", credentials: "same-origin" });
      if (!res.ok) throw new Error("manifest: HTTP " + res.status);
      const manifest = validateManifest(await res.json());
      /** @param {string} name */
      const get = async (name) => {
        const r = await fetch(new URL("assets/" + name, base), { integrity: manifest.files[name].integrity, credentials: "same-origin" });
        if (!r.ok) throw new Error(name + ": HTTP " + r.status);
        return r;
      };
      /** @param {string} name */
      const wasm = async (name) => {
        const r = await get(name);
        try { return await WebAssembly.compileStreaming(r.clone()); }
        catch { return WebAssembly.compile(await r.arrayBuffer()); } // wrong MIME type on some servers
      };
      const [clangModule, lldModule, sysroot, headers] = await Promise.all([
        wasm("clang.wasm"), wasm("lld.wasm"), get("sysroot.tar").then((r) => r.arrayBuffer()), get("headers.tar").then((r) => r.arrayBuffer()),
      ]);
      return { clangModule, lldModule, sysroot, headers, hashes: { clang: manifest.files["clang.wasm"].sha256, sysroot: manifest.files["sysroot.tar"].sha256, headers: manifest.files["headers.tar"].sha256 } };
    },
    /** @param {"pipeline" | "exec"} kind */
    createWorker(kind) {
      return new Worker(new URL(kind === "pipeline" ? "pipeline.worker.js" : "exec.worker.js", base), { type: "module", name: "vgdb-" + kind });
    },
  };
}

/** @param {unknown} v @param {number} dflt @param {number} max */
const clampMs = (v, dflt, max) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, max) : dflt);

/**
 * Validate runProgram inputs at the trust boundary.
 * @param {unknown} source @param {unknown} stdin @param {any} opts
 */
export function normalizeRequest(source, stdin, opts) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (stdin !== undefined && stdin !== null && typeof stdin !== "string") throw new TypeError("stdin must be a string");
  const enc = new TextEncoder();
  const src = enc.encode(source), inp = enc.encode(stdin || "");
  if (src.length > LIMITS.maxSourceBytes) throw new RangeError(`source larger than ${LIMITS.maxSourceBytes} bytes`);
  if (inp.length > LIMITS.maxStdinBytes) throw new RangeError(`stdin larger than ${LIMITS.maxStdinBytes} bytes`);
  const o = opts && typeof opts === "object" ? opts : {};
  const allowed = new Set(["std", "instrument", "pch", "compileTimeoutMs", "execTimeoutMs", "returnWasm"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new TypeError("unknown option " + k);
  const std = o.std === undefined ? "c++17" : o.std;
  if (!["c++17", "c++20", "c++23"].includes(std)) throw new RangeError("std must be c++17, c++20 or c++23");
  return {
    source, stdin: inp,
    opts: { std, instrument: o.instrument !== false, pch: o.pch !== false, returnWasm: o.returnWasm === true },
    compileTimeoutMs: clampMs(o.compileTimeoutMs, LIMITS.compileTimeoutMs, LIMITS.maxCompileTimeoutMs),
    execTimeoutMs: clampMs(o.execTimeoutMs, LIMITS.execTimeoutMs, LIMITS.maxExecTimeoutMs),
  };
}

const STUDENT_STAGES = new Set(["ast", "compile", "link", "syntax"]);

/**
 * Structured clone (postMessage) turns null-prototype objects into ordinary ones. Every map keyed
 * by program-controlled names (variables, functions) is rebuilt with a null prototype on this side
 * so that names such as "__proto__", "constructor" or "hasOwnProperty" are only ever own data.
 * @param {any} o @returns {Record<string, any>}
 */
const nullProto = (o) => {
  const out = Object.create(null);
  if (o && typeof o === "object") for (const k of Object.keys(o)) out[k] = o[k];
  return out;
};

class Engine {
  /** @param {any} env @param {any} assets @param {any} options */
  constructor(env, assets, options) {
    this.env = env;
    this.assets = assets;
    this.options = options;
    this.seq = 0;
    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
    this.respawns = 0;
    /** @type {any} */
    this.pipe = null;
    /** @type {Promise<void> | null} */
    this.ready = null;
  }

  spawnPipeline() {
    const w = this.env.createWorker("pipeline");
    this.pipe = w;
    /** @type {Map<number, (m: any) => void>} */
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      w.onmessage = (/** @type {MessageEvent} */ ev) => {
        const m = ev.data;
        if (m.type === "ready") { resolve(); return; }
        const cb = this.pending && this.pending.get(m.id);
        if (cb) cb(m);
      };
      w.onerror = (/** @type {any} */ e) => {
        reject(e);
        for (const cb of (this.pending || new Map()).values()) cb({ type: "crashed", error: String(e && e.message || e) });
      };
    });
    const a = this.assets;
    w.postMessage({ type: "init", clangModule: a.clangModule, lldModule: a.lldModule, sysroot: a.sysroot, headers: a.headers, hashes: a.hashes, pchStore: this.env.pchStore, pchLimits: this.options.pchLimits });
    return this.ready;
  }

  respawn() {
    try { this.pipe && this.pipe.terminate(); } catch { /* already gone */ }
    this.respawns++;
    return this.spawnPipeline().catch(() => {});
  }

  /**
   * Send one request to the pipeline worker with a stage-aware watchdog.
   * @param {any} msg @param {{ studentBudgetMs: number, pchBudgetMs: number }} budget
   */
  async request(msg, budget) {
    await this.ready;
    const id = ++this.seq;
    const w = this.pipe;
    return new Promise((resolve) => {
      /** @type {any} */
      let timer = null;
      let studentStart = /** @type {number | null} */ (null);
      let stage = "start";
      const done = (/** @type {any} */ m) => { clearTimeout(timer); this.pending && this.pending.delete(id); resolve(m); };
      const onTimeout = () => {
        this.respawn();
        done({ type: "timeout", stage });
      };
      const arm = (/** @type {number} */ ms) => { clearTimeout(timer); timer = setTimeout(onTimeout, Math.max(0, ms)); };
      arm(msg.type === "compile" ? budget.pchBudgetMs : budget.studentBudgetMs);
      /** @type {Map<number, (m: any) => void>} */ (this.pending).set(id, (m) => {
        if (m.type === "stage") {
          stage = m.stage;
          if (STUDENT_STAGES.has(m.stage)) {
            if (studentStart === null) studentStart = performance.now();
            arm(budget.studentBudgetMs - (performance.now() - studentStart));
          } else if (m.stage === "pch") arm(budget.pchBudgetMs);
          return;
        }
        if (m.type === "crashed") { this.respawn(); }
        done(m);
      });
      const { transfer = [], ...body } = msg;
      w.postMessage({ ...body, id }, transfer);
    });
  }

  /** Run a module in a fresh execution worker with a wall-clock watchdog. */
  exec(/** @type {WebAssembly.Module} */ module, /** @type {Uint8Array} */ stdin, /** @type {number} */ timeoutMs) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const w = this.env.createWorker("exec");
      /** @type {any} */
      let timer = null;
      const finish = (/** @type {any} */ r) => { clearTimeout(timer); try { w.terminate(); } catch { /* gone */ } resolve({ ...r, wallMs: performance.now() - t0 }); };
      timer = setTimeout(() => finish({ exit: { reason: "timeout", code: null, message: `killed after ${timeoutMs} ms (wall clock)` }, stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0), limitHit: {} }), timeoutMs);
      w.onmessage = (/** @type {MessageEvent} */ ev) => finish(ev.data);
      w.onerror = (/** @type {any} */ e) => finish({ exit: { reason: "internal-error", code: null, message: String(e && e.message || e) }, stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0), limitHit: {} });
      w.postMessage({ module, stdin, limits: { stdoutBytes: LIMITS.stdoutBytes, stderrBytes: LIMITS.stderrBytes, traceBytes: LIMITS.traceBytes } });
    });
  }

  /**
   * @param {string} source @param {string} [stdin] @param {Record<string, any>} [opts]
   */
  runProgram(source, stdin = "", opts = {}) {
    const run = this.queue.then(() => this._run(source, stdin, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  /** @param {string} source @param {string} stdin @param {Record<string, any>} opts */
  async _run(source, stdin, opts) {
    const t0 = performance.now();
    const req = normalizeRequest(source, stdin, opts);
    const limits = { ...LIMITS, compileTimeoutMs: req.compileTimeoutMs, execTimeoutMs: req.execTimeoutMs };
    /** @type {any} */
    const result = {
      ok: false, engine: "wasm", version: VERSION, instrumented: req.opts.instrument,
      steps: [], rawSteps: 0, decls: {}, globals: {}, functions: {}, uninitDecls: [],
      stdout: "", stderr: "", exit: null, limits, errors: [], compileLog: "", timings: {}, pchFrom: null,
    };
    const c = await this.request({ type: "compile", source: req.source, opts: req.opts }, { studentBudgetMs: req.compileTimeoutMs, pchBudgetMs: LIMITS.pchTimeoutMs });
    result.timings.compile = performance.now() - t0;
    if (c.type === "timeout") {
      result.errors.push({ kind: "compile-timeout", stage: c.stage, message: `compilation exceeded its time budget (${req.compileTimeoutMs} ms) in stage ${c.stage}; the compiler worker was restarted` });
      return result;
    }
    if (c.type !== "compiled") { result.errors.push({ kind: "internal-error", message: c.error || "pipeline worker failed" }); return result; }
    result.timings.pipeline = c.timings;
    result.pchFrom = c.pchFrom || null;
    result.compileLog = c.log || "";
    if (!c.ok) { result.errors.push(...c.errors); return result; }
    if (c.wasm) result.wasm = c.wasm;
    if (c.meta) {
      result.decls = nullProto(c.meta.decls);
      for (const fn of Object.keys(result.decls)) result.decls[fn] = nullProto(result.decls[fn]);
      result.globals = nullProto(c.meta.globals);
      result.functions = nullProto(c.meta.functions);
      result.uninitDecls = c.meta.uninitDecls;
    }

    const t1 = performance.now();
    const x = await this.exec(c.module, req.stdin, req.execTimeoutMs);
    result.timings.exec = performance.now() - t1;
    const td = new TextDecoder();
    result.stdout = td.decode(x.stdout);
    result.stderr = td.decode(x.stderr);
    result.exit = x.exit;
    if (x.limitHit && x.limitHit.trace) result.exit = { reason: "trace-limit", code: null, message: "trace channel exceeded its byte cap" };
    if (x.nosys && Object.keys(x.nosys).length) result.nosys = x.nosys;
    if (x.exit && x.exit.reason === "forbidden-import") { result.errors.push({ kind: "forbidden-import", message: x.exit.message, imports: x.forbidden }); return result; }
    if (x.exit && x.exit.reason === "internal-error") { result.errors.push({ kind: "internal-error", message: x.exit.message }); return result; }

    if (c.meta && x.trace && x.trace.length) {
      const t2 = performance.now();
      const d = await this.request({ type: "decode", trace: x.trace, meta: c.meta, transfer: [x.trace.buffer] }, { studentBudgetMs: LIMITS.decodeTimeoutMs, pchBudgetMs: LIMITS.decodeTimeoutMs });
      result.timings.decode = performance.now() - t2;
      if (d.type !== "decoded") {
        result.errors.push({ kind: "internal-error", message: "trace decoding failed: " + (d.error || d.type) });
      } else {
        result.steps = d.steps.map((/** @type {any} */ s) => ({ ...s, vars: nullProto(s.vars) }));
        result.rawSteps = d.rawSteps;
        result.errors.push(...d.errors);
        if (d.limit) result.exit = { reason: "step-limit", code: result.exit && result.exit.code, message: d.limit === "steps" ? `stopped after ${LIMITS.maxSteps} recorded steps` : "trace size limit (20 MB) reached" };
        if (d.truncated) result.errors.push({ kind: "trace-truncated", message: "the last trace record was incomplete" });
      }
    }
    result.ok = !result.errors.some((/** @type {any} */ e) => e.kind !== "trace-truncated");
    result.timings.total = performance.now() - t0;
    return result;
  }

  dispose() {
    try { this.pipe && this.pipe.terminate(); } catch { /* gone */ }
    this.pipe = null;
  }
}

/**
 * Load (download + verify) the compiler and start the pipeline worker.
 * @param {{ env?: any, baseUrl?: string | URL, pchLimits?: { maxEntries?: number, maxBytes?: number } }} [options]
 */
export async function loadEngine(options = {}) {
  const env = options.env || browserEnv({ baseUrl: options.baseUrl });
  const assets = await env.loadAssets();
  const engine = new Engine(env, assets, options);
  await engine.spawnPipeline();
  return engine;
}

/** @type {Promise<Engine> | null} */
let defaultEngine = null;
/**
 * Convenience wrapper around a lazily created default (browser) engine.
 * @param {string} source @param {string} [stdin] @param {Record<string, any>} [opts]
 */
export async function runProgram(source, stdin = "", opts = {}) {
  if (!defaultEngine) defaultEngine = loadEngine();
  return (await defaultEngine).runProgram(source, stdin, opts);
}
