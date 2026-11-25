// LocalGdb session: the GDB/MI conversation the gdbgui UI expects, answered from a recorded engine
// trace (see README.md). Commands are processed strictly FIFO (spec §4); every `run_gdb_command`
// produces one `gdb_response` packet whose items follow the golden sample's shapes.
// Plain ES module, no DOM / Node APIs.

import { parseCommand, splitArgs, resultItem, errorItem, notifyItem, consoleItem, logItem, outputItem, doneItem, unsupportedMsg, hex16 } from "./mi.js";
import { TraceModel, printEntry } from "./model.js";
import { BreakpointTable, ExecState } from "./exec.js";
import { VarObjs } from "./varobj.js";
import { isSimple } from "./types.js";
import { parseFastForward, pyJson } from "./fastforward.js";
import { chainAt } from "./scopes.js";
import { afterStates } from "./afterState.js";
import { findCellLastWrite } from "./cellWrite.js";

/** Features of the golden sample's GDB 16.3 plus "reverse" (spec §12 N3: enables the reverse UI). */
export const FEATURES = [
  "frozen-varobjs", "pending-breakpoints", "thread-info", "data-read-memory-bytes", "breakpoint-notifications", "ada-task-info",
  "language-option", "info-gdb-mi-command", "undefined-command-error-code", "exec-run-start-option", "data-disassemble-a-option",
  "simple-values-ref-types", "python", "reverse",
];

const BREAK_HDR = [
  { width: "7", alignment: "-1", col_name: "number", colhdr: "Num" },
  { width: "14", alignment: "-1", col_name: "type", colhdr: "Type" },
  { width: "4", alignment: "-1", col_name: "disp", colhdr: "Disp" },
  { width: "3", alignment: "-1", col_name: "enabled", colhdr: "Enb" },
  { width: "18", alignment: "-1", col_name: "addr", colhdr: "Address" },
  { width: "40", alignment: "2", col_name: "what", colhdr: "What" },
];

const SIGNALS = {
  abort: ["SIGABRT", "Aborted"], memory: ["SIGSEGV", "Segmentation fault"], "div-zero": ["SIGFPE", "Arithmetic exception"],
  other: ["SIGSEGV", "Segmentation fault"], timeout: ["SIGXCPU", "CPU time limit exceeded"], "stack-overflow": ["SIGSEGV", "Segmentation fault"],
  illegal: ["SIGILL", "Illegal instruction"], "step-limit": ["SIGKILL", "Killed"], "trace-limit": ["SIGKILL", "Killed"],
};

/** MI commands that exist in GDB but are outside the browser engine's scope (explicit error, never fake data). */
const KNOWN_UNSUPPORTED = new Set([
  "-exec-next-instruction", "-exec-step-instruction", "-exec-until", "-exec-return", "-exec-jump", "-exec-signal",
  "-data-list-register-names", "-data-list-register-values", "-data-list-changed-registers", "-data-read-memory", "-data-read-memory-bytes",
  "-data-write-memory-bytes", "-data-disassemble", "-target-select", "-target-attach", "-target-detach", "-break-watch", "-break-passcount",
  "-break-after", "-catch-throw", "-catch-catch", "-file-list-exec-source-files", "-file-list-exec-source-file", "-symbol-list-lines",
  "-var-assign", "-var-set-format", "-var-set-frozen", "-var-set-update-range", "-var-show-format", "-var-info-num-children",
  "-var-info-path-expression", "-var-info-expression", "-var-show-attributes", "-data-evaluate-memory",
]);

/**
 * @typedef {{
 *   source: string, stdin?: string, runResult: any, sourcePath: string, gdbFilePath: string, pid?: number,
 *   now?: () => number, recordSubcommands?: boolean,
 * }} SessionOptions
 */

export class LocalGdbSession {
  /**
   * @param {SessionOptions} opts
   * @param {(event: string, payload: any) => void} out  delivers a server->client socket event
   */
  constructor(opts, out) {
    if (!opts || !opts.runResult || !Array.isArray(opts.runResult.steps)) throw new Error("createLocalGdb: runResult (result of runProgram) is required");
    if (opts.runResult.ok === false) throw new Error("createLocalGdb: runResult.ok is false; only a successful run can be debugged");
    this.opts = opts;
    this.out = out;
    this.sourcePath = opts.sourcePath || "/workspace/main.cpp";
    this.gdbFilePath = opts.gdbFilePath || this.sourcePath;
    this.pid = opts.pid || 4242;
    this.now = opts.now || (() => 0);
    this.model = new TraceModel({ ...opts.runResult, source: opts.source });
    this.bps = new BreakpointTable(this.model);
    // display "after" (opts.display): frame 0 shows the state after the highlighted line ran; see ExecState.viewOf
    this.exec = new ExecState(this.model, this.bps, { after: opts.display === "after", callEntryLines: opts.callEntryLines });
    this.vars = new VarObjs(/** @type {any} */ ({ model: this.model, exec: this.exec }));
    this.seq = 0;
    this.lastRequestId = 0;
    /** @type {string | null} */
    this.runToken = null;
    /** @type {Array<{ cmds: string[], requestId: number | null }>} */
    this.queue = [];
    this.draining = false;
    this.stdinReceived = "";
    this.stdinFlushes = 0;
    this.record = !!opts.recordSubcommands;
    /** @type {Array<{ command: string, items: any[] }>} */
    this.subcommandLog = [];
    /** @type {Array<[string, any]>} events to deliver after the current gdb_response packet */
    this.after = [];
    this.stdoutDelivered = false;
  }

  // ---- socket-facing -------------------------------------------------------------------------

