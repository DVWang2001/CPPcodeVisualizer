// @ts-check
// vgdb execution worker: runs ONE compiled student program and exits. The host terminates this
// worker on its wall-clock watchdog, so an infinite loop can never block the page.
//
// Self-contained on purpose (no imports): this file can be served with its own
// `Content-Security-Policy: default-src 'none'; script-src 'self'` header (plan §1.5(c), S2).
//
// Security model (plan §6 M1/M2/M3):
//  * The student program is WebAssembly. Its ONLY way out of the sandbox is the import object.
//    Before instantiating, every entry of WebAssembly.Module.imports() must be a function import
//    from `wasi_snapshot_preview1` whose name is in WASI_PREVIEW1 (the complete preview1 list);
//    anything else (e.g. `env.x` declared with __attribute__((import_module/import_name))) is
//    rejected and the module is never instantiated.
//  * The import object is frozen and has exactly the preview1 names. Only the functions that
//    wasi-libc/libc++ need for console programs are implemented (fd 0 read, fd 1/2 write, fd 3
//    trace write, clocks, random, args/environ, exit, fdstat/prestat/seek/close answers). Every
//    other name (path_open, sock_send, poll_oneoff, ...) returns ERRNO_NOSYS. No filesystem,
//    no sockets, no host callbacks.
//  * Output caps are enforced inside fd_write, before any byte is copied: stdout/stderr/trace
//    each have a byte budget; the first write that would exceed it stores the part that fits and
//    stops the program (thrown sentinel), so memory use of the host stays bounded.
//  * fd 3 is the dedicated probe/trace channel (see vg.h and README "Trace channel").

/** Complete list of WASI snapshot_preview1 functions (witx, 46 names). */
export const WASI_PREVIEW1 = Object.freeze([
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get", "clock_res_get", "clock_time_get",
  "fd_advise", "fd_allocate", "fd_close", "fd_datasync", "fd_fdstat_get", "fd_fdstat_set_flags",
  "fd_fdstat_set_rights", "fd_filestat_get", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread",
  "fd_prestat_get", "fd_prestat_dir_name", "fd_pwrite", "fd_read", "fd_readdir", "fd_renumber", "fd_seek",
  "fd_sync", "fd_tell", "fd_write", "path_create_directory", "path_filestat_get", "path_filestat_set_times",
  "path_link", "path_open", "path_readlink", "path_remove_directory", "path_rename", "path_symlink",
  "path_unlink_file", "poll_oneoff", "proc_exit", "proc_raise", "sched_yield", "random_get", "sock_accept",
  "sock_recv", "sock_send", "sock_shutdown",
]);

/** Functions with a real implementation below; all other WASI_PREVIEW1 names return ERRNO_NOSYS. */
export const IMPLEMENTED = Object.freeze([
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get", "clock_res_get", "clock_time_get",
  "fd_close", "fd_fdstat_get", "fd_prestat_get", "fd_prestat_dir_name", "fd_read", "fd_seek", "fd_write",
  "proc_exit", "random_get", "sched_yield",
]);

export const ERRNO = Object.freeze({ SUCCESS: 0, BADF: 8, FAULT: 21, INVAL: 28, NOSYS: 52, SPIPE: 70 });

/** Default byte caps (host side). The trace cap is above vg.h's own 20 MB limit so the in-program
 *  limit normally fires first and leaves a clean `{"limit":...}` record. */
export const DEFAULT_LIMITS = Object.freeze({ stdoutBytes: 1 << 20, stderrBytes: 256 << 10, traceBytes: 24 << 20 });

const WASI_SET = new Set(WASI_PREVIEW1);
const TRACE_FD = 3;

class ProcExit { /** @param {number} code */ constructor(code) { this.code = code; } }
class OutputLimit { /** @param {string} stream */ constructor(stream) { this.stream = stream; } }

/**
 * Validate the imports of a compiled student module. Returns a list of offending imports
 * (empty = ok). Never instantiate a module for which this returns anything.
 * @param {WebAssembly.Module} module
 * @returns {string[]}
 */
export function checkImports(module) {
  const bad = [];
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== "wasi_snapshot_preview1" || imp.kind !== "function" || !WASI_SET.has(imp.name)) {
      bad.push(`${imp.module}.${imp.name} (${imp.kind})`);
    }
  }
  return bad;
}

