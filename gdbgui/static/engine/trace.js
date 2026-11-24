// @ts-check
// Trace decoder + strict validator for the fd-3 probe channel (see vg.h for the record format).
//
// Every record is checked against the instrumenter's static probe table (meta.probes, produced on
// the host and never by the student program):
//   * `p` must name an existing probe site, and `line`/`fn` must equal that site's line/function
//     (so `line` is an integer inside the file and `fn` is in the instrumenter's function set);
//   * `n` must list exactly the site's variable names (plus optional `<name>.capacity()` pseudo
//     variables of those names), each once; `d` may only contain names from `n`;
//   * `depth`/`frame` must be positive integers.
// Decoding is per line inside try/catch: the first bad record stops decoding and is reported as
// {kind: "trace-corrupted"}; the steps decoded before it are kept (the delta encoding cannot be
// trusted after a dropped record, so nothing after it is used). Values are stored in Maps and in
// null-prototype objects only, so names like "__proto__" or "constructor" are plain data.
//
// Runtime-error records (include/vgerr.h, runtime-error plan P1) are validated the same way: fixed fields, a kind
// whitelist, value names from a whitelist with numbers or short strings only, at most 64 recoverable records, and a
// fatal record only as the very last record. Each one is attached to the stop that was running when it was written
// (the last decoded stop) and returned in `runtimeErrors`. A student program can forge such records on fd 3; like
// forged stop records, that only changes its own run (engine README, threat model M3).

const REC_KEYS = new Set(["p", "line", "fn", "depth", "frame", "n", "d"]);
const CAP = ".capacity()";
const REF = ".ref()"; // reference alias pseudo variable (vg.h vd()): value "frame:name" of the aliased variable
const MAX_RECORDS = 200100; // vg.h stops at 200000 steps; a little slack for the limit record
const ERR_KEYS = new Set(["err", "fatal", "file", "line", "col", "v", "msg"]);
/** kind -> trap category of the exit a fatal error turns into (session.js SIGNALS: div-zero SIGFPE, memory SIGSEGV, abort SIGABRT, illegal SIGILL) */
const ERR_KINDS = new Map([
  ["signed-overflow", "illegal"], ["div-by-zero", "div-zero"], ["div-overflow", "div-zero"], ["shift", "illegal"],
  ["array-bounds", "memory"], ["float-cast-overflow", "illegal"], ["pointer-overflow", "memory"], ["null-deref", "memory"],
  ["misaligned", "memory"], ["object-size", "memory"], ["vla-bound", "illegal"], ["invalid-value", "illegal"],
  ["invalid-builtin", "illegal"], ["nonnull-arg", "memory"], ["nonnull-return", "memory"], ["alignment-assumption", "illegal"],
  ["unreachable", "illegal"], ["missing-return", "illegal"], ["assert", "abort"], ["libcxx", "abort"],
]);
const VALUE_KEYS = new Set(["op", "lhs", "rhs", "type", "bits", "index", "array", "ptr", "tck", "align", "value", "from", "to", "bound", "base", "result", "arg", "builtin", "expr", "func"]);
const TYPE_KEYS = new Set(["type", "array", "from", "to"]); // UBSan quotes type names: 'int' -> int
const MAX_RECOVERABLE = 64; // vgerr.h reports at most 64 places
/** UBSan's TypeCheckKind texts (compiler-rt ubsan_handlers.cpp) */
const TCK = ["load of", "store to", "reference binding to", "member access within", "member call on", "constructor call on",
  "downcast of", "downcast of", "upcast of", "cast to virtual base of", "_Nonnull binding to", "dynamic operation on"];

/** @param {unknown} v @returns {v is number} */
const posInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const own = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/** D6: an uninitialised variable is shown as 0 (arrays keep their shape). @param {any} v @returns {any} */
export function zeroLike(v) {
  if (typeof v === "number") return 0;
  if (Array.isArray(v)) return v.map(zeroLike);
  if (typeof v === "string") return v === "<?>" ? v : 0;
  return v;
}

/**
 * @typedef {{ line: number, fn: string, names: string[], u: Array<[string, number]>, w: number[], tplFns?: string[] }} ProbeSite
 * @typedef {{ lineCount: number, probes: ProbeSite[], cols?: Record<string, Array<[number, number, number]>> }} TraceMeta
 *   cols: per edited line, the verbatim runs of the original text as [instrumented col, original col, length] (bytes, 1-based)
 * @typedef {{ line: number, fn: string, depth: number, frame: number, vars: Record<string, any>, uninit?: string[] }} Step
 * @typedef {{ kind: string, fatal: boolean, step: number, line: number | null, col: number | null, inUser: boolean,
 *   file: string | null, values: Record<string, number | string>, message: string, libcxxMessage?: string }} RuntimeError
 *   step: the stop that was running (-1 before the first stop); line/col: the student's source position, or for an
 *   error inside library code (inUser false) the line of that stop and no column
 */

