// Golden replay + comparator (contract §4-A).
//
//   loadGolden()      parse experiments/frontend-only/golden/raw_events.jsonl
//   segmentGolden()   attribute the flattened golden S>C item stream to (command, sub-command) using rules that only
//                     look at the COMMAND KIND (never at LocalGdb's output), so a wrong item count on our side
//                     cannot shift the alignment:
//                       plain sub-command  items up to and including its terminator (`result`, or `output` "^done"/"^error")
//                       -exec-run/continue/next/step/finish   items up to and including the `stopped` notify
//                       python exec(... @@FF@@ ...)           items up to and including the console line carrying the blob
//   compareSub()      deep comparison of one sub-command's items under the CLOSED allow list (ALLOW_RULES)
//   replayGolden()    feed the golden commands (and pty_interaction events) to a LocalGdb in golden order, waiting for
//                     each command's answer, then compare every sub-command
//
// Every difference outside the allow list becomes a readable diff line; nothing is silently skipped:
// sub-commands that cannot be compared are reported as NOT TESTED with the reason.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
export const GOLDEN_FILE = path.join(ROOT, "experiments", "frontend-only", "golden", "raw_events.jsonl");

/** The closed list of allowed differences (documented in gdbgui/static/engine/localgdb/README.md). */
export const ALLOW_RULES = {
  "addr": "address values (`addr`, hex pointer values, `@0x..:` reference prefixes)",
  "file": "`file` real path",
  "pid-thread": "pid, thread `target-id`/`name`, `process N` in console text",
  "uninit-value": "value of a variable that is not initialised yet (D6: we show 0, GDB shows stack garbage)",
  "gdb-noise": "GDB startup/environment notifications (library-loaded, thread-group-added, cmd-param-changed, ASLR warning)",
  "reverse-feature": "extra \"reverse\" entry in -list-features (spec §12 N3)",
  "std-window-shift": "-var-update report of the first refresh after a libstdc++ step-in window: our engine (which never enters the library) already reported the same changes one refresh earlier",
};

