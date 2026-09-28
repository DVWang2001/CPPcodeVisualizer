// Read-only model of one engine run: frame structure of the trace, per-step visible variables
// (GDB block rules), types, pseudo addresses. Everything LocalGdb reports about "the program" is
// derived from here; nothing is executed.
// Plain ES module, no DOM / Node APIs.

import { analyzeScopes, chainAt } from "./scopes.js";
import { parseType, classify, gdbType, signatureType, formatScalar, FLAT_CONTAINER_KINDS, containerHead } from "./types.js";

const own = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * @typedef {{ name: string, qual: string, node: any, cls: any, gdbType: string, isArg: boolean, raw: any, present: boolean,
 *   uninit: boolean, blockId: number, blockKind: string, declLine: number, frameId: number, capacity?: number }} VarEntry
 * @typedef {{ level: number, stepIdx: number, frameId: number, fn: string, line: number, depth: number }} FrameRec
 */

export class TraceModel {
  /**
   * @param {{ steps: any[], functions: any, decls: any, globals: any, source: string, exit?: any }} run  engine result (runProgram) + source text
   */
  constructor(run) {
    this.steps = run.steps;
    this.functions = run.functions || {};
    this.decls = run.decls || {};
    this.globals = run.globals || {};
    this.exit = run.exit || { reason: "exit", code: 0 };
    this.source = run.source || "";
    this.fnNames = Object.keys(this.functions);
    /** @type {Map<string, import("./scopes.js").FnScopes>} */
    this.scopes = analyzeScopes(this.source, this.functions, this.globals);
    /** @type {Map<number, { first: number, last: number, fn: string, depth: number, callerStep: number }>} */
    this.frames = new Map();
    const lastAtDepth = [];
    this.steps.forEach((s, i) => {
      let f = this.frames.get(s.frame);
      if (!f) {
        f = { first: i, last: i, fn: s.fn, depth: s.depth, callerStep: s.depth > 1 ? (lastAtDepth[s.depth - 1] ?? -1) : -1 };
        this.frames.set(s.frame, f);
      }
      f.last = i;
      lastAtDepth[s.depth] = i;
    });
    /** @type {Map<number, number[]>} step indexes per frame (ascending) */
    this.frameSteps = new Map();
    this.steps.forEach((s, i) => { const a = this.frameSteps.get(s.frame); if (a) a.push(i); else this.frameSteps.set(s.frame, [i]); });
    /** previous step of the same frame (-1 for the first) and, for each frame, its ordinal among the callees of the same caller step */
    this.prevInFrame = new Int32Array(this.steps.length).fill(-1);
    this.calleeOrd = new Map();
    const lastOf = new Map(), calls = new Map();
    this.steps.forEach((s, i) => {
      if (lastOf.has(s.frame)) this.prevInFrame[i] = lastOf.get(s.frame);
      else {
        const f = /** @type {any} */ (this.frames.get(s.frame));
        this.calleeOrd.set(s.frame, f.callerStep >= 0 ? calls.get(f.callerStep) || 0 : 0);
        if (f.callerStep >= 0) calls.set(f.callerStep, (calls.get(f.callerStep) || 0) + 1);
      }
      lastOf.set(s.frame, i);
    });
    /** @type {Map<number, number>} */ this.addrCache = new Map();
    this.typeCache = new Map();
    // lines that hold code (GDB can place a breakpoint there)
    this.codeLines = [...new Set(this.steps.map((s) => s.line))].sort((a, b) => a - b);
  }