/** Original column of instrumented column `col` on `line` (null when unknown). @param {TraceMeta} meta @param {number} line @param {number} col */
export function originalCol(meta, line, col) {
  if (!Number.isInteger(col) || col < 1) return null;
  const segs = meta.cols && Object.prototype.hasOwnProperty.call(meta.cols, String(line)) ? meta.cols[String(line)] : null;
  if (!segs) return col; // the instrumenter did not touch this line
  for (const [oc, sc, n] of segs) if (col >= oc && col < oc + n) return sc + (col - oc);
  for (const [oc, sc] of segs) if (oc > col) return sc; // inside inserted text: the original position right after it
  const last = segs[segs.length - 1];
  return last ? last[1] + last[2] : null;
}

/** UBSan-style English text of an error (the console shows it; the UI builds its own wording from kind + values). @param {string} kind @param {Record<string, any>} v @param {string} msg */
function messageOf(kind, v, msg) {
  const q = (/** @type {any} */ t) => `'${t}'`;
  const tck = TCK[v.tck] || "access to";
  switch (kind) {
    case "signed-overflow":
      return v.op === "neg" ? `negation of ${v.lhs} cannot be represented in type ${q(v.type)}` : `signed integer overflow: ${v.lhs} ${v.op} ${v.rhs} cannot be represented in type ${q(v.type)}`;
    case "div-by-zero": return "division by zero";
    case "div-overflow": return `division of ${v.lhs} by ${v.rhs} cannot be represented in type ${q(v.type)}`;
    case "shift":
      if (typeof v.rhs === "number" && v.rhs < 0) return `shift exponent ${v.rhs} is negative`;
      if (typeof v.rhs === "number" && typeof v.bits === "number" && v.rhs >= v.bits) return `shift exponent ${v.rhs} is too large for ${v.bits}-bit type ${q(v.type)}`;
      if (typeof v.lhs === "number" && v.lhs < 0) return `left shift of negative value ${v.lhs}`;
      return `left shift of ${v.lhs} by ${v.rhs} places cannot be represented in type ${q(v.type)}`;
    case "array-bounds": return `index ${v.index} out of bounds for type ${q(v.array)}`;
    case "float-cast-overflow": return `${v.value} is outside the range of representable values of type ${q(v.to)}`;
    case "pointer-overflow": return `pointer index expression with base ${v.base} overflowed to ${v.result}`;
    case "null-deref": return `${tck} null pointer of type ${q(v.type)}`;
    case "misaligned": return `${tck} misaligned address ${v.ptr} for type ${q(v.type)}, which requires ${v.align} byte alignment`;
    case "object-size": return `${tck} address ${v.ptr} with insufficient space for an object of type ${q(v.type)}`;
    case "vla-bound": return `variable length array bound evaluates to non-positive value ${v.bound}`;
    case "invalid-value": return `load of value, which is not a valid value for type ${q(v.type)}`;
    case "invalid-builtin": return "passing zero to __builtin_ctz/clz, which is not a valid argument";
    case "nonnull-arg": return `null pointer passed as argument ${v.arg}, which is declared to never be null`;
    case "nonnull-return": return "null pointer returned from function declared to never return null";
    case "alignment-assumption": return "alignment assumption failed";
    case "unreachable": return "execution reached an unreachable program point";
    case "missing-return": return "execution reached the end of a value-returning function without returning a value";
    case "assert": return `Assertion failed: ${v.expr} (${v.func})`;
    default: return msg.trim();
  }
}

/**
 * Validate one error record (the caller has seen the "err" key). @param {any} rec @param {TraceMeta} meta
 * @returns {{ kind: string, fatal: boolean, file: string | null, line: number, col: number, values: Record<string, any>, msg: string }}
 */
