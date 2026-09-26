// Cross-check of stop semantics against the golden sample v0 (production UI driving GDB on lesson
// #23 技巧一, experiments/frontend-only/golden/raw_events.jsonl), contract §4/§5.
//
// Comparable: the kind (breakpoint-hit / end-stepping-range / exited-normally), line and function of
// the stop produced by every UI execution command, including the `[fast @N]` fast-forward block.
// Allowed: (b) the UI's `step` on a line calling std::vector::operator[] enters libstdc++ in GDB; the
// engine never enters the standard library. Not compared here: variable values of the golden
// session (-stack-list-variables / varobjs; S3/S4 scope), MI packet structure, timing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine, ROOT } from "./node_driver.mjs";
import { goldenToStops } from "../../experiments/frontend-only/golden/golden_to_stops.mjs";
import { StopSim } from "./stop_sim.mjs";

const LESSON = path.join(ROOT, "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp");
let eng, g, run;
before(async () => {
  g = goldenToStops();
  eng = await loadNodeEngine();
  run = await eng.runProgram(fs.readFileSync(LESSON, "utf8"), g.stdin);
});
after(() => eng && eng.dispose());

test("golden: parser extracts commands, stops, breakpoints, stdin and the fast-forward blob", () => {
  assert.deepEqual(g.breakpoints.map((b) => b.line), [23, 31, 51, 57]);
  assert.equal(g.stops.length, 29);
  assert.deepEqual([...new Set(g.stops.map((s) => s.kind))].sort(), ["breakpoint-hit", "end-stepping-range", "exited-normally"]);
  const ff = g.stops.find((s) => s.cmd === "fast-forward");
  assert.deepEqual(ff.ff.lines, [33, 34, 33, 34]);
  assert.equal(ff.ff.landed, true);
  assert.deepEqual(ff.ffTarget, { line: 34, count: 2 });
  assert.match(g.stdin, /^5 4\n/);
});

test("golden: engine stdout equals the program output GDB's pty delivered (CRLF from the pty line discipline)", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(run.stdout, g.stdout.replace(/\r\n/g, "\n"));
});

test("golden: every UI command stops at the same kind/line/function in the engine trace (allowed: (b) std-library step-in)", () => {
  const sim = new StopSim(run.steps, g.breakpoints.map((b) => b.line));
  const userFns = new Set(Object.keys(run.functions));
  const rows = [];
  let allowedB = 0;
  for (const gs of g.stops) {
    let ours;
    if (gs.cmd === "fast-forward") ours = sim.fastForward(gs.ffTarget);
    else ours = sim[gs.cmd === "run" ? "run" : gs.cmd]();
    if (gs.kind === "end-stepping-range" && gs.cmd === "step" && gs.func && !userFns.has(gs.func)) {
      allowedB++;
      rows.push({ seq: gs.seq, cmd: gs.cmd, gdb: `${gs.func}:${gs.line}`, ours: `${ours.func}:${ours.line}`, verdict: "allowed (b)" });
      continue;
    }
    const same = ours.kind === gs.kind && ours.line === gs.line && (gs.func === null || ours.func === gs.func);
    rows.push({ seq: gs.seq, cmd: gs.cmd, gdb: `${gs.kind} ${gs.func}:${gs.line}`, ours: `${ours.kind} ${ours.func}:${ours.line}`, verdict: same ? "same" : "DIFFERENT" });
    if (gs.cmd === "fast-forward") {
      assert.deepEqual(ours.lines, gs.ff.lines, "fast-forward line sequence");
      assert.equal(ours.landed, gs.ff.landed);
    }
  }
  for (const r of rows) console.log(`# ${String(r.seq).padStart(3)} ${r.cmd.padEnd(12)} GDB ${r.gdb.padEnd(40)} engine ${r.ours.padEnd(36)} ${r.verdict}`);
  assert.equal(allowedB, 1);
  assert.deepEqual(rows.filter((r) => r.verdict === "DIFFERENT"), []);
});
