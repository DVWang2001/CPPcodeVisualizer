// Convert the golden sample (raw_events.jsonl: production UI driving GDB on lesson #23, 技巧一)
// into the sequence of UI execution commands and the GDB stops each produced:
//   kind   breakpoint-hit | end-stepping-range | exited-normally | ... (notify "stopped" reason)
//   line / func from frame.line / frame.func
//   fast-forward blocks: the `python exec(...)` command whose output carries
//     @@FF@@{"stacks":[[frame...]...],"counts":{...},"landed":bool,"steps":n}@@/FF@@
//   (the command echo in the `log` stream also contains the marker text but is not JSON; only a
//    payload that parses as JSON between the markers is taken).
// Usage: node golden_to_stops.mjs [raw_events.jsonl]      prints a summary + the stop list as JSON
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FF = /@@FF@@([\s\S]*?)@@\/FF@@/g;

/** @param {string[]} cmds */
function classify(cmds) {
  for (const c of cmds) {
    if (/^-exec-run\b/.test(c)) return "run";
    if (/^-exec-continue\b/.test(c)) return "continue";
    if (/^-exec-next\b/.test(c)) return "next";
    if (/^-exec-step\b/.test(c)) return "step";
    if (/^-exec-finish\b/.test(c)) return "finish";
    if (/^python exec\(/.test(c) && c.includes("@@FF@@")) return "fast-forward";
  }
  return null;
}

/** @param {string} [file] */
export function goldenToStops(file = path.join(HERE, "raw_events.jsonl")) {
  const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  /** @type {Array<{ seq: number, cmd: string, stops: any[], ff: any }>} */
  const commands = [];
  const breakpoints = [];
  let stdin = null, stdout = "";
  let cur = null;
  for (const [seq, e] of events.entries()) {
    if (e.dir === "C>S" && e.name === "run_gdb_command") {
      const cmds = Array.isArray(e.data.cmd) ? e.data.cmd : [e.data.cmd];
      const kind = classify(cmds);
      if (kind) { cur = { seq, cmd: kind, stops: [], ff: null }; commands.push(cur); }
      if (kind === "fast-forward") {
        const src = cmds.find((c) => c.startsWith("python exec("));
        const m = /_ln==(\d+) and _C\.get\(str\(\d+\),0\)>=(\d+)/.exec(src);
        cur.ffTarget = m ? { line: Number(m[1]), count: Number(m[2]) } : null;
      }
      continue;
    }
    if (e.dir === "C>S" && e.name === "pty_interaction" && e.data?.data?.action === "write" && e.data.data.pty_name === "program_pty") {
      stdin = (stdin || "") + String(e.data.data.key).replace(/\u0004$/, "");
    }
    if (e.name === "program_pty_response") stdout += typeof e.data === "string" ? e.data : "";
    if (e.dir !== "S>C" || e.name !== "gdb_response") continue;
    for (const d of e.data.data || []) {
      if (d.type === "notify" && (d.message === "breakpoint-created" || d.message === "breakpoint-modified") && d.payload?.bkpt) {
        const b = d.payload.bkpt;
        if (!breakpoints.some((x) => x.number === b.number)) breakpoints.push({ number: b.number, line: Number(b.line), func: b.func, original: b["original-location"] });
      }
      if (d.type === "result" && d.payload?.bkpt) {
        const b = d.payload.bkpt;
        if (!breakpoints.some((x) => x.number === b.number)) breakpoints.push({ number: b.number, line: Number(b.line), func: b.func, original: b["original-location"] });
      }
      if (d.type === "notify" && d.message === "stopped" && cur) {
        const p = d.payload || {};
        cur.stops.push({ kind: p.reason, line: p.frame ? Number(p.frame.line) : null, func: p.frame ? p.frame.func : null, bkptno: p.bkptno ? Number(p.bkptno) : null });
      }
      if (typeof d.payload === "string" && d.payload.includes("@@FF@@") && cur && cur.cmd === "fast-forward") {
        for (const m of d.payload.matchAll(FF)) {
          try {
            const blob = JSON.parse(m[1]);
            cur.ff = { steps: blob.steps, landed: blob.landed, counts: blob.counts, lines: blob.stacks.map((s) => Number(s[0].line)), funcs: blob.stacks.map((s) => s[0].func), depths: blob.stacks.map((s) => s.length) };
          } catch { /* the echoed command text, not the result */ }
        }
      }
    }
  }
  // The UI-visible stop of a command is the last `stopped` it produced (a fast-forward produces one
  // per internal `next`; its landing stop is the last).
  const stops = commands.map((c) => ({ seq: c.seq, cmd: c.cmd, ...(c.stops[c.stops.length - 1] || { kind: null }), ...(c.ff ? { ff: c.ff, ffTarget: c.ffTarget } : {}) }));
  return { commands, stops, breakpoints, stdin, stdout };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const g = goldenToStops(process.argv[2]);
  console.log("breakpoints:", g.breakpoints.map((b) => `#${b.number}@${b.line}`).join(" "));
  console.log("stdin:", JSON.stringify(g.stdin), " program output:", JSON.stringify(g.stdout));
  for (const s of g.stops) console.log(String(s.seq).padStart(4), s.cmd.padEnd(13), String(s.kind).padEnd(20), s.func, s.line, s.ff ? `FF lines=${s.ff.lines.join(",")} landed=${s.ff.landed}` : "");
}