/** @returns {any[]} */
export function loadGolden(file = GOLDEN_FILE) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const stripTok = (/** @type {string} */ c) => c.replace(/^\d+/, "");
const subKind = (/** @type {string} */ cmd) => {
  const s = stripTok(cmd);
  if (/^-exec-(run|continue|next|step|finish)\b/.test(s)) return "exec";
  if (/^python exec\(/.test(s)) return "ff";
  return "plain";
};

/**
 * @param {any[]} events
 * @returns {{ commands: Array<{ ev: number, request_id: number, run_token: any, subs: Array<{ command: string, kind: string, items: any[], evs: number[] }> }>, ptyEvents: any[] }}
 */
export function segmentGolden(events) {
  /** @type {Array<{ ev: number, it: any }>} */
  const flat = [];
  events.forEach((e, i) => { if (e.dir === "S>C" && e.name === "gdb_response") for (const it of e.data.data) flat.push({ ev: i, it }); });
  let cur = 0;
  const commands = [];
  for (const [i, e] of events.entries()) {
    if (!(e.dir === "C>S" && e.name === "run_gdb_command")) continue;
    const subs = [];
    for (const command of e.data.cmd) {
      const kind = subKind(command);
      const items = [], evs = [];
      for (;;) {
        if (cur >= flat.length) throw new Error(`golden segmentation: ran out of items inside sub-command ${JSON.stringify(command.slice(0, 80))} of the command at event ${i}`);
        const { ev, it } = flat[cur++];
        items.push(it); evs.push(ev);
        if (kind === "exec" && it.type === "notify" && it.message === "stopped") break;
        if (kind === "ff" && it.type === "console" && typeof it.payload === "string" && it.payload.startsWith("@@FF@@")) break;
        if (kind === "plain" && (it.type === "result" || (it.type === "output" && /^\d*\^(done|error)/.test(it.payload)))) break;
      }
      subs.push({ command, kind, items, evs });
    }
    commands.push({ ev: i, request_id: e.data.request_id, run_token: e.data.run_token, subs });
  }
  if (cur !== flat.length) throw new Error(`golden segmentation: ${flat.length - cur} golden items were not attributed to any command`);
  return { commands, ptyEvents: events.filter((e) => e.name === "pty_interaction" || e.name === "program_pty_response") };
}

// ---- comparison ---------------------------------------------------------------------------------

const NOISE_NOTIFY = new Set(["library-loaded", "thread-group-added", "cmd-param-changed"]);
const isNoise = (/** @type {any} */ it) => (it.type === "notify" && NOISE_NOTIFY.has(it.message)) || (it.type === "log" && /Error disabling address space randomization/.test(String(it.payload)));
const HEX_FULL = /^0x[0-9a-f]+$/;
const REF_PREFIX = /^@0x[0-9a-f]+: /;
/** Address values: both sides are WHOLE hex addresses, or `@0xADDR: rest` with `rest` equal. */
const addrEqual = (/** @type {string} */ g, /** @type {string} */ m) => (HEX_FULL.test(g) && HEX_FULL.test(m)) || (REF_PREFIX.test(g) && REF_PREFIX.test(m) && g.replace(REF_PREFIX, "") === m.replace(REF_PREFIX, ""));

/** @typedef {{ uninit: Set<string>, expr: string | null, step: any, line: number | string, declLater: Set<string> }} Ctx */

export class Report {
  constructor() {
    /** @type {string[]} */ this.diffs = [];
    /** @type {Map<string, number>} */ this.allowed = new Map();
    /** @type {Array<{ where: string, reason: string }>} */ this.notTested = [];
    /** @type {Set<string>} (line:variable) pairs whose value difference was excused as uninitialised */ this.uninitPairs = new Set();
    this.tested = 0;
  }
  allow(/** @type {string} */ rule) { this.allowed.set(rule, (this.allowed.get(rule) || 0) + 1); }
  diff(/** @type {string} */ s) { this.diffs.push(s); }
}

/**
 * @param {any} g golden value @param {any} m our value @param {string} p path @param {Report} rep @param {Ctx} ctx @param {any} parentG
 */
function cmpVal(g, m, p, rep, ctx, parentG, key = "") {
  // allow rules on leaves
  if (key === "addr" && typeof g === "string" && typeof m === "string" && addrEqual(g, m)) { if (g !== m) rep.allow("addr"); return; }
  if (key === "file" && typeof g === "string" && typeof m === "string") { if (g !== m) rep.allow("file"); return; }
  if (key === "pid" && typeof g === "string" && typeof m === "string" && /^\d+$/.test(g) && /^\d+$/.test(m)) { if (g !== m) rep.allow("pid-thread"); return; }
  if ((key === "target-id" || key === "name") && parentG && typeof parentG === "object" && "state" in parentG && "frame" in parentG) { if (g !== m) rep.allow("pid-thread"); return; }
  if (key === "value" && typeof g === "string" && typeof m === "string" && g !== m) {
    if (addrEqual(g, m)) { rep.allow("addr"); return; }
    const nm = parentG && typeof parentG === "object" ? parentG.name : undefined;
    const zero = /^(0|false|0 '\\000'|"")$/.test(m); // D6: our value for an uninitialised variable is the zero of its type
    const garbage = /^-?\d+$/.test(g); // GDB shows stack garbage: a plain integer
    const target = p.includes("variables[") ? nm : p.includes("payload.value") ? ctx.expr : null;
    // independent of LocalGdb's own flag: the ENGINE trace says the variable is uninitialised (`uninit`) or not declared yet at this stop
    // (or a shadowed outer variable whose declaration line is after the current line, from the source's block analysis)
    const engineUninit = typeof target === "string" && ctx.step && ((ctx.step.uninit || []).includes(target) || !Object.prototype.hasOwnProperty.call(ctx.step.vars, target) || ctx.declLater.has(target));
    if (zero && garbage && typeof target === "string" && ctx.uninit.has(target) && engineUninit) { rep.allow("uninit-value"); rep.uninitPairs.add(`${ctx.line}:${target}`); return; }
  }
  if (key === "features" && Array.isArray(g) && Array.isArray(m)) {
    if (m.includes("reverse") && !g.includes("reverse")) { m = m.filter((x) => x !== "reverse"); rep.allow("reverse-feature"); }
  }
  if (typeof g === "string" && typeof m === "string" && key === "payload" && g !== m) {
    if (g.startsWith("@@FF@@") && m.startsWith("@@FF@@")) {
      const parse = (/** @type {string} */ s) => JSON.parse(s.slice(6, s.indexOf("@@/FF@@")));
      cmpVal(parse(g), parse(m), p + "<blob>", rep, ctx, null);
      if (g.slice(g.indexOf("@@/FF@@")) !== m.slice(m.indexOf("@@/FF@@"))) rep.diff(`${p}: FF blob trailer differs`);
      return;
    }
    const norm = (/** @type {string} */ s) => s.replace(/process \d+/g, "process <pid>");
    if (norm(g) === norm(m)) { rep.allow("pid-thread"); return; }
  }
  if (Array.isArray(g) || Array.isArray(m)) {
    if (!Array.isArray(g) || !Array.isArray(m)) return rep.diff(`${p}: golden ${short(g)} != ours ${short(m)}`);
    if (g.length !== m.length) rep.diff(`${p}: array length golden ${g.length} != ours ${m.length}\n      golden ${short(g)}\n      ours   ${short(m)}`);
    for (let i = 0; i < Math.min(g.length, m.length); i++) cmpVal(g[i], m[i], `${p}[${i}]`, rep, ctx, g[i], "");
    return;
  }
  if (g && m && typeof g === "object" && typeof m === "object") {
    const gk = Object.keys(g), mk = Object.keys(m);
    for (const k of gk) if (!(k in m)) rep.diff(`${p}.${k}: missing in ours (golden ${short(g[k])})`);
    for (const k of mk) if (!(k in g)) rep.diff(`${p}.${k}: not in golden (ours ${short(m[k])})`);
    for (const k of gk) if (k in m) cmpVal(g[k], m[k], `${p}.${k}`, rep, ctx, g, k);
    return;
  }
  if (g !== m) rep.diff(`${p}: golden ${short(g)} != ours ${short(m)}`);
}

/** @param {any} v */
const short = (v) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : s.length > 240 ? s.slice(0, 240) + "…" : s; };

