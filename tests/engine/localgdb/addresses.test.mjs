// Pseudo addresses (frame.addr / bkpt.addr) must satisfy the relations the UI derives behaviour from:
//  * gdbgui/src/js/forHeader.ts decideForSegment (used by Actions.ts recompute_for_sub_step): on a stop at a `for` line the
//    segment is "A" iff frame.addr equals the smallest addr seen so far for that line, else "C"  -> init addr < increment addr;
//  * gdbgui/src/js/callTree.ts ingestStack: a caller frame's addr identifies the call site (stable per site, distinct for two
//    calls on one source line);
//  * Threads.tsx: frame.addr equality selects the current frame.
// The real GDB values come from the golden sample (for-lines 33 and 41 have exactly two addresses: init < increment).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT, loadGolden } from "./golden_replay.mjs";
import { send, payloadOf, stopped, newGdb } from "./helpers.mjs";

const SRC = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "addr.cpp"), "utf8");
const TSP = fs.readFileSync(path.join(ROOT, "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp"), "utf8");
const STDIN = fs.readFileSync(path.join(ROOT, "experiments", "frontend-only", "e1", "e2", "ref", "tsp.in"), "utf8");
let eng, run, trun;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(SRC, "");
  trun = await eng.runProgram(TSP, STDIN);
});
after(() => eng && eng.dispose());

/** Literal copy of decideForSegment (gdbgui/src/js/forHeader.ts:176-194). */
function decideForSegment(min_addrs, line, addr) {
  const parse = (a) => { if (typeof a !== "string" || !a.trim()) return null; try { return BigInt(a.trim()); } catch (_) { return null; } };
  const parsed = parse(addr);
  if (parsed === null) { if (!(line in min_addrs)) { min_addrs[line] = BigInt(0); return "A"; } return "C"; }
  const prev = min_addrs[line];
  const min = prev === undefined || parsed < prev ? parsed : prev;
  min_addrs[line] = min;
  return parsed === min ? "A" : "C";
}
const hex = (a) => BigInt(a);

test("golden fact: for-lines have init < increment (33: 0x40147d < 0x4014ec, 41: 0x401586 < 0x401644), body addresses in between", () => {
  const byLine = new Map();
  for (const e of loadGolden()) if (e.name === "gdb_response") for (const d of e.data.data) {
    if (d.message === "stopped" && d.payload.frame && d.payload.frame.func === "main") { const f = d.payload.frame; (byLine.get(f.line) || byLine.set(f.line, new Set()).get(f.line)).add(f.addr); }
  }
  for (const l of ["33", "41"]) assert.equal(byLine.get(l).size, 2);
  const [a, b] = [...byLine.get("33")].map(hex);
  assert.ok(a < b && a < hex([...byLine.get("34")][0]) && hex([...byLine.get("34")][0]) < b, "init < body < increment");
  const lines = [...byLine.keys()].map(Number).sort((x, y) => x - y);
  const lo = lines.map((l) => [...byLine.get(String(l))].map(hex).reduce((m, v) => (v < m ? v : m)));
  for (let i = 1; i < lo.length; i++) assert.ok(lo[i] > lo[i - 1], `first address of line ${lines[i]} above line ${lines[i - 1]}`);
});

test("ours: nested loops - init < body < increment per for-line, inner increment below outer increment, fixed per for-line, monotonic lines, 0x + 16 hex digits", async () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const g = newGdb(run, SRC);
  await send(g, "-break-insert -f main");
  let it = await send(g, "-exec-run");
  const stops = [];
  for (let k = 0; k < 60; k++) {
    const st = stopped(it);
    if (!st || !st.payload.frame) break;
    stops.push({ line: Number(st.payload.frame.line), fn: st.payload.frame.func, addr: st.payload.frame.addr });
    it = await send(g, "-exec-next");
  }
  for (const s of stops) assert.match(s.addr, /^0x[0-9a-f]{16}$/);
  const main = stops.filter((s) => s.fn === "main");
  const by = (l) => [...new Set(main.filter((s) => s.line === l).map((s) => s.addr))].map(hex).sort((a, b) => (a < b ? -1 : 1));
  const outer = by(5), inner = by(6), body = by(7);
  assert.equal(outer.length, 2); assert.equal(inner.length, 2); assert.equal(body.length, 1);
  assert.ok(outer[0] < inner[0] && inner[0] < body[0] && body[0] < inner[1] && inner[1] < outer[1], "init(5) < init(6) < body(7) < incr(6) < incr(5)");
  // per-stop kind: the first stop on line 5 / 6 after entering is init, the ones after the body are increments
  const kinds = main.filter((s) => s.line === 6).map((s) => (hex(s.addr) === inner[0] ? "init" : "incr"));
  assert.deepEqual(kinds, ["init", "incr", "incr", "init", "incr", "incr"], "2 loop entries x (init, 2 x incr)... entry, after j=0, after j=1");
  const ls = [...new Set(main.map((s) => s.line))].sort((a, b) => a - b);
  const lo = ls.map((l) => by(l)[0]);
  for (let i = 1; i < lo.length; i++) assert.ok(lo[i] > lo[i - 1], "line base addresses increase with the line");
  // functions in declaration order: f < g < main
  const bf = hex(payloadOf(await send(g, "-break-insert -f 1")).bkpt.addr), bg = hex(payloadOf(await send(g, "-break-insert -f 2")).bkpt.addr);
  assert.ok(bf < bg && bg < body[0] && bg < outer[0], "functions in declaration order: f < g < main");
  // breakpoint addr = the line's first (init) address
  const bp = payloadOf(await send(g, "-break-insert -f 6")).bkpt;
  assert.equal(hex(bp.addr), inner[0]);
  assert.match(bp.addr, /^0x[0-9a-f]{16}$/);
});

