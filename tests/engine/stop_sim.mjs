// Replays GDB execution commands on an engine trace (steps with line/fn/depth/frame), using the
// GDB stop semantics the trace is built for:
//   run       -> first stop at a breakpoint line
//   continue  -> next stop at a breakpoint line (any frame), else the program exits
//   next      -> next stop in the same or a shallower frame; deeper frames are stepped over
//                unless they hit a breakpoint
//   step      -> the very next stop (user code only: the engine never enters the standard library)
//   fast-forward (lesson `[fast @N]`) -> repeated `next` until (line, count) is reached, like the
//                UI's python loop in the golden sample
export class StopSim {
  /** @param {Array<{line:number, fn:string, depth:number}>} steps @param {number[]} bpLines */
  constructor(steps, bpLines) { this.s = steps; this.bps = new Set(bpLines); this.cur = -1; }
  stopAt(j, kind) {
    if (j >= this.s.length) { this.cur = this.s.length; return { kind: "exited-normally", line: null, func: null }; }
    this.cur = j;
    return { kind, line: this.s[j].line, func: this.s[j].fn };
  }
  run() { return this.continue(); }
  continue() {
    for (let j = this.cur + 1; j < this.s.length; j++) if (this.bps.has(this.s[j].line)) return this.stopAt(j, "breakpoint-hit");
    return this.stopAt(this.s.length);
  }
  next() {
    const d = this.s[this.cur].depth;
    let j = this.cur + 1;
    while (j < this.s.length && this.s[j].depth > d) { if (this.bps.has(this.s[j].line)) return this.stopAt(j, "breakpoint-hit"); j++; }
    return this.stopAt(j, "end-stepping-range");
  }
  step() { return this.stopAt(this.cur + 1, "end-stepping-range"); }
  fastForward({ line, count }, max = 5000) {
    const lines = [], counts = {};
    let r = null;
    for (let i = 0; i < max; i++) {
      r = this.next();
      if (r.kind === "exited-normally") break;
      lines.push(r.line);
      counts[r.line] = (counts[r.line] || 0) + 1;
      if (r.line === line && counts[line] >= count) return { ...r, lines, landed: true };
    }
    return { ...r, lines, landed: false };
  }
}