const brief = (/** @type {any} */ it) => `${it.type}/${it.message}${it.token !== undefined ? "#" + it.token : ""}`;

/**
 * Compare one sub-command's item lists.
 * @param {string} where @param {any[]} gItems @param {any[]} mItems @param {Report} rep @param {Ctx} ctx
 */
export function compareSub(where, gItems, mItems, rep, ctx) {
  let g = gItems, m = mItems;
  const gDrop = g.filter(isNoise);
  for (const _ of gDrop) rep.allow("gdb-noise");
  g = g.filter((x) => !isNoise(x));
  m = m.filter((x) => !isNoise(x));
  if (g.length !== m.length) {
    rep.diff(`${where}: item count golden ${g.length} != ours ${m.length}\n      golden ${g.map(brief).join(" ")}\n      ours   ${m.map(brief).join(" ")}`);
    return;
  }
  for (let i = 0; i < g.length; i++) cmpVal(g[i], m[i], `${where} item[${i}] ${brief(g[i])}`, rep, ctx, null);
}

// ---- replay -----------------------------------------------------------------------------------

/**
 * Feed the golden run to `gdb` and compare. `gdb` must have been created with recordSubcommands: true.
 * @param {{ gdb: any, events: any[], userFns: Set<string>, steps: any[], mutate?: (seg: ReturnType<typeof segmentGolden>) => void }} o
 */
