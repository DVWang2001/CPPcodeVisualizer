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

const REC_KEYS = new Set(["p", "line", "fn", "depth", "frame", "n", "d"]);
const CAP = ".capacity()";
const MAX_RECORDS = 200100; // vg.h stops at 200000 steps; a little slack for the limit record

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
 * @typedef {{ line: number, fn: string, names: string[], u: Array<[string, number]>, w: number[] }} ProbeSite
 * @typedef {{ lineCount: number, probes: ProbeSite[] }} TraceMeta
 * @typedef {{ line: number, fn: string, depth: number, frame: number, vars: Record<string, any>, uninit?: string[] }} Step
 */

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    try {
      if (raw >= maxRecords) throw new Error("too many records");
      const rec = JSON.parse(line);
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("record is not an object");
      const keys = Object.keys(rec);
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
      if (typeof rec.fn !== "string" || rec.fn !== site.fn) throw new Error("function does not match probe site");
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
        const base = nm.endsWith(CAP) ? nm.slice(0, -CAP.length) : null;
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
        prev = { line: rec.line, fn: rec.fn, frame: rec.frame };
      }
      for (const k of site.w) init.add(k);
    } catch (e) {
      errors.push({ kind: "trace-corrupted", record: i, reason: String(/** @type {any} */ (e)?.message || e) });
      break;
    }
  }
  return { steps, rawSteps: raw, errors, limit, truncated };
}