/**
 * A byte sink with a hard cap. Chunks are copied out of wasm memory into a list; no string
 * concatenation, so the host never holds more than `cap` bytes per stream.
 * @param {number} cap
 */
function makeSink(cap) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let used = 0, hit = false;
  return {
    /** @param {Uint8Array} view  a view into wasm memory; returns false if the cap was hit */
    push(view) {
      const room = cap - used;
      if (view.length > room) {
        if (room > 0) chunks.push(view.slice(0, room));
        used = cap; hit = true;
        return false;
      }
      chunks.push(view.slice());
      used += view.length;
      return true;
    },
    get hit() { return hit; },
    get used() { return used; },
    bytes() {
      const out = new Uint8Array(used);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

/**
 * Build the frozen WASI import object for one run.
 * @param {{ stdin?: Uint8Array, limits?: Partial<typeof DEFAULT_LIMITS>, args?: string[] }} opts
 */
export function createWasi(opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const stdin = opts.stdin || new Uint8Array(0);
  const argv = (opts.args || ["main"]).map((a) => new TextEncoder().encode(a));
  let stdinPos = 0;
  const closed = new Set();
  const sinks = { 1: makeSink(limits.stdoutBytes), 2: makeSink(limits.stderrBytes), [TRACE_FD]: makeSink(limits.traceBytes) };
  /** @type {WebAssembly.Memory | null} */
  let memory = null;
  const counters = { nosys: /** @type {Record<string, number>} */ (Object.create(null)) };

  const buf = () => /** @type {WebAssembly.Memory} */ (memory).buffer;
  /** @param {number} ptr @param {number} len */
  const inBounds = (ptr, len) => ptr >= 0 && len >= 0 && ptr + len <= buf().byteLength;
  const dv = () => new DataView(buf());

  /** @param {number} iovs @param {number} n @returns {Array<[number, number]> | null} */
  const readIovs = (iovs, n) => {
    if (n < 0 || n > 1024 || !inBounds(iovs, n * 8)) return null;
    const d = dv(), out = [];
    for (let i = 0; i < n; i++) {
      const p = d.getUint32(iovs + i * 8, true), l = d.getUint32(iovs + i * 8 + 4, true);
      if (!inBounds(p, l)) return null;
      out.push(/** @type {[number, number]} */ ([p, l]));
    }
    return out;
  };

  /** @type {Record<string, Function>} */
  const impl = {
    args_sizes_get(argcPtr, bufSizePtr) {
      if (!inBounds(argcPtr, 4) || !inBounds(bufSizePtr, 4)) return ERRNO.FAULT;
      dv().setUint32(argcPtr, argv.length, true);
      dv().setUint32(bufSizePtr, argv.reduce((s, a) => s + a.length + 1, 0), true);
      return ERRNO.SUCCESS;
    },
    args_get(argvPtr, bufPtr) {
      const total = argv.reduce((s, a) => s + a.length + 1, 0);
      if (!inBounds(argvPtr, argv.length * 4) || !inBounds(bufPtr, total)) return ERRNO.FAULT;
      const d = dv(), u8 = new Uint8Array(buf());
      let p = bufPtr;
      argv.forEach((a, i) => { d.setUint32(argvPtr + i * 4, p, true); u8.set(a, p); u8[p + a.length] = 0; p += a.length + 1; });
      return ERRNO.SUCCESS;
    },
    environ_sizes_get(countPtr, sizePtr) {
      if (!inBounds(countPtr, 4) || !inBounds(sizePtr, 4)) return ERRNO.FAULT;
      dv().setUint32(countPtr, 0, true); dv().setUint32(sizePtr, 0, true);
      return ERRNO.SUCCESS;
    },
    environ_get() { return ERRNO.SUCCESS; },
    clock_res_get(id, resPtr) {
      if (id !== 0 && id !== 1) return ERRNO.INVAL;
      if (!inBounds(resPtr, 8)) return ERRNO.FAULT;
      dv().setBigUint64(resPtr, 1000n, true);
      return ERRNO.SUCCESS;
    },
    clock_time_get(id, _precision, timePtr) {
      if (!inBounds(timePtr, 8)) return ERRNO.FAULT;
      let ns;
      if (id === 0) ns = BigInt(Date.now()) * 1000000n;                              // REALTIME
      else if (id === 1 || id === 2 || id === 3) ns = BigInt(Math.round(performance.now() * 1e6)); // MONOTONIC / cputime
      else return ERRNO.INVAL;
      dv().setBigUint64(timePtr, ns, true);
      return ERRNO.SUCCESS;
    },
    fd_close(fd) {
      if (fd === 0 || fd === 1 || fd === 2) { if (closed.has(fd)) return ERRNO.BADF; closed.add(fd); return ERRNO.SUCCESS; }
      return ERRNO.BADF; // includes fd 3: the trace channel cannot be closed by the program
    },
    fd_fdstat_get(fd, statPtr) {
      if (!(fd >= 0 && fd <= TRACE_FD) || closed.has(fd)) return ERRNO.BADF;
      if (!inBounds(statPtr, 24)) return ERRNO.FAULT;
      const d = dv();
      d.setUint8(statPtr, 2);                // filetype CHARACTER_DEVICE (a console, like GDB's pty)
      d.setUint16(statPtr + 2, 0, true);     // fdflags
      // rights: fd 0 = FD_READ (1<<1); fd 1..3 = FD_WRITE (1<<6). No SEEK/TELL => isatty() is true.
      d.setBigUint64(statPtr + 8, fd === 0 ? 2n : 64n, true);
      d.setBigUint64(statPtr + 16, 0n, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_get() { return ERRNO.BADF; },      // no preopened directories: no filesystem at all
    fd_prestat_dir_name() { return ERRNO.BADF; },
    fd_seek(fd) { return fd >= 0 && fd <= TRACE_FD && !closed.has(fd) ? ERRNO.SPIPE : ERRNO.BADF; },
    fd_read(fd, iovs, n, nreadPtr) {
      if (fd !== 0 || closed.has(0)) return ERRNO.BADF;
      const list = readIovs(iovs, n);
      if (!list || !inBounds(nreadPtr, 4)) return ERRNO.FAULT;
      const u8 = new Uint8Array(buf());
      let total = 0;
      for (const [p, l] of list) {
        const k = Math.min(l, stdin.length - stdinPos);
        if (k <= 0) break;
        u8.set(stdin.subarray(stdinPos, stdinPos + k), p);
        stdinPos += k; total += k;
        if (k < l) break;
      }
      dv().setUint32(nreadPtr, total, true);
      return ERRNO.SUCCESS;
    },
    fd_write(fd, iovs, n, nwrittenPtr) {
      const sink = /** @type {any} */ (sinks)[fd];
      if (!sink || closed.has(fd)) return ERRNO.BADF;
      const list = readIovs(iovs, n);
      if (!list || !inBounds(nwrittenPtr, 4)) return ERRNO.FAULT;
      let total = 0;
      for (const [p, l] of list) {
        if (!sink.push(new Uint8Array(buf(), p, l))) {
          throw new OutputLimit(fd === 1 ? "stdout" : fd === 2 ? "stderr" : "trace");
        }
        total += l;
      }
      dv().setUint32(nwrittenPtr, total, true);
      return ERRNO.SUCCESS;
    },
    proc_exit(code) { throw new ProcExit(code >>> 0); },
    random_get(p, len) {
      if (!inBounds(p, len)) return ERRNO.FAULT;
      const u8 = new Uint8Array(buf(), p, len);
      for (let i = 0; i < len; i += 65536) globalThis.crypto.getRandomValues(u8.subarray(i, Math.min(len, i + 65536)));
      return ERRNO.SUCCESS;
    },
    sched_yield() { return ERRNO.SUCCESS; },
  };

  /** @type {Record<string, Function>} */
  const fns = Object.create(null);
  for (const name of WASI_PREVIEW1) {
    const f = Object.prototype.hasOwnProperty.call(impl, name) ? impl[name] : null;
    fns[name] = f
      ? (/** @type {any[]} */ ...a) => f(...a)
      : () => { counters.nosys[name] = (counters.nosys[name] || 0) + 1; return ERRNO.NOSYS; };
  }
  const imports = Object.freeze({ wasi_snapshot_preview1: Object.freeze(fns) });
  return {
    imports,
    /** @param {WebAssembly.Memory} m */
    bindMemory(m) { memory = m; },
    sinks,
    counters,
  };
}

/**
 * Map a thrown value from _start() to a structured exit.
 * @param {unknown} e
 */
function classify(e) {
  if (e instanceof ProcExit) return { reason: "exit", code: e.code };
  if (e instanceof OutputLimit) return { reason: "output-limit", stream: e.stream, code: null };
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    return { reason: "stack-overflow", code: null, message: "host call stack exhausted (recursion too deep)" };
  }
  if (e instanceof WebAssembly.RuntimeError) {
    const m = e.message;
    if (/unreachable/.test(m)) return { reason: "trap", code: null, trap: "abort", message: "program aborted (abort(), failed assertion, or out of memory: std::bad_alloc without exceptions)" };
    if (/out of bounds|memory access/.test(m)) return { reason: "trap", code: null, trap: "memory", message: "invalid memory access (stack overflow from deep recursion, or a bad pointer/index)" };
    if (/divide by zero|division by zero/.test(m)) return { reason: "trap", code: null, trap: "div-zero", message: "integer division by zero" };
    if (/call stack|stack overflow/i.test(m)) return { reason: "stack-overflow", code: null, message: "call stack exhausted (recursion too deep)" };
    return { reason: "trap", code: null, trap: "other", message: m };
  }
  return { reason: "internal-error", code: null, message: String(e && /** @type {any} */ (e).message || e) };
}

/**
 * Validate, instantiate and run a module. Never throws for student-program behaviour.
 * @param {WebAssembly.Module} module
 * @param {{ stdin?: Uint8Array | string, limits?: Partial<typeof DEFAULT_LIMITS> }} opts
 */
export async function execute(module, opts = {}) {
  const stdin = typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin;
  const bad = checkImports(module);
  if (bad.length) {
    return { exit: { reason: "forbidden-import", code: null, message: "program imports functions outside the WASI allowlist: " + bad.join(", ") }, forbidden: bad, stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0), limitHit: {}, ms: 0 };
  }
  const exps = WebAssembly.Module.exports(module);
  if (!exps.some((x) => x.name === "_start" && x.kind === "function") || !exps.some((x) => x.name === "memory" && x.kind === "memory")) {
    return { exit: { reason: "internal-error", code: null, message: "module does not export _start and memory" }, stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0), limitHit: {}, ms: 0 };
  }
  const wasi = createWasi({ stdin, limits: opts.limits });
  const instance = await WebAssembly.instantiate(module, wasi.imports);
  wasi.bindMemory(/** @type {WebAssembly.Memory} */ (instance.exports.memory));
  const t0 = performance.now();
  let exit;
  try {
    /** @type {Function} */ (instance.exports._start)();
    exit = { reason: "exit", code: 0 };
  } catch (e) {
    exit = classify(e);
  }
  const ms = performance.now() - t0;
  return {
    exit,
    stdout: wasi.sinks[1].bytes(),
    stderr: wasi.sinks[2].bytes(),
    trace: wasi.sinks[TRACE_FD].bytes(),
    limitHit: { stdout: wasi.sinks[1].hit, stderr: wasi.sinks[2].hit, trace: wasi.sinks[TRACE_FD].hit },
    nosys: { ...wasi.counters.nosys },
    ms,
  };
}

// Worker entry point: only installed when actually running as a worker (browser module worker,
// or the Node test harness which sets __vgNodeWorker). Importing this file elsewhere is inert.
const g = /** @type {any} */ (globalThis);
if (typeof g.WorkerGlobalScope !== "undefined" || g.__vgNodeWorker === true) {
  g.onmessage = async (/** @type {MessageEvent} */ ev) => {
    const m = ev.data || {};
    let res;
    try {
      if (!(m.module instanceof WebAssembly.Module)) throw new Error("exec worker: expected a WebAssembly.Module");
      res = await execute(m.module, { stdin: m.stdin, limits: m.limits });
    } catch (e) {
      res = { exit: { reason: "internal-error", code: null, message: String(e && /** @type {any} */ (e).message || e) }, stdout: new Uint8Array(0), stderr: new Uint8Array(0), trace: new Uint8Array(0), limitHit: {}, ms: 0 };
    }
    g.postMessage({ type: "exec-result", ...res }, [res.stdout.buffer, res.stderr.buffer, res.trace.buffer]);
  };
}