export async function replayGolden({ gdb, events, userFns, steps, mutate }) {
  const seg = segmentGolden(events);
  if (mutate) mutate(seg);
  const rep = new Report();
  /** @type {any[]} */ const gdbResponses = [];
  /** @type {Array<[string, any]>} */ const otherEvents = [];
  gdb.socket.on("gdb_response", (p) => gdbResponses.push(p));
  for (const ev of ["program_pty_response", "user_pty_response", "error_running_gdb_command"]) gdb.socket.on(ev, (p) => otherEvents.push([ev, p]));
  const orderLog = [];
  gdb.socket.on("gdb_response", () => orderLog.push("gdb_response"));
  gdb.socket.on("program_pty_response", () => orderLog.push("program_pty_response"));
  gdb.connect();

  const st = { untested: new Set(), inStd: false, stdout: "", windowMine: /** @type {any[]} */ ([]) };
  const rows = [];
  const cmdByEv = new Map(seg.commands.map((c) => [c.ev, c]));
  for (const [i, e] of events.entries()) {
    if (e.name === "pty_interaction" && e.dir === "C>S") { gdb.socket.emit("pty_interaction", e.data); continue; }
    if (e.name === "program_pty_response") { st.stdout += e.data; continue; }
    const c = cmdByEv.get(i);
    if (!c) continue;
    const before = gdb.session.subcommandLog.length;
    // like layer B: the run_token exists once the (simulated) /create_and_upload answered; before that commands carry null
    if (c.run_token !== null && gdb.session.runToken === null) gdb.setRunToken(c.run_token);
    const nPackets = gdbResponses.length;
    gdb.socket.emit("run_gdb_command", { cmd: e.data.cmd, run_token: e.data.run_token, request_id: e.data.request_id });
    await gdb.idle();
    const mine = gdb.session.subcommandLog.slice(before);
    // packet run_token echo: null before the token exists, the token afterwards - on the golden's packets and on ours
    const goldenTokens = new Set(c.subs.flatMap((sub) => sub.evs).map((ev) => JSON.stringify(events[ev].data.run_token)));
    const ours = gdbResponses.slice(nPackets).map((pk) => JSON.stringify(pk.run_token));
    if (ours.length !== 1 || goldenTokens.size !== 1 || ours[0] !== [...goldenTokens][0] || ours[0] !== JSON.stringify(c.run_token)) {
      rep.diff(`event ${i}: packet run_token: golden ${[...goldenTokens].join("/")} (command ${JSON.stringify(c.run_token)}) != ours ${ours.join("/")}`);
    }
    if (mine.length !== c.subs.length) { rep.diff(`event ${i}: LocalGdb answered ${mine.length} sub-commands, golden has ${c.subs.length}`); continue; }
    c.subs.forEach((gs, k) => {
      const ms = mine[k];
      const where = `event ${i} sub#${k} ${gs.command.slice(0, 60).replace(/\/srv\/\S+/g, "SRV")}`;
      const reason = notTestedReason(gs, st, userFns);
      if (reason) {
        rep.notTested.push({ where, reason });
        rows.push({ where, verdict: "not tested" });
        if (st.inStd && /^\d*-var-update\b/.test(gs.command)) for (const it of ms.items) if (it.payload && it.payload.changelist) st.windowMine.push(...it.payload.changelist);
        return;
      }
      const uninit = new Set(ms.ctx ? ms.ctx.uninit : []);
      const em = /^\d*-var-create\s+\S+\s+\S+\s+"(.*)"$/.exec(gs.command);
      /** @type {Ctx} */
      const ctx = { uninit, expr: em ? em[1] : null, step: ms.ctx && ms.ctx.stepIdx >= 0 ? steps[ms.ctx.stepIdx] : null, line: ms.ctx ? ms.ctx.line : -1, declLater: new Set(ms.ctx ? ms.ctx.declLater : []) };
      let gi = gs.items;
      if (/^\d*-var-update\b/.test(gs.command)) gi = filterUntestedChanges(gi, st, rep);
      const before = rep.diffs.length;
      const isUpd = /^\d*-var-update\b/.test(gs.command);
      if (isUpd && st.windowMine.length) {
        const trial = new Report();
        compareSub(where, gi, ms.items, trial, ctx);
        if (trial.diffs.length) {
          const merged = ms.items.map((it) => {
            if (!(it.payload && Array.isArray(it.payload.changelist))) return it;
            const byName = new Map();
            for (const c of [...st.windowMine, ...it.payload.changelist]) byName.set(c.name, c);
            return { ...it, payload: { ...it.payload, changelist: [...byName.values()] } };
          });
          const sortCl = (/** @type {any[]} */ items) => items.map((it) => (it.payload && Array.isArray(it.payload.changelist) ? { ...it, payload: { ...it.payload, changelist: [...it.payload.changelist].sort((a, b) => (a.name < b.name ? -1 : 1)) } } : it));
          const t2 = new Report();
          compareSub(where, sortCl(gi), sortCl(merged), t2, ctx);
          if (!t2.diffs.length) { rep.allow("std-window-shift"); for (const [k, v] of t2.allowed) for (let n = 0; n < v; n++) rep.allow(k); }
          else for (const d of trial.diffs) rep.diff(d);
        } else { for (const [k, v] of trial.allowed) for (let n = 0; n < v; n++) rep.allow(k); }
        st.windowMine = [];
      } else compareSub(where, gi, ms.items, rep, ctx);
      rep.tested++;
      rows.push({ where, verdict: rep.diffs.length === before ? "match" : "DIFFERENT" });
    });
  }
  // program output: delivered once, after the exit packet, CRLF like the pty
  const outEvents = otherEvents.filter(([n]) => n === "program_pty_response").map(([, p]) => p);
  if (outEvents.join("") !== st.stdout) rep.diff(`program_pty_response: golden ${short(st.stdout)} != ours ${short(outEvents.join(""))}`);
  else rep.tested++;
  const lastGdb = orderLog.lastIndexOf("gdb_response");
  const outAt = orderLog.indexOf("program_pty_response");
  if (outAt >= 0 && outAt < lastGdb) rep.diff("program_pty_response was delivered before the final gdb_response (golden: after the exit packet)");
  return { rep, rows, seg, gdbResponses, otherEvents };
}

