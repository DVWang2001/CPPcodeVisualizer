// Breakpoint table + execution control over the recorded trace.
//
// Stepping semantics (decided from the trace, the same ones tests/engine/stop_sim.mjs uses for the
// golden cross-check, extended with GDB's return-to-caller landing and reverse execution):
//   continue  next enabled breakpoint step (condition true, ignore count spent) after the position, else the program ends
//   next      next step whose depth <= current depth; deeper steps are stepped over unless a breakpoint hits inside
//   step      the very next step (the engine never enters the standard library)
//   finish    run until the current frame returns; lands on the CALLER's call line (mid-statement, like GDB)
//   returning from a function by next/step stops on the NEXT line of the caller (verified against GDB 16.3); only finish stops mid-line
//   reverse-* walk the trace backwards (continue/next/step/finish); the trace start reports `no-history`
// A stop on a step whose line holds an enabled breakpoint is reported as breakpoint-hit (GDB does the same
// when a stepping command ends on a breakpoint location); landing mid-line on a call line is not.
// Plain ES module, no DOM / Node APIs.

import { evalExpr } from "../evalexpr.js";

/**
 * @typedef {{ number: number, type: "breakpoint", disp: "keep" | "del", enabled: boolean, line: number, fn: string, addr: number,
 *   times: number, cond: string | null, ignore: number, original: string, pending: string | null }} Breakpoint
 */

export class BreakpointTable {
  /** @param {import("./model.js").TraceModel} model */
  constructor(model) {
    this.model = model;
    /** @type {Breakpoint[]} */
    this.list = [];
    this.next = 1;
  }

  /** @param {number} n */
  get(n) { return this.list.find((b) => b.number === n) || null; }

  /**
   * Resolve a requested source line to a line that holds code (GDB moves to the next line with code).
   * @param {number} line @returns {{ line: number, fn: string } | null}
   */
  resolveLine(line) {
    const L = this.model.codeLines.find((l) => l >= line);
    if (L === undefined) return null;
    const step = this.model.steps.find((s) => s.line === L);
    return step ? { line: L, fn: step.fn } : null;
  }

  /** First stop line of a function (where `break fn` lands). @param {string} fn @returns {{ line: number, fn: string } | null} */
  resolveFunction(fn) {
    if (!Object.prototype.hasOwnProperty.call(this.model.functions, fn)) return null;
    const step = this.model.steps.find((s) => s.fn === fn);
    if (step) return { line: step.line, fn };
    return { line: this.model.functions[fn].line + 1, fn };
  }

  /**
   * @param {{ line: number | null, fn: string | null, temp?: boolean, disabled?: boolean, cond?: string | null, ignore?: number, original: string, pendingSpec?: string | null }} o
   * @returns {Breakpoint}
   */
  add(o) {
    /** @type {Breakpoint} */
    const b = {
      number: this.next++, type: "breakpoint", disp: o.temp ? "del" : "keep", enabled: !o.disabled,
      line: o.line === null ? -1 : o.line, fn: o.fn || "", addr: o.line === null ? 0 : this.model.addr(o.fn || "", o.line),
      times: 0, cond: o.cond || null, ignore: o.ignore || 0, original: o.original, pending: o.pendingSpec || null,
    };
    this.list.push(b);
    return b;
  }

  /** @param {number} n @returns {boolean} */
  remove(n) {
    const i = this.list.findIndex((b) => b.number === n);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  clear() { this.list = []; }

  /**
   * Breakpoints that stop the program at step `idx`: enabled, on that line, condition true, ignore count
   * spent. Hit counts are updated (GDB counts a hit when the condition is true, even if it is ignored).
   * @param {number} idx @returns {Breakpoint[]}
   */
  hitsAt(idx) {
    const s = this.model.steps[idx];
    /** @type {Breakpoint[]} */
    const stops = [];
    for (const b of this.list) {
      if (!b.enabled || b.pending || b.line !== s.line) continue;
      if (b.cond) {
        let ok = true;
        try { ok = !!evalExpr(b.cond, s.vars); } catch { ok = true; } // GDB stops when the condition cannot be evaluated
        if (!ok) continue;
      }
      b.times++;
      if (b.ignore > 0) { b.ignore--; continue; }
      stops.push(b);
    }
    return stops;
  }
}

/**
 * @typedef {{ kind: "breakpoint" | "step" | "finish" | "no-history" | "exit" | "signal", idx: number, hits: Breakpoint[],
 *   frameChanged: boolean }} StopInfo
 */

export class ExecState {
  /** @param {import("./model.js").TraceModel} model @param {BreakpointTable} bps */
  constructor(model, bps) {
    this.model = model;
    this.bps = bps;
    this.reset();
  }