function parseErr(rec, meta) {
  for (const k of Object.keys(rec)) if (!ERR_KEYS.has(k)) throw new Error("unexpected field in error record " + JSON.stringify(k));
  if (typeof rec.err !== "string" || !ERR_KINDS.has(rec.err)) throw new Error("unknown runtime error kind");
  if (rec.fatal !== 0 && rec.fatal !== 1) throw new Error("bad fatal flag");
  if (!(Number.isInteger(rec.line) && rec.line >= 0 && rec.line <= 10000000)) throw new Error("bad error line");
  if (!(Number.isInteger(rec.col) && rec.col >= 0 && rec.col <= 1000000)) throw new Error("bad error column");
  if (rec.file !== undefined && !(typeof rec.file === "string" && rec.file.length <= 300)) throw new Error("bad error file");
  if (rec.msg !== undefined && !(typeof rec.msg === "string" && rec.msg.length <= 600)) throw new Error("bad error message");
  /** @type {Record<string, any>} */
  const values = Object.create(null);
  if (rec.v !== undefined) {
    if (!rec.v || typeof rec.v !== "object" || Array.isArray(rec.v)) throw new Error("error values are not an object");
    for (const [k, x] of Object.entries(rec.v)) {
      if (!VALUE_KEYS.has(k)) throw new Error("unknown error value " + JSON.stringify(k));
      if (typeof x === "number") { if (!Number.isFinite(x)) throw new Error("bad error value"); values[k] = x; }
      else if (typeof x === "string" && x.length <= 256) values[k] = TYPE_KEYS.has(k) && x.length >= 2 && x.startsWith("'") && x.endsWith("'") ? x.slice(1, -1) : x;
      else if (x === null) values[k] = null;
      else throw new Error("bad error value for " + JSON.stringify(k));
    }
  }
  if (rec.line > meta.lineCount && rec.file === "main.cpp") throw new Error("error line out of range");
  return { kind: rec.err, fatal: rec.fatal === 1, file: typeof rec.file === "string" ? rec.file : null, line: rec.line, col: rec.col, values, msg: rec.msg || "" };
}

/**
 * The exit of a run whose last runtime error is fatal: a trap LocalGdb shows as a signal stop on the last step
 * (division SIGFPE, memory SIGSEGV, library check / assert SIGABRT, others SIGILL). null when the run went on.
 * @param {RuntimeError[]} errs
 */
export function runtimeExit(errs) {
  const i = errs.length - 1;
  if (i < 0 || !errs[i].fatal) return null;
  return { reason: "trap", code: null, trap: ERR_KINDS.get(errs[i].kind) || "illegal", message: errs[i].message, runtimeError: i };
}

/**
 * @param {Uint8Array} bytes  raw fd-3 bytes
 * @param {TraceMeta} meta
 * @param {{ maxRecords?: number }} [opts]
 */