/** @param {{ command: string, kind: string, items: any[] }} gs @param {any} st @param {Set<string>} userFns @returns {string | null} */
function notTestedReason(gs, st, userFns) {
  const cmd = stripTok(gs.command);
  // (b) the UI's `step` on a line calling std::vector::operator[] enters libstdc++ in GDB; the engine never does
  if (gs.kind === "exec") {
    const stop = gs.items.find((x) => x.type === "notify" && x.message === "stopped");
    const fn = stop && stop.payload && stop.payload.frame ? stop.payload.frame.func : null;
    st.inStd = !!fn && !userFns.has(fn);
    if (st.inStd) return "GDB noise stop: step into libstdc++ (allowed difference (b): the engine never steps into the standard library)";
    return null;
  }
  if (st.inStd && /^-(thread-info|stack-list-frames|stack-list-variables|stack-list-arguments|var-update)\b/.test(cmd)) return "state inside a libstdc++ frame (allowed difference (b))";
  // every golden `-var-create` (plain names, `&(x)`, integer expressions, `x.capacity()`) is compared
  const vn = /^-var-(?:list-children\s+--all-values\s+"([^"]+)"|delete\s+(\S+))/.exec(cmd);
  if (vn) {
    const name = vn[1] || vn[2];
    for (const u of st.untested) if (name === u || name.startsWith(u + ".")) return `variable object ${name} was created by an untested expression`;
  }
  return null;
}

/** Drop golden changelist entries of untested varobjs (counted under the allow rule). @param {any[]} items @param {any} st @param {Report} rep */
function filterUntestedChanges(items, st, rep) {
  return items.map((it) => {
    if (!(it.type === "result" && it.payload && Array.isArray(it.payload.changelist))) return it;
    const kept = it.payload.changelist.filter((c) => {
      const untested = [...st.untested].some((u) => c.name === u || c.name.startsWith(u + "."));
      if (untested) rep.allow("untested-varobj-entry");
      return !untested;
    });
    return { ...it, payload: { ...it.payload, changelist: kept } };
  });
}