  /** @param {any} payload */
  onRunGdbCommand(payload) {
    if (!payload || typeof payload !== "object") return this.out("error_running_gdb_command", { message: "run_gdb_command: payload must be an object" });
    let cmds = payload.cmd;
    if (typeof cmds === "string") cmds = [cmds];
    if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== "string")) {
      return this.out("error_running_gdb_command", { message: "run_gdb_command: `cmd` must be a string or an array of strings" });
    }
    const tok = payload.run_token === undefined ? null : payload.run_token;
    if (tok !== null && this.runToken !== null && tok !== this.runToken) return; // stale run_token: silently dropped (spec §4)
    const rid = Number.isFinite(payload.request_id) ? payload.request_id : null;
    if (rid !== null) this.lastRequestId = rid;
    this.queue.push({ cmds, requestId: rid, runToken: tok });
    this._schedule();
  }

  /** @param {any} payload */
  onPtyInteraction(payload) {
    const d = payload && payload.data;
    if (!d || typeof d !== "object") return this.out("error_running_gdb_command", { message: "pty_interaction: payload.data is required" });
    if (d.pty_name === "program_pty") {
      if (d.action === "flush") this.stdinFlushes++;
      else if (d.action === "write") this.stdinReceived += String(d.key === undefined ? "" : d.key);
      // set_winsize: nothing to do
    } else if (d.pty_name === "user_pty" && d.action === "write") {
      this.out("user_pty_response", `\r\n${unsupportedMsg("GDB console input")}\r\n`);
    }
  }

  _schedule() {
    if (this.draining) return;
    this.draining = true;
    Promise.resolve().then(() => this._drain());
  }

  _drain() {
    while (this.queue.length) {
      const job = /** @type {any} */ (this.queue.shift());
      let items = [];
      for (const c of job.cmds) {
        let it;
        try { it = this.dispatch(c); } catch (e) { it = [errorItem("internal error: " + (e && /** @type {any} */ (e).message), parseCommand(c).token)]; }
        if (this.record) this.subcommandLog.push({ command: c, items: it, ctx: { uninit: this.uninitNames(), declLater: this.hasStack() ? this.model.visibleVars(this.topStep()).filter((e) => e.declLine > this.model.steps[this.topStep()].line).map((e) => e.name) : [], entries: this.hasStack() ? this.model.visibleVars(this.topStep()).map((e) => ({ name: e.name, present: e.present, declLine: e.declLine, uninit: e.uninit })) : [], stepIdx: this.hasStack() ? this.topStep() : -1, line: this.hasStack() ? this.model.steps[this.topStep()].line : -1 } });
        items = items.concat(it);
      }
      this.out("gdb_response", { run_token: job.runToken, request_id: this.lastRequestId, packet_seq_num: ++this.seq, data: items });
      // S4: a side event (not part of gdb_response, so the golden protocol is unchanged): what the line at
      // the stop we just reached did — variables it changed and the output it printed (S3 after-state).
      if (this.hasStack() && items.some((x) => x && x.type === "notify" && x.message === "stopped")) {
        let la = this.lineAfterOf(this.topStep());
        // display "after": `view` says what the panels show at this stop ("after", "call": a [step-in] line at the moment of
        // its call, "end": the line's own state) — see ExecState.viewOf
        const v = this.exec.afterView ? this.exec.viewOf(this.exec.dispStep(), this.exec.landed) : null;
        // the panels show the whole line's result there, callees included: so does the line's printed output (S3 cuts it
        // at the very next stop, which for a call line is the callee's first stop)
        if (la && v && v.kind === "after") la = { ...la, ...this.outputBetween(this.exec.dispStep(), v.idx) };
        const view = v ? { view: v.kind } : {};
        if (la) this.after.push(["vg_line_after", { run_token: job.runToken, request_id: this.lastRequestId, ...la, ...view }]);
        // D3: the program's output up to the state shown, replacing the output pane (only when it changed)
        if (this.exec.afterView) {
          const text = this.programOutputShown();
          if (text !== null && text !== this._outputSent) {
            this._outputSent = text;
            this.after.push(["vg_program_output", { run_token: job.runToken, text }]);
          }
        }
      }
      const after = this.after;
      this.after = [];
      for (const [ev, p] of after) this.out(ev, p);
    }
    this.draining = false;
  }

  /**
   * S4: the after-state of the stop at step index `idx` (computed once per run from the engine result).
   * @param {number} idx
   */
  lineAfterOf(idx) {
    const r = this.opts.runResult;
    if (!r || !Array.isArray(r.stepOffsets)) return null;
    if (!this._afterCache) {
      const enc = new TextEncoder();
      this._afterCache = afterStates({ steps: r.steps, stepOffsets: r.stepOffsets, stdout: enc.encode(r.stdout || ""), stderr: enc.encode(r.stderr || ""), exit: r.exit || null, next: this.model.nextInFrame });
    }
    return this._afterCache[idx] || null;
  }

  /** Names of the frame-0 variables whose value is not initialised yet (test/diagnostic aid). @returns {string[]} */
  uninitNames() {
    return this.hasStack() ? this.model.visibleVars(this.topStep()).filter((e) => e.uninit).map((e) => e.name) : [];
  }

  /** Resolves when every queued command has been answered. */
  async idle() { while (this.draining || this.queue.length) await Promise.resolve(); }

  // ---- dispatch ------------------------------------------------------------------------------

  /** @param {string} raw @returns {any[]} */
  dispatch(raw) {
    const c = parseCommand(raw);
    const t = c.token;
    if (!c.mi) return this.cli(c);
    switch (c.name) {
      case "-list-features": return [resultItem({ features: FEATURES.slice() }, t)];
      case "-list-target-features": return [resultItem({ features: [] }, t)];
      case "-gdb-set": case "-file-exec-and-symbols": case "-exec-arguments": case "-enable-pretty-printing": case "-environment-cd":
        return [doneItem(t)];
      case "-interpreter-exec": return this.interpreterExec(c);
      case "-break-insert": return this.breakInsert(c);
      case "-break-list": return [resultItem(this.breakTable(), t)];
      case "-break-delete": return this.breakEach(c, (b) => { this.bps.remove(b.number); return [notifyItem("breakpoint-deleted", { id: String(b.number) })]; });
      case "-break-enable": return this.breakEach(c, (b) => { b.enabled = true; return [notifyItem("breakpoint-modified", { bkpt: this.bkpt(b) })]; });
      case "-break-disable": return this.breakEach(c, (b) => { b.enabled = false; return [notifyItem("breakpoint-modified", { bkpt: this.bkpt(b) })]; });
      case "-break-condition": return this.breakCondition(c);
      case "-exec-run": return this.execRun(c);
      case "-exec-continue": return this.execMove(c, "continue");
      case "-exec-next": return this.execMove(c, "next");
      case "-exec-step": return this.execMove(c, "step");
      case "-exec-finish": return this.execMove(c, "finish");
      case "-vg-seek-step": return this.vgSeekStep(c);
      case "-vg-cell-last-write": return this.vgCellLastWrite(c);
      case "-exec-interrupt": return [errorItem("Current thread is not running.", t)];
      case "-thread-info": return [resultItem(this.threadInfo(), t)];
      case "-thread-select": return splitArgs(c.rest)[0] && splitArgs(c.rest)[0].value === "1" ? [resultItem({ "new-thread-id": "1", frame: this.frameRec(this.exec.selectedLevel, "scalars", true) }, t)] : [errorItem("Invalid thread id: " + c.rest, t)];
      case "-stack-list-frames": return this.stackListFrames(c);
      case "-stack-list-variables": return this.stackListVariables(c);
      case "-stack-list-arguments": return this.stackListArguments(c);
      case "-stack-select-frame": return this.stackSelectFrame(c);
      case "-stack-info-depth": return this.hasStack() ? [resultItem({ depth: String(this.frames().length) }, t)] : [errorItem("No stack.", t)];
      case "-var-create": return this.varCreate(c);
      case "-var-list-children": return this.varListChildren(c);
      case "-var-delete": return this.varDelete(c);
      case "-var-update": return this.varUpdate(c);
      case "-var-evaluate-expression": { const a = splitArgs(c.rest).filter((x) => !x.value.startsWith("-")); return a[0] ? [this.vars.evaluateVar(a[0].value, t)] : [errorItem("-var-evaluate-expression: Usage: NAME", t)]; }
      case "-var-info-type": { const a = splitArgs(c.rest); return a[0] ? [this.vars.info(a[0].value, t)] : [errorItem("-var-info-type: Usage: NAME", t)]; }
      case "-data-evaluate-expression": return [this.vars.evaluate(splitArgs(c.rest).map((x) => x.value).join(" "), t)];
      default:
        if (KNOWN_UNSUPPORTED.has(c.name)) return [errorItem(unsupportedMsg(`MI command ${c.name}`), t)];
        return [errorItem(`Undefined MI command: ${c.name.slice(1)}`, t, { code: "undefined-command" })];
    }
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  cli(c) {
    if (c.name === "python") {
      const ff = parseFastForward(c.raw);
      if (ff) return this.fastForward(c.raw, ff);
      return [errorItem(unsupportedMsg("python (only the [fast @N] jump script is recognised)"), c.token)];
    }
    if (c.name === "kill" && !c.rest.trim()) return this.kill(c.token);
    return [errorItem(unsupportedMsg(`CLI command '${c.name}'`), c.token)];
  }

  /** GDB's `kill` of a live inferior: console line, thread/group exit notifications, `^done`; afterwards "no process". @param {any} token */
  kill(token) {
    if (!this.exec.running) return [errorItem("The program is not being run.", token)];
    this.exec.reset();
    return [
      consoleItem(`[Inferior 1 (process ${this.pid}) killed]\n`),
      notifyItem("thread-exited", { id: "1", "group-id": "i1" }),
      notifyItem("thread-group-exited", { id: "i1" }),
      doneItem(token),
    ];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  interpreterExec(c) {
    const args = splitArgs(c.rest);
    const inner = (args[1] ? args[1].value : "").trim();
    if (!args[0] || args[0].value !== "console" || !args[1]) return [errorItem(unsupportedMsg("-interpreter-exec other than console"), c.token)];
    if (inner === "kill") return this.kill(c.token);
    if (inner === "delete") { this.bps.clear(); return [doneItem(c.token)]; }
    if (inner === "unset substitute-path") return [consoleItem("Delete all source path substitution rules? (y or n) [answered Y; input not from terminal]\n"), doneItem(c.token)];
    if (/^set substitute-path\b/.test(inner)) return [doneItem(c.token)];
    return [errorItem(unsupportedMsg(`CLI command '${inner}'`), c.token)];
  }

  // ---- frames / stack ------------------------------------------------------------------------

  hasStack() { return this.exec.running && this.exec.pos >= 0; }
  /** display step index of frame 0 */
  topStep() { return this.exec.landed ? this.exec.disp : this.exec.pos; }
  /** step whose recorded values frame 0 shows (display "after": the state after the highlighted line ran) */
  viewStep() { return this.exec.viewStep(); }
  frames() { return this.hasStack() ? this.model.chain(this.topStep()) : []; }

  /**
   * Variables of stack level `level` whose step is `stepIdx`: level 0 is valued at the view step in display "after".
   * @param {number} stepIdx @param {number} level
   */
  levelVars(stepIdx, level) {
    if (!this.exec.afterView) return this.model.visibleVars(stepIdx);
    const view = this.viewStep();
    return level === 0 && view !== stepIdx ? this.model.visibleVarsView(stepIdx, view, view) : this.model.visibleVars(stepIdx, view);
  }

  /** GDB `value` string of a variable entry. @param {import("./model.js").VarEntry} e */
  entryValue(e) { return printEntry(this.model, e); }

  /**
   * Frame record as GDB prints it.
   * @param {number} level @param {"none" | "scalars" | "all"} argMode @param {boolean} withLevel
   */
  frameRec(level, argMode, withLevel) {
    const f = this.frames()[level];
    if (!f) return null;
    const addr = this.frameAddr(level);
    /** @type {any} */
    const o = {};
    if (withLevel) o.level = String(level);
    o.addr = hex16(addr);
    o.func = this.model.dn(f.fn);
    if (argMode !== "none") o.args = this.frameArgs(f.stepIdx, argMode, level);
    o.file = this.gdbFilePath;
    o.fullname = this.sourcePath;
    o.line = String(f.line);
    o.arch = "i386:x86-64";
    return o;
  }

  /** Pseudo pc of stack level `level`: stop address at level 0 (return address right after `finish`), return addresses above. @param {number} level */
  frameAddr(level) {
    const ch = this.frames();
    const f = ch[level];
    if (level > 0) return this.model.retAddr(f.stepIdx, ch[level - 1].frameId);
    if (this.exec.landed) return this.model.retAddr(f.stepIdx, this.model.steps[this.exec.pos].frame);
    return this.model.stepAddr(f.stepIdx);
  }

  /** @param {number} stepIdx @param {"scalars" | "all"} mode @param {number} [level] stack level of that step (0 = innermost) */
  frameArgs(stepIdx, mode, level = -1) {
    return this.levelVars(stepIdx, level).filter((e) => e.isArg).map((e) => ({ name: e.name, value: mode === "scalars" && !isSimple(e.cls) ? "..." : this.entryValue(e) }));
  }

  threadInfo() {
    if (!this.hasStack()) return { threads: [] };
    return {
      threads: [{ id: "1", "target-id": `Thread 0x7f0000000000 (LWP ${this.pid})`, name: "main", frame: this.frameRec(0, "scalars", true), state: "stopped", core: "0" }],
      "current-thread-id": "1",
    };
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  stackListFrames(c) {
    if (!this.hasStack()) return [errorItem("No stack.", c.token)];
    const nums = splitArgs(c.rest).filter((a) => /^\d+$/.test(a.value)).map((a) => Number(a.value));
    const all = this.frames();
    const lo = nums.length >= 2 ? nums[0] : 0, hi = nums.length >= 2 ? nums[1] : all.length - 1;
    const stack = [];
    for (let l = lo; l <= Math.min(hi, all.length - 1); l++) stack.push(this.frameRec(l, "none", true));
    return [resultItem({ stack }, c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  stackListVariables(c) {
    if (!this.hasStack()) return [errorItem("No frame selected.", c.token)];
    const a = splitArgs(c.rest).map((x) => x.value);
    const mode = a.includes("--all-values") ? "all" : a.includes("--simple-values") ? "simple" : "none";
    const f = this.frames()[Math.min(this.exec.selectedLevel, this.frames().length - 1)];
    // display "after": level 0 lists the highlighted line's variables valued after the line ran (TraceModel.visibleVarsView)
    const view = this.viewStep();
    const ents = this.exec.afterView && f.level === 0 && view !== f.stepIdx ? this.model.visibleVarsView(f.stepIdx, view, view) : this.model.visibleVars(f.stepIdx, this.exec.afterView ? view : this.topStep());
    const variables = ents.map((e) => {
      /** @type {any} */
      const o = { name: e.name };
      if (e.isArg) o.arg = "1";
      o.type = e.gdbType;
      if (mode === "all" || (mode === "simple" && isSimple(e.cls))) o.value = this.entryValue(e);
      return o;
    });
    return [resultItem({ variables }, c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  stackListArguments(c) {
    if (!this.hasStack()) return [errorItem("No stack.", c.token)];
    const a = splitArgs(c.rest).map((x) => x.value).filter((x) => !x.startsWith("--"));
    const pv = a[0] === "1" || a[0] === "--all-values" ? 1 : a[0] === "2" || a[0] === "--simple-values" ? 2 : 0;
    const nums = a.slice(1).filter((x) => /^\d+$/.test(x)).map(Number);
    const all = this.frames();
    const lo = nums.length >= 2 ? nums[0] : 0, hi = nums.length >= 2 ? nums[1] : all.length - 1;
    const out = [];
    for (let l = lo; l <= Math.min(hi, all.length - 1); l++) {
      const args = this.levelVars(all[l].stepIdx, l).filter((e) => e.isArg).map((e) => (pv === 0 ? { name: e.name } : pv === 2 && !isSimple(e.cls) ? { name: e.name } : { name: e.name, value: this.entryValue(e) }));
      out.push({ level: String(l), args });
    }
    return [resultItem({ "stack-args": out }, c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  stackSelectFrame(c) {
    if (!this.hasStack()) return [errorItem("No stack.", c.token)];
    const n = Number(splitArgs(c.rest)[0] ? splitArgs(c.rest)[0].value : NaN);
    if (!Number.isInteger(n) || n < 0 || n >= this.frames().length) return [errorItem("Invalid frame level: " + c.rest, c.token)];
    this.exec.selectedLevel = n;
    return [doneItem(c.token)];
  }

  // ---- breakpoints ---------------------------------------------------------------------------

  /** @param {import("./exec.js").Breakpoint} b */
  bkpt(b) {
    /** @type {any} */
    const o = { number: String(b.number), type: "breakpoint", disp: b.disp, enabled: b.enabled ? "y" : "n" };
    if (b.pending) {
      o.addr = "<PENDING>"; o.pending = b.pending; o.times = String(b.times); o["original-location"] = b.original;
      return o;
    }
    o.addr = hex16(b.addr);
    o.func = this.model.signature(b.fn);
    o.file = this.gdbFilePath;
    o.fullname = this.sourcePath;
    o.line = String(b.line);
    if (b.cond) o.cond = b.cond;
    o["thread-groups"] = ["i1"];
    o.times = String(b.times);
    if (b.ignore) o.ignore = String(b.ignore);
    o["original-location"] = b.original;
    return o;
  }

  breakTable() {
    const body = this.bps.list.map((b) => this.bkpt(b));
    return { BreakpointTable: { nr_rows: String(body.length), nr_cols: "6", hdr: BREAK_HDR.map((h) => ({ ...h })), body } };
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  breakInsert(c) {
    const args = splitArgs(c.rest);
    let temp = false, pending = false, disabled = false, cond = null, ignore = 0, loc = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.quoted && a.value === "-t") temp = true;
      else if (!a.quoted && a.value === "-f") pending = true;
      else if (!a.quoted && a.value === "-d") disabled = true;
      else if (!a.quoted && a.value === "-h") { /* hardware: same to us */ }
      else if (!a.quoted && a.value === "-c") cond = args[++i] ? args[i].value : null;
      else if (!a.quoted && a.value === "-i") ignore = Number(args[++i] ? args[i].value : 0) || 0;
      else if (!a.quoted && (a.value === "-p" || a.value === "--thread")) i++;
      else if (!a.quoted && a.value === "--") continue;
      else loc = a.value;
    }
    if (loc === null) return [errorItem("-break-insert: Usage: [-t] [-h] [-f] [-d] [-a] [-c CONDITION] [-i IGNORE-COUNT] [-p THREAD-ID] [LOCATION]", c.token)];
    if (loc.startsWith("*")) return [errorItem(unsupportedMsg("breakpoints at raw addresses"), c.token)];
    const m = /^(?:(.*):)?(\d+)$/.exec(loc);
    const fm = /^(?:([^:\s]+\.\w+):)?((?:[A-Za-z_]\w*::)*(?:~?[A-Za-z_]\w*|operator\s*[^\s(]+))$/.exec(loc);
    /** @type {{ line: number, fn: string } | null} */
    let at = null;
    let err = null;
    const fileOk = (/** @type {string | undefined} */ f) => !f || this.baseName(f) === this.baseName(this.gdbFilePath) || this.baseName(f) === this.baseName(this.sourcePath);
    if (m) {
      if (!fileOk(m[1])) err = `No source file named ${m[1]}.`;
      else { at = this.bps.resolveLine(Number(m[2])); if (!at) err = `No line ${m[2]} in ${m[1] ? `file "${m[1]}"` : "the current file"}.`; }
    } else if (fm) {
      if (!fileOk(fm[1])) err = `No source file named ${fm[1]}.`;
      else { at = this.bps.resolveFunction(fm[2]); if (!at) err = `Function "${fm[2]}" not defined${fm[1] ? ` in "${fm[1]}"` : ""}.`; }
    } else err = `Function "${loc}" not defined.`;
    if (!at) {
      if (!pending) return [errorItem(err + (m || fm ? ' Make breakpoint pending on future shared library load? (y or [n]) [answered N; input not from terminal]' : ""), c.token)];
      const b = this.bps.add({ line: null, fn: null, temp, disabled, cond, ignore, original: loc, pendingSpec: loc });
      return [resultItem({ bkpt: this.bkpt(b) }, c.token)];
    }
    const b = this.bps.add({ line: at.line, fn: at.fn, temp, disabled, cond, ignore, original: loc });
    return [resultItem({ bkpt: this.bkpt(b) }, c.token)];
  }

  /** @param {string} p */
  baseName(p) { return p.split(/[\\/]/).pop() || p; }

  /** @param {ReturnType<typeof parseCommand>} c @param {(b: import("./exec.js").Breakpoint) => any[]} fn */
  breakEach(c, fn) {
    const nums = splitArgs(c.rest).filter((a) => !a.value.startsWith("-"));
    if (!nums.length) return [errorItem(`${c.name}: Usage: ${c.name} BREAKPOINT [BREAKPOINT...]`, c.token)];
    /** @type {any[]} */
    const items = [];
    for (const a of nums) {
      const b = /^\d+$/.test(a.value) ? this.bps.get(Number(a.value)) : null;
      if (!b) return [...items, errorItem(`Bad breakpoint argument: '${a.value}'`, c.token)];
      items.push(...fn(b));
    }
    return [...items, doneItem(c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  breakCondition(c) {
    const args = splitArgs(c.rest);
    const b = args[0] && /^\d+$/.test(args[0].value) ? this.bps.get(Number(args[0].value)) : null;
    if (!b) return [errorItem(args[0] ? `Bad breakpoint argument: '${args[0].value}'` : "-break-condition: Usage: -break-condition BREAKPOINT [EXPRESSION]", c.token)];
    const expr = args.slice(1).map((a) => a.value).join(" ").trim();
    b.cond = expr === "" ? null : expr;
    return [notifyItem("breakpoint-modified", { bkpt: this.bkpt(b) }), doneItem(c.token)];
  }

  // ---- execution -----------------------------------------------------------------------------

  /** @param {ReturnType<typeof parseCommand>} c */
  execRun(c) {
    const items = [notifyItem("thread-group-started", { id: "i1", pid: String(this.pid) }), notifyItem("thread-created", { id: "1", "group-id": "i1" })];
    const info = this.exec.run();
    return items.concat(this.stopItems(/** @type {any} */ (info), "run"));
  }

  /** @param {ReturnType<typeof parseCommand>} c @param {"continue" | "next" | "step" | "finish"} how */
  execMove(c, how) {
    const args = splitArgs(c.rest).map((a) => a.value);
    const reverse = args.includes("--reverse");
    const header = how === "finish" && this.hasStack() ? this.runTillExit(reverse) : null; // printed for the frame we start in
    const info = reverse ? this.exec.backward(how) : this.exec.forward(how);
    if ("error" in info) return [errorItem(info.error, c.token)];
    return (header ? [consoleItem(header)] : []).concat(this.stopItems(info, how));
  }

  /** @param {boolean} reverse */
  runTillExit(reverse) {
    const ch = this.frames();
    const f = ch[Math.min(this.exec.selectedLevel, ch.length - 1)];
    return `${reverse ? "Run back to call of" : "Run till exit from"} #${f ? f.level : 0}  ${f ? `${this.model.dn(f.fn)} (${this.frameArgsText(f.stepIdx, f.level)}) at ${this.gdbFilePath}:${f.line}` : ""}\n`;
  }

  /** `-vg-seek-step INDEX`: jump to trace step INDEX; answers like a step stop (live-quiz "jump to the step that filled this cell"). @param {ReturnType<typeof parseCommand>} c */
  vgSeekStep(c) {
    if (!this.exec.running) return [errorItem("The program is not being run.", c.token)];
    const a = splitArgs(c.rest);
    const idx = a.length === 1 && /^\d+$/.test(a[0].value) ? Number(a[0].value) : -1;
    if (idx < 0 || idx >= this.model.steps.length) return [errorItem(`-vg-seek-step: step index out of range (0..${this.model.steps.length - 1}): ${c.rest}`, c.token)];
    this.exec.signalPending = false;
    return this.stopItems(this.exec._stopAt(idx, "step"), "step");
  }

  /** `-vg-cell-last-write VAR ROW COL [BEFORE]` -> `^done,step,line,how` (see cellWrite.js). @param {ReturnType<typeof parseCommand>} c */
  vgCellLastWrite(c) {
    const usage = "-vg-cell-last-write: Usage: VAR ROW COL [BEFORE-STEP]";
    if (!this.hasStack()) return [errorItem("The program is not being run.", c.token)];
    const a = splitArgs(c.rest).map((x) => x.value);
    if (a.length < 3 || a.length > 4 || !/^[A-Za-z_]\w*$/.test(a[0]) || !a.slice(1).every((x) => /^\d+$/.test(x))) return [errorItem(usage, c.token)];
    const [row, col] = [Number(a[1]), Number(a[2])];
    // BEFORE is the stop the player was on; display "after" showed the cells as of that stop's view step (ExecState.viewOf),
    // so the writes of the stop's own line count too
    const before = a[3] === undefined ? this.viewStep() : this.exec.viewOf(Number(a[3])).idx;
    const g = this.model.steps[Math.min(before, this.model.steps.length - 1)].vars[a[0]];
    if (!Array.isArray(g) || !Array.isArray(g[0])) return [errorItem(`${a[0]} is not a visible 2-D container at step ${before}`, c.token)];
    const r = findCellLastWrite(this, a[0], row, col, before);
    return [r ? resultItem({ step: String(r.step), line: String(r.line), how: r.how }, c.token) : errorItem(`no step before ${before} wrote ${a[0]}[${row}][${col}]`, c.token)];
  }

  /** @param {number} stepIdx @param {number} [level] stack level of that step (the console lines name the innermost frame) */
  frameArgsText(stepIdx, level = 0) {
    return this.frameArgs(stepIdx, "scalars", level).map((a) => `${a.name}=${a.value}`).join(", ");
  }

  /**
   * Items of a stop caused by a resume command (GDB/MI async records around `^running`).
   * @param {import("./exec.js").StopInfo} info @param {string} how
   * @param {{ cli?: boolean, noRunning?: boolean }} [o] cli: the stop is printed by a CLI `next` (python) instead of MI
   */
  stopItems(info, how, o = {}) {
    /** @type {any[]} */
    const items = [];
    if (!o.noRunning) items.push(outputItem("^running\r"));
    items.push(notifyItem("running", { "thread-id": "all" }));
    // `for-seg`: on a stop at a `for` header, whether it is the loop-entry (init) or the increment stop. The UI's A/C
    // split used to infer this from "the smallest address seen so far for that line", which labels an increment stop as
    // init whenever the init stop was never observed (a breakpoint inside the loop, `continue` over the header) — the
    // header then showed `i = 0` instead of `i++` then `i < n`. The model knows the truth, so hand it over.
    const frame = () => {
      const o = this.frameRec(0, "scalars", false);
      const fs = o && this.model.forSegment(this.topStep());
      if (o && fs) o["for-seg"] = fs.seg;
      return o;
    };
    const tail = { "thread-id": "1", "stopped-threads": "all", core: "0" };
    // runtime errors (runResult.runtimeErrors): the signal stop of a fatal one points at it; any other stop on a step
    // where an error happened carries the first error of that step
    const ex = /** @type {any} */ (this.model.exit);
    const errIdx = info.kind === "signal" && Number.isInteger(ex.runtimeError) ? ex.runtimeError : info.kind === "exit" ? -1 : this.model.errorAt.get(info.idx) ?? -1;
    const err = errIdx >= 0 ? this.model.runtimeErrors[errIdx] : null;
    const rt = err ? { "runtime-error": { index: String(errIdx), kind: String(err.kind), fatal: err.fatal ? "y" : "n" } } : {};
    const errText = () => (err ? `\n${this.gdbFilePath}:${err.line}${err.col ? ":" + err.col : ""}: runtime error: ${err.message}\n` : "");
    switch (info.kind) {
      case "breakpoint": {
        for (const b of info.hits) items.push(notifyItem("breakpoint-modified", { bkpt: this.bkpt(b) }));
        const first = info.hits[0];
        const f = this.model.chain(this.topStep())[0];
        const temp = first.disp === "del";
        if (err && !err.fatal) items.push(consoleItem(errText()));
        items.push(consoleItem("\n"));
        items.push(consoleItem(`${temp ? "Temporary breakpoint" : "Breakpoint"} ${first.number}, ${this.model.dn(f.fn)} (${this.frameArgsText(f.stepIdx)}) at ${this.gdbFilePath}:${f.line}\n`));
        items.push(consoleItem(`${f.line}\tin ${this.gdbFilePath}\n`));
        items.push(notifyItem("stopped", { reason: "breakpoint-hit", disp: first.disp, bkptno: String(first.number), frame: frame(), ...rt, ...tail }));
        for (const b of info.hits) if (b.disp === "del") { this.bps.remove(b.number); items.push(notifyItem("breakpoint-deleted", { id: String(b.number) })); }
        break;
      }
      case "step":
        if (o.cli) {
          const f = this.model.chain(this.topStep())[0];
          if (info.frameChanged) items.push(consoleItem(`${this.model.dn(f.fn)} (${this.frameArgsText(f.stepIdx)}) at ${this.gdbFilePath}:${f.line}\n`));
          items.push(consoleItem(`${f.line}\tin ${this.gdbFilePath}\n`));
        }
        items.push(notifyItem("stopped", { reason: "end-stepping-range", frame: frame(), ...rt, ...tail }));
        break;
      case "runtime-error": {
        // a recoverable runtime error (overflow, C array out of bounds, ...): the program stops here like on a
        // breakpoint and can go on; reason "runtime-error" (not a signal: nothing killed the program)
        const f = this.model.chain(this.topStep())[0];
        items.push(consoleItem(errText()));
        items.push(consoleItem(`${this.model.dn(f.fn)} (${this.frameArgsText(f.stepIdx)}) at ${this.gdbFilePath}:${f.line}\n${f.line}\tin ${this.gdbFilePath}\n`));
        items.push(notifyItem("stopped", { reason: "runtime-error", frame: frame(), ...rt, ...tail }));
        break;
      }
      case "finish":
        items.push(notifyItem("stopped", { reason: "function-finished", frame: frame(), ...rt, ...tail }));
        break;
      case "no-history":
        items.push(consoleItem("\nNo more reverse-execution history.\n"));
        items.push(notifyItem("stopped", { reason: "no-history", frame: frame(), ...tail }));
        break;
      case "signal": {
        const [name, meaning] = this.signalOf();
        const f = this.model.chain(this.topStep())[0];
        if (err) items.push(consoleItem(errText()));
        items.push(consoleItem(`\nProgram received signal ${name}, ${meaning}.\n`));
        items.push(consoleItem(`${this.model.dn(f.fn)} (${this.frameArgsText(f.stepIdx)}) at ${this.gdbFilePath}:${f.line}\n${f.line}\tin ${this.gdbFilePath}\n`));
        items.push(notifyItem("stopped", { reason: "signal-received", "signal-name": name, "signal-meaning": meaning, frame: frame(), ...rt, ...tail }));
        break;
      }
      case "exit": {
        const ex = this.model.exit;
        if (ex.reason === "exit" && (ex.code || 0) === 0) {
          items.push(consoleItem(`[Inferior 1 (process ${this.pid}) exited normally]\n`));
          items.push(notifyItem("thread-exited", { id: "1", "group-id": "i1" }));
          items.push(notifyItem("thread-group-exited", { id: "i1", "exit-code": "0" }));
          items.push(notifyItem("stopped", { reason: "exited-normally" }));
        } else if (ex.reason === "exit") {
          const code = ex.code || 0;
          items.push(consoleItem(`[Inferior 1 (process ${this.pid}) exited with code ${code.toString(8).padStart(2, "0")}]\n`));
          items.push(notifyItem("thread-exited", { id: "1", "group-id": "i1" }));
          items.push(notifyItem("thread-group-exited", { id: "i1", "exit-code": String(code) }));
          items.push(notifyItem("stopped", { reason: "exited", "exit-code": "0" + code.toString(8) }));
        } else {
          const [name, meaning] = this.signalOf();
          items.push(consoleItem(`\nProgram terminated with signal ${name}, ${meaning}.\nThe program no longer exists.\n`));
          items.push(notifyItem("thread-exited", { id: "1", "group-id": "i1" }));
          items.push(notifyItem("thread-group-exited", { id: "i1" }));
          items.push(notifyItem("stopped", { reason: "exited-signalled", "signal-name": name, "signal-meaning": meaning }));
        }
        this.deliverProgramOutput();
        break;
      }
    }
    void how;
    return items;
  }

  signalOf() {
    const ex = this.model.exit;
    return /** @type {[string, string]} */ ((ex.reason === "trap" && /** @type {any} */ (SIGNALS)[ex.trap || "other"]) || /** @type {any} */ (SIGNALS)[ex.reason] || ["SIGKILL", "Killed"]);
  }

  /** Program stdout/stderr reaches the UI through the program pty when the program ends (golden order: after the exit packet). */
  deliverProgramOutput() {
    const r = this.opts.runResult;
    const text = String(r.stdout || "") + String(r.stderr || "");
    if (this.exec.afterView) {
      // D3: the pane already shows the output up to the last stop; replace it with the complete output
      const all = text.replace(/\r?\n/g, "\r\n");
      if (all !== this._outputSent) { this._outputSent = all; this.after.push(["vg_program_output", { run_token: this.runToken, text: all }]); }
    } else if (text) this.after.push(["program_pty_response", text.replace(/\r?\n/g, "\r\n")]);
    this.stdoutDelivered = true;
  }

  /**
   * D3 (display "after"): stdout + stderr the program had written by the state the display shows, pty line endings; null when
   * the run has no host stamps (S1) to cut the output at a step. Step k's stamp counts the bytes written before step k was
   * recorded (S2 flushes the C++ streams there), so the output after line d is the stamp of the view step.
   */
  programOutputShown() {
    const r = this.opts.runResult;
    const offs = r && Array.isArray(r.stepOffsets) ? r.stepOffsets : null;
    if (!offs || !this.hasStack()) return null;
    const d = this.exec.dispStep();
    const { kind, idx } = this.exec.viewOf(d, this.exec.landed);
    const n = this.model.steps.length;
    const B = this.outBytes();
    let o, e;
    if (kind === "end" && d + 1 >= n) { o = B.out.length; e = B.err.length; } // the run's last step: everything it wrote
    else {
      const at = offs[kind === "after" ? idx : d];
      if (!at || typeof at.out !== "number" || typeof at.err !== "number") return null;
      o = at.out; e = at.err;
    }
    const dec = new TextDecoder();
    return (dec.decode(B.out.subarray(0, o)) + dec.decode(B.err.subarray(0, e))).replace(/\r?\n/g, "\r\n");
  }

  /** The run's stdout / stderr as bytes (the S1 stamps count bytes). */
  outBytes() {
    if (!this._outBytes) {
      const r = this.opts.runResult, enc = new TextEncoder();
      this._outBytes = { out: enc.encode(String(r.stdout || "")), err: enc.encode(String(r.stderr || "")) };
    }
    return this._outBytes;
  }

  /**
   * What the program printed between stop `a` and stop `b` (b > a), as the S3 line result spells it ({stdout, stderr},
   * null where the run has no stamps).
   * @param {number} a @param {number} b
   */
  outputBetween(a, b) {
    const r = this.opts.runResult;
    const offs = r && Array.isArray(r.stepOffsets) ? r.stepOffsets : null;
    const from = offs && offs[a], to = offs && offs[b];
    const B = this.outBytes(), dec = new TextDecoder();
    const cut = (/** @type {Uint8Array} */ buf, /** @type {any} */ x, /** @type {any} */ y) => (typeof x === "number" && typeof y === "number" ? dec.decode(buf.subarray(x, y)) : null);
    return { stdout: cut(B.out, from && from.out, to && to.out), stderr: cut(B.err, from && from.err, to && to.err) };
  }

  // ---- variable objects ----------------------------------------------------------------------

  /** @param {ReturnType<typeof parseCommand>} c */
  varCreate(c) {
    const a = splitArgs(c.rest).filter((x) => !(x.value.startsWith("--") && !x.quoted));
    if (a.length < 3) return [errorItem("-var-create: Usage: -var-create [NAME | \"-\"] [FRAME | \"*\" | \"@\"] EXPRESSION", c.token)];
    return [this.vars.create(a[0].value, a.slice(2).map((x) => x.value).join(" "), c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  varListChildren(c) {
    const a = splitArgs(c.rest);
    let values = /** @type {"all" | "simple" | "none"} */ ("none");
    const rest = [];
    for (const x of a) {
      if (!x.quoted && x.value === "--all-values") values = "all";
      else if (!x.quoted && x.value === "--simple-values") values = "simple";
      else if (!x.quoted && x.value === "--no-values") values = "none";
      else rest.push(x.value);
    }
    if (!rest.length) return [errorItem("-var-list-children: Usage: [PRINT_VALUES] NAME [FROM TO]", c.token)];
    const from = rest[1] !== undefined && /^\d+$/.test(rest[1]) ? Number(rest[1]) : null;
    const to = rest[2] !== undefined && /^\d+$/.test(rest[2]) ? Number(rest[2]) : null;
    return [this.vars.listChildren(rest[0], values, from, to, c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  varDelete(c) {
    const a = splitArgs(c.rest);
    const childrenOnly = a.some((x) => !x.quoted && x.value === "-c");
    const name = a.filter((x) => x.quoted || x.value !== "-c")[0];
    if (!name) return [errorItem("-var-delete: Usage: [-c] EXPRESSION", c.token)];
    return [this.vars.delete(name.value, childrenOnly, c.token)];
  }

  /** @param {ReturnType<typeof parseCommand>} c */
  varUpdate(c) {
    const a = splitArgs(c.rest).map((x) => x.value);
    const noValues = a.includes("--no-values");
    const target = a.filter((x) => !x.startsWith("--"))[0] ?? "*";
    return [this.vars.update(target, !noValues, c.token)];
  }

  // ---- [fast @N] -----------------------------------------------------------------------------

  /**
   * Simulate the fast-forward script GDB runs (`next` in a loop, collecting every stack) and print its blob.
   * Item order follows the golden sample: command echo (log), `^running`, then per internal `next`
   * running / console line / stopped, finally the console line with the blob.
   * @param {string} raw @param {NonNullable<ReturnType<typeof parseFastForward>>} ff
   */
  fastForward(raw, ff) {
    /** @type {any[]} */
    const items = [logItem(raw + "\n")];
    if (!this.exec.running) return [...items, errorItem("Error while executing Python code.", null)];
    /** @type {any[]} */
    const stacks = [];
    /** @type {Map<string, number>} */
    const counts = new Map();
    let landed = false, steps = 0, first = true;
    while (steps < ff.limit) {
      const info = this.exec.forward("next");
      if ("error" in info) return [...items, errorItem("Error while executing Python code.", null)];
      steps++;
      items.push(...this.stopItems(info, "next", { cli: true, noRunning: !first }));
      first = false;
      if (info.kind === "exit") break;
      const stack = this.frames().map((f) => this.blobFrame(f));
      stacks.push(stack.map((x) => x.py));
      const ln = String(stack[0].line);
      counts.set(ln, (counts.get(ln) || 0) + 1);
      if (stack[0].line === ff.line && (counts.get(String(ff.line)) || 0) >= ff.need) { landed = true; break; }
    }
    const blob = pyJson(new Map(/** @type {Array<[string, any]>} */ ([["stacks", stacks], ["counts", counts], ["landed", landed], ["steps", steps]])));
    items.push(consoleItem(ff.begin + blob + ff.end + "\n"));
    return items;
  }

  /**
   * One frame as the fast-forward script's Python dict (`args` only while the pc is in the function's own
   * block, like gdb.Frame.block() iteration does).
   * @param {import("./model.js").FrameRec} f
   * @returns {{ line: number, py: Map<string, any> }}
   */
  blobFrame(f) {
    const sc = this.model.scopes.get(f.fn);
    const inner = sc ? chainAt(sc, f.line)[0] : null;
    const args = !inner || inner.kind === "function" ? this.model.visibleVars(f.stepIdx).filter((e) => e.isArg) : [];
    const py = new Map(/** @type {Array<[string, any]>} */ ([
      ["func", this.model.dn(f.fn)], ["addr", "0x" + this.frameAddr(f.level).toString(16)], ["line", f.line], ["fullname", this.sourcePath],
      ["args", args.map((e) => new Map(/** @type {Array<[string, any]>} */ ([["name", e.name], ["value", this.entryValue(e)]])))],
    ]));
    return { line: f.line, py };
  }
}