  reset() {
    /** trace position (index of the current step); -1 before -exec-run, steps.length after exit */
    this.pos = -1;
    /** step index used for display (differs from pos right after returning to a caller) */
    this.disp = -1;
    this.landed = false;
    this.started = false;
    this.exited = false;
    this.signalPending = false;
    this.selectedLevel = 0;
  }

  get running() { return this.started && !this.exited; }
  get n() { return this.model.steps.length; }

  /** @returns {StopInfo} */
  _exit() {
    const abnormal = this.model.exit.reason !== "exit";
    if (abnormal && !this.signalPending && this.n > 0) {
      this.signalPending = true;
      this.pos = this.n - 1; this.disp = this.pos; this.landed = false;
      return { kind: "signal", idx: this.pos, hits: [], frameChanged: false };
    }
    this.exited = true; this.pos = this.n; this.disp = this.n; this.landed = false; this.signalPending = false;
    return { kind: "exit", idx: this.n, hits: [], frameChanged: false };
  }

  /** @param {number} idx @param {StopInfo["kind"]} kind @param {Breakpoint[]} [hits] @returns {StopInfo} */
  _stopAt(idx, kind, hits = []) {
    const S = this.model.steps;
    const prevFn = this.disp >= 0 && this.disp < S.length ? S[this.disp].frame : -1;
    this.pos = idx; this.disp = idx; this.landed = false; this.selectedLevel = 0;
    return { kind: hits.length ? "breakpoint" : kind, idx, hits, frameChanged: prevFn !== S[idx].frame };
  }

  /** Land on the caller's call line after frame `frameId` returned. @param {number} frameId @returns {StopInfo} */
  _landInCaller(frameId, kind = /** @type {const} */ ("step")) {
    const f = /** @type {any} */ (this.model.frames.get(frameId));
    this.pos = f.last; this.disp = f.callerStep; this.landed = true; this.selectedLevel = 0;
    return { kind, idx: f.callerStep, hits: [], frameChanged: true };
  }

  /** Run start: first breakpoint hit or program end. @returns {StopInfo} */
  run() {
    this.reset();
    for (const b of this.bps.list) b.times = 0; // GDB clears hit counts when the program is (re)started
    this.started = true;
    return this.forward("continue");
  }

  /**
   * @param {"continue" | "next" | "step" | "finish"} how
   * @returns {StopInfo | { error: string }}
   */
  forward(how) {
    if (!this.running) return { error: "The program is not being run." };
    if (this.signalPending) return this._exit();
    const S = this.model.steps;
    const pos = this.pos;
    const dispIdx = this.landed ? this.disp : pos;
    const dRef = pos >= 0 ? S[dispIdx].depth : 0;
    const startIdx = pos + 1;
    if (how === "finish") {
      if (pos < 0) return { error: "The program is not being run." };
      const ch = this.model.chain(dispIdx);
      const sel = ch[Math.min(this.selectedLevel, ch.length - 1)]; // GDB finishes the SELECTED frame
      if (sel.depth <= 1) return { error: '"finish" not meaningful in the outermost frame.' };
      const F = sel.frameId;
      const fr = /** @type {any} */ (this.model.frames.get(F));
      for (let i = startIdx; i <= fr.last; i++) {
        const h = this.bps.hitsAt(i);
        if (h.length) return this._stopAt(i, "step", h);
      }
      if (fr.last >= this.n - 1 && this.model.exit.reason !== "exit") return this._exit();
      return this._landInCaller(F, "finish");
    }
    for (let i = startIdx; i < this.n; i++) {
      const h = this.bps.hitsAt(i);
      if (h.length) return this._stopAt(i, "step", h);
      if (how === "continue") continue;
      if (how === "step" || S[i].depth <= dRef) {
        return this._stopAt(i, "step");
      }
    }
    return this._exit();
  }

  /**
   * Reverse execution.
   * @param {"continue" | "next" | "step" | "finish"} how
   * @returns {StopInfo | { error: string }}
   */
  backward(how) {
    if (!this.running || this.pos < 0) return { error: "The program is not being run." };
    const S = this.model.steps;
    const base = this.landed ? this.disp : this.pos;
    const dRef = S[base].depth;
    if (how === "finish") {
      if (dRef <= 1) return { error: '"finish" not meaningful in the outermost frame.' };
      const f = /** @type {any} */ (this.model.frames.get(S[base].frame));
      return this._stopAt(f.callerStep, "step");
    }
    for (let i = base - 1; i >= 0; i--) {
      const h = this.bps.hitsAt(i);
      if (h.length) return this._stopAt(i, "step", h);
      if (how === "continue") continue;
      if (how === "step" || S[i].depth <= dRef) return this._stopAt(i, "step");
    }
    const r = this._stopAt(0, "no-history");
    r.kind = "no-history";
    return r;
  }
}