  /** @param {number} frameId @param {number} idx  latest step of that frame at or before idx, or -1 */
  frameStepAtOrBefore(frameId, idx) {
    const a = this.frameSteps.get(frameId);
    if (!a) return -1;
    let lo = 0, hi = a.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= idx) { r = a[m]; lo = m + 1; } else hi = m - 1; }
    return r;
  }

  /** @param {number} stepIdx @returns {FrameRec[]} innermost first */
  chain(stepIdx) {
    /** @type {FrameRec[]} */
    const out = [];
    let cur = stepIdx;
    for (let level = 0; cur >= 0 && level < 10000; level++) {
      const s = this.steps[cur];
      out.push({ level, stepIdx: cur, frameId: s.frame, fn: s.fn, line: s.line, depth: s.depth });
      const f = this.frames.get(s.frame);
      cur = f ? f.callerStep : -1;
    }
    return out;
  }

  /** @param {string} fn @param {string} name @param {number} nth @returns {string} clang qualType */
  qualOf(fn, name, nth) {
    const d = this.decls[fn] && own(this.decls[fn], name) ? this.decls[fn][name] : own(this.globals, name) ? this.globals[name] : "int";
    if (Array.isArray(d)) return d[Math.min(nth, d.length - 1)];
    return d;
  }

  /** @param {string} qual */
  typeInfo(qual) {
    let t = this.typeCache.get(qual);
    if (!t) {
      let node, cls, g;
      try { node = parseType(qual); cls = classify(node); g = gdbType(node); } catch { node = { k: "n", name: qual, args: [], c: false }; cls = classify(node); g = qual; }
      t = { node, cls, gdbType: g };
      this.typeCache.set(qual, t);
    }
    return t;
  }

  /**
   * Variables of the frame whose innermost step is `stepIdx`, in GDB order (innermost block first,
   * declaration order inside a block), including variables declared later in a visible block.
   * @param {number} stepIdx @returns {VarEntry[]}
   */
  visibleVars(stepIdx) {
    const step = this.steps[stepIdx];
    const sc = this.scopes.get(step.fn);
    if (!sc) return [];
    const fnMeta = this.functions[step.fn];
    const chain = chainAt(sc, step.line);
    /** @type {Array<{ v: any, b: any }>} */
    const list = [];
    for (const b of chain) for (const v of b.vars) list.push({ v, b });
    // which entry of a shadowed name receives the trace value: innermost already declared one
    /** @type {Map<string, number>} */
    const owner = new Map();
    list.forEach((e, i) => { if (!owner.has(e.v.name) && e.v.declLine <= step.line) owner.set(e.v.name, i); });
    const uninit = new Set(step.uninit || []);
    return list.map((e, i) => {
      const name = e.v.name;
      const qual = this.qualOf(step.fn, name, e.v.nth);
      const ti = this.typeInfo(qual);
      const present = owner.get(name) === i && own(step.vars, name);
      const raw = present ? step.vars[name] : zeroFor(ti.cls);
      const capKey = name + ".capacity()";
      /** @type {VarEntry} */
      const entry = {
        name, qual, node: ti.node, cls: ti.cls, gdbType: ti.gdbType,
        isArg: e.b.kind === "function" && fnMeta.params.includes(name),
        raw, present, uninit: !present || uninit.has(name), blockId: e.b.id, blockKind: e.b.kind, declLine: e.v.declLine, frameId: step.frame,
      };
      if (present && own(step.vars, capKey) && typeof step.vars[capKey] === "number") entry.capacity = step.vars[capKey];
      return entry;
    });
  }

  /** Innermost block id at `line` in `fn`. @param {string} fn @param {number} line */
  innermostBlock(fn, line) {
    const sc = this.scopes.get(fn);
    if (!sc) return null;
    const c = chainAt(sc, line);
    return c.length ? c[0] : null;
  }

  /** Signature as GDB prints a C++ function name in `bkpt.func`: `fact(int)`, `main()`. @param {string} fn */
  signature(fn) {
    const meta = this.functions[fn];
    if (!meta) return fn + "()";
    const ps = meta.params.map((p) => {
      const ti = this.typeInfo(this.qualOf(fn, p, 0));
      try { return signatureType(ti.node); } catch { return ti.gdbType; }
    });
    return `${fn}(${ps.join(", ")})`;
  }

  // ---- pseudo addresses ------------------------------------------------------------------------------
  // What the UI relies on (audit of gdbgui/src/js):
  //  * forHeader.ts decideForSegment (via Actions.ts recompute_for_sub_step): on a stop at a `for` line the segment is
  //    "A" (init) iff frame.addr == the smallest addr seen so far for that line, else "C" (increment) -> the loop-entry
  //    (init) address of a for-line must be LOWER than its increment address, both fixed per for-line (g++ -O0 layout).
  //  * callTree.ts ingestStack: the call-site identity of a caller frame is its frame.addr (return address): stable for
  //    one call site (same on every loop iteration), different for two calls on the same source line.
  //  * Threads.tsx: frame.addr equality picks the selected frame; breakpoints/frames of one line share the line's address.
  // Layout (golden: 0x40147d init < 0x401486 body < 0x4014ec increment on `for` line 33, likewise 41):
  //   lineAddr = 0x401000 + fnIndex*0x100000 + line*0x100          (monotonic in source order, functions in declaration order)
  //   increment stop of a `for` line = lineAddr(loop end line) + 0xC0 - nesting*0x10 (above the whole body, inner loops below outer)
  //   return address of a call made at step c = stepAddr(c) + 5 + 8*k   (k = index of the call among the calls made from that step)

  /** First address of a source line (breakpoints, init stops). @param {string} fn @param {number} line */
  lineAddr(fn, line) {
    const i = Math.max(0, this.fnNames.indexOf(fn));
    return 0x401000 + i * 0x100000 + line * 0x100;
  }

  /** Is step `idx` on a `for` line the loop-entry (init) or the increment stop? null when the line is no `for` header. @param {number} idx @returns {{ seg: "init" | "incr", end: number, depth: number } | null} */
  forSegment(idx) {
    const s = this.steps[idx];
    const sc = this.scopes.get(s.fn);
    const b = sc && sc.blocks.find((x) => x.kind === "for" && x.start === s.line);
    if (!b) return null;
    const p = this.prevInFrame[idx];
    const pl = p >= 0 ? this.steps[p].line : -1;
    return { seg: pl > b.start && pl <= b.end ? "incr" : "init", end: b.end, depth: b.depth };
  }

  /**
   * Is step `idx` a RE-evaluation stop of a loop header (`for` increment, `while` condition after the body)? GDB puts a breakpoint on a
   * loop-header line at the loop's entry code only (the golden lesson's own recorded hit counts: a breakpoint on a `while` line hit once per
   * loop entry, not once per condition evaluation), so such stops never hit the breakpoints of that line.
   * @param {number} idx
   */
  isLoopRevisit(idx) {
    const s = this.steps[idx];
    const sc = this.scopes.get(s.fn);
    const lp = sc && sc.loops.find((l) => l.start === s.line);
    if (!lp) return false;
    const p = this.prevInFrame[idx];
    const pl = p >= 0 ? this.steps[p].line : -1;
    return pl > lp.start && pl <= lp.end;
  }

  /** Address of the stop at step `idx` (start of a line, or of the increment code of a `for` line). @param {number} idx */
  stepAddr(idx) {
    let a = this.addrCache.get(idx);
    if (a === undefined) {
      const s = this.steps[idx];
      const fs = this.forSegment(idx);
      a = fs && fs.seg === "incr" ? this.lineAddr(s.fn, fs.end) + 0xc0 - Math.min(fs.depth, 8) * 0x10 : this.lineAddr(s.fn, s.line);
      this.addrCache.set(idx, a);
    }
    return a;
  }

  /** Return address of the call that created frame `calleeFrameId`, seen from the caller's step `callerStepIdx`. @param {number} callerStepIdx @param {number} calleeFrameId */
  retAddr(callerStepIdx, calleeFrameId) {
    return this.stepAddr(callerStepIdx) + 5 + 8 * (this.calleeOrd.get(calleeFrameId) || 0);
  }

  /** Pseudo stack address of a variable in a frame. @param {number} frameId @param {string} name */
  varAddr(frameId, name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return 0x7ffe00000000 + ((frameId & 0xffff) << 12) + ((h & 0xff) << 4);
  }

  /** Vector capacity for a value: top level from the pseudo variable, nested = length. @param {VarEntry} e */
  topCapacity(e) { return typeof e.capacity === "number" ? e.capacity : Array.isArray(e.raw) ? e.raw.length : 0; }
}

/** @param {any} cls */
function zeroFor(cls) {
  if (cls.kind === "ref") return zeroFor(cls.to);
  if (cls.kind === "array") return Array.from({ length: Math.max(cls.n, 0) }, () => zeroFor(classify(cls.elem)));
  if (cls.kind === "vector" || FLAT_CONTAINER_KINDS.has(cls.kind)) return [];
  if (cls.kind === "string") return "";
  return 0;
}

/**
 * Value string for a raw trace value of class `cls` (`capacity` used for the outermost vector).
 * @param {any} cls @param {any} raw @param {number} [capacity]
 * @returns {string}
 */
export function valueOf(cls, raw, capacity) {
  if (cls.kind === "ref") return valueOf(cls.to, raw, capacity);
  if (cls.kind === "array") return `[${cls.n}]`; // varobj value of a C array (GDB: "[N]")
  if (cls.kind === "vector") {
    const n = Array.isArray(raw) ? raw.length : 0;
    return `std::vector of length ${n}, capacity ${capacity === undefined ? n : capacity}`;
  }
  if (FLAT_CONTAINER_KINDS.has(cls.kind)) return containerHead(cls.kind, Array.isArray(raw) ? raw.length : 0);
  return formatScalar(cls, raw);
}