test("ours: caller frames - return addresses are stable per call site and distinct for calls on the same line; frame 0 after finish is the return address", async () => {
  const g = newGdb(run, SRC);
  await send(g, ["-break-insert -f 1", "-break-insert -f 2"]);
  let it = await send(g, "-exec-run");
  const callee = [];
  for (let k = 0; k < 20 && stopped(it); k++) {
    if (/^exited/.test(stopped(it).payload.reason)) break;
    const sp = payloadOf(await send(g, "1-stack-list-frames")); assert.ok(sp.stack, JSON.stringify(sp) + " at k=" + k + " " + JSON.stringify(stopped(it).payload));
    const st = sp.stack;
    if (st.length === 2) callee.push({ fn: st[0].func, ret: st[1].addr, line: st[1].line });
    it = await send(g, "-exec-continue");
  }
  assert.equal(callee.length, 12, "f(g(i)) + f(j): g, f, f per inner iteration x 4 iterations");
  const perIter = [];
  for (let i = 0; i < callee.length; i += 3) perIter.push(callee.slice(i, i + 3).map((c) => c.fn + "@" + c.ret));
  assert.deepEqual(callee.slice(0, 3).map((c) => c.fn), ["g", "f", "f"]);
  assert.equal(new Set(callee.slice(0, 3).map((c) => c.ret)).size, 3, "three calls on line 7: three distinct return addresses");
  for (const iter of perIter) assert.deepEqual(iter, perIter[0], "the same call site has the same return address on every iteration");
  for (const c of callee) assert.equal(c.line, "7");
});

test("ours: finish lands at the return address (frame 0 addr == the caller frame's addr seen from inside the callee)", async () => {
  const g = newGdb(run, SRC);
  await send(g, "-break-insert -f 1");
  await send(g, "-exec-run");
  const inside = payloadOf(await send(g, "1-stack-list-frames")).stack;
  const fin = await send(g, "-exec-finish");
  assert.equal(stopped(fin).payload.frame.addr, inside[1].addr);
  assert.equal(stopped(fin).payload.frame.line, "7");
});

test("UI rule replay: decideForSegment on our stops classifies every tsp `for` stop exactly like on the GOLDEN addresses (lines 33, 37, 41, 36)", async () => {
  assert.equal(trun.ok, true);
  const events = loadGolden();
  const { replayGolden } = await import("./golden_replay.mjs");
  const loadCmd = events.find((e) => e.name === "run_gdb_command" && e.data.cmd.length > 5);
  const real = /"?(\/srv\/gdbgui-scratch\/[^\s"]*\.cpp):\d+"?$/.exec(loadCmd.data.cmd.find((c) => c.startsWith("-break-insert") && c.includes(":31")))[1];
  const gdb = newGdb(trun, TSP, { gdbFilePath: real });
  const res = await replayGolden({ gdb, events, userFns: new Set(Object.keys(trun.functions)), steps: trun.steps });
  assert.deepEqual(res.rep.diffs, []);
  // per command: the stops of the golden and of ours (a golden std-library stop makes the command incomparable)
  const cmds = events.filter((e) => e.name === "run_gdb_command");
  const goldenStops = cmds.map(() => []);
  const { segmentGolden } = await import("./golden_replay.mjs");
  const seg = segmentGolden(events);
  seg.commands.forEach((c, k) => { for (const sub of c.subs) for (const it of sub.items) if (it.type === "notify" && it.message === "stopped" && it.payload.frame) goldenStops[k].push(it.payload.frame); });
  const ours = res.gdbResponses.map((p) => p.data.filter((it) => it.type === "notify" && it.message === "stopped" && it.payload.frame).map((it) => it.payload.frame));
  const forLines = new Set(TSP.split("\n").map((t, i) => (/\bfor\s*\(/.test(t) ? i + 1 : 0)).filter(Boolean));
  const gMin = {}, oMin = {};
  let compared = 0, incr = 0;
  goldenStops.forEach((gs, k) => {
    if (gs.some((f) => f.func !== "main")) return; // the libstdc++ step-in: not comparable
    assert.equal(ours[k].length, gs.length, `command ${k}: same number of stops`);
    gs.forEach((gf, j) => {
      const line = Number(gf.line);
      if (!forLines.has(line)) return;
      const a = decideForSegment(gMin, line, gf.addr), b = decideForSegment(oMin, line, ours[k][j].addr);
      assert.equal(b, a, `stop ${k}.${j} at line ${line}: golden ${a} (${gf.addr}) ours ${b} (${ours[k][j].addr})`);
      compared++; if (a === "C") incr++;
    });
  });
  assert.ok(compared >= 10 && incr >= 5, `compared ${compared}, increments ${incr}`);
  // (c) order relation init < increment on every for-line that has both in the golden: also in ours
  const collect = (lists) => { const m = new Map(); for (const gs of lists) for (const f of gs) if (forLines.has(Number(f.line))) (m.get(f.line) || m.set(f.line, new Set()).get(f.line)).add(hex(f.addr)); return m; };
  const gm = collect(goldenStops.filter((gs) => !gs.some((f) => f.func !== "main")));
  const om = collect(ours);
  for (const [line, set] of gm) if (set.size === 2) assert.equal(om.get(line).size >= 2, true, `line ${line} has two addresses in ours`);
});