export function decodeTrace(bytes, meta, opts = {}) {
  const maxRecords = opts.maxRecords || MAX_RECORDS;
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split("\n");
  const partial = lines.pop();         // "" when the stream ends with a newline
  const truncated = !!partial;
  /** @type {Step[]} */
  const steps = [];
  /** @type {Array<{ kind: string, record?: number, reason: string }>} */
  const errors = [];
  /** @type {string | null} */
  let limit = null;
  /** @type {Map<string, any>} */
  const state = new Map();
  /** @type {Map<number, Set<number>>} */
  const initialised = new Map();
  /** @type {Map<number, Set<string>>} */
  const siteNames = new Map();
  let raw = 0;
  /** @type {{ line: number, fn: string, frame: number } | null} */
  let prev = null;
  // S1: host stamps (exec.worker.js) — one per trace write. Offsets are kept only when the stamp
  // count matches the record count exactly (otherwise attribution would be guessed, so none is given).
  // a malformed stamps object is ignored (no offsets), never allowed to throw inside the record loop
  const stamps = opts.stamps && Array.isArray(opts.stamps.out) && Array.isArray(opts.stamps.err) ? opts.stamps : null;
  /** @type {Array<{ out: number | null, err: number | null }>} */
  const stepOffsets = [];
  let recordLines = 0;
  /** @type {RuntimeError[]} */
  const runtimeErrors = [];
  let recoverable = 0, fatalSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    recordLines++;
    try {
      if (raw >= maxRecords) throw new Error("too many records");
      if (fatalSeen) throw new Error("record after a fatal runtime error");
      const rec = JSON.parse(line);
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("record is not an object");
      const keys = Object.keys(rec);
      if (keys.includes("err")) {
        const e = parseErr(rec, meta);
        if (!e.fatal && ++recoverable > MAX_RECOVERABLE) throw new Error("too many runtime error records");
        const step = steps.length - 1;
        const inUser = e.file === "main.cpp" && e.line >= 1;
        /** @type {RuntimeError} */
        const out = {
          kind: e.kind, fatal: e.fatal, step, line: inUser ? e.line : step >= 0 ? steps[step].line : null,
          col: inUser ? originalCol(meta, e.line, e.col) : null, inUser, file: e.file, values: e.values,
          message: messageOf(e.kind, e.values, e.msg),
        };
        if (e.kind === "libcxx") {
          const m = /assertion [\s\S]*? failed: ([\s\S]*)$/.exec(e.msg);
          out.libcxxMessage = (m ? m[1] : e.msg).trim();
          out.message = out.libcxxMessage;
        }
        runtimeErrors.push(out);
        fatalSeen = e.fatal;
        continue;
      }
      if (keys.length === 1 && keys[0] === "limit") {
        if (rec.limit !== "steps" && rec.limit !== "bytes") throw new Error("bad limit record");
        limit = rec.limit;
        break;
      }
      for (const k of keys) if (!REC_KEYS.has(k)) throw new Error("unexpected field " + JSON.stringify(k));
      const p = rec.p;
      if (!(typeof p === "number" && Number.isInteger(p) && p >= 0 && p < meta.probes.length)) throw new Error("unknown probe id");
      const site = meta.probes[p];
      if (!(Number.isInteger(rec.line) && rec.line >= 1 && rec.line <= meta.lineCount)) throw new Error("line out of range");
      if (rec.line !== site.line) throw new Error("line does not match probe site");
      // a template body is shared by all its instantiations: the site lists the (host-computed) names it may run as
      if (typeof rec.fn !== "string" || !(rec.fn === site.fn || (Array.isArray(site.tplFns) && site.tplFns.includes(rec.fn)))) throw new Error("function does not match probe site");
      if (!posInt(rec.depth) || rec.depth > 10000000) throw new Error("bad depth");
      if (!posInt(rec.frame)) throw new Error("bad frame");
      if (!Array.isArray(rec.n)) throw new Error("n is not an array");
      if (!rec.d || typeof rec.d !== "object" || Array.isArray(rec.d)) throw new Error("d is not an object");
      let known = siteNames.get(p);
      if (!known) { known = new Set(site.names); siteNames.set(p, known); }
      /** @type {Set<string>} */
      const seen = new Set();
      for (const nm of rec.n) {
        if (typeof nm !== "string") throw new Error("variable name is not a string");
        const base = nm.endsWith(CAP) ? nm.slice(0, -CAP.length) : nm.endsWith(REF) ? nm.slice(0, -REF.length) : null;
        if (!known.has(nm) && !(base !== null && known.has(base))) throw new Error("unknown variable " + JSON.stringify(nm));
        if (seen.has(nm)) throw new Error("duplicate variable " + JSON.stringify(nm));
        seen.add(nm);
      }
      for (const nm of site.names) if (!seen.has(nm)) throw new Error("missing variable " + JSON.stringify(nm));
      for (const k of Object.keys(rec.d)) if (!seen.has(k)) throw new Error("value for a variable not in scope: " + JSON.stringify(k));

      // ---- accepted: apply delta, then materialise the stop ----
      raw++;
      for (const k of Object.keys(rec.d)) state.set(rec.fn + "\x1f" + k, rec.d[k]);
      let init = initialised.get(rec.frame);
      if (!init) { init = new Set(); initialised.set(rec.frame, init); }
      const sameStop = prev && prev.line === rec.line && prev.fn === rec.fn && prev.frame === rec.frame;
      if (!sameStop) {
        /** @type {Record<string, any>} */
        const vars = Object.create(null);
        for (const nm of rec.n) {
          const key = rec.fn + "\x1f" + nm;
          if (!state.has(key)) throw new Error("no value ever sent for " + JSON.stringify(nm));
          vars[nm] = state.get(key);
        }
        /** @type {string[]} */
        const un = [];
        for (const [nm, k] of site.u) if (!init.has(k) && own(vars, nm)) { vars[nm] = zeroLike(vars[nm]); un.push(nm); }
        /** @type {Step} */
        const s = { line: rec.line, fn: rec.fn, depth: rec.depth, frame: rec.frame, vars };
        if (un.length) s.uninit = un;
        steps.push(s);
        // stamps are per trace write (stop and error records alike): this record is write number recordLines - 1
        stepOffsets.push({ out: stamps ? stamps.out[recordLines - 1] ?? null : null, err: stamps ? stamps.err[recordLines - 1] ?? null : null });
        prev = { line: rec.line, fn: rec.fn, frame: rec.frame };
      }
      for (const k of site.w) init.add(k);
    } catch (e) {
      errors.push({ kind: "trace-corrupted", record: i, reason: String(/** @type {any} */ (e)?.message || e) });
      break;
    }
  }
  if (stamps) {
    // Offsets are trustworthy only if every trace write was decoded and stamped exactly once, and the
    // stamps never go backwards. Otherwise every offset is null (the trace error itself is still reported).
    const writes = recordLines + (truncated ? 1 : 0);
    const monotonic = (a) => a.every((v, j) => Number.isInteger(v) && (j === 0 || v >= a[j - 1]));
    const aligned = errors.length === 0 && stamps.out.length === writes && stamps.err.length === writes && monotonic(stamps.out) && monotonic(stamps.err);
    if (!aligned) for (const o of stepOffsets) { o.out = null; o.err = null; }
  }
  return { steps, rawSteps: raw, errors, limit, truncated, stepOffsets, runtimeErrors };
}
