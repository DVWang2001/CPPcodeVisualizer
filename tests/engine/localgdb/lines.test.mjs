// next/step stop when the LINE changes (verifier finding from the real-UI lesson sweep): a later step of the same frame on the
// same line as the origin is not a new stop - e.g. the then-branch of `if (f(x)) cout << ...;` after the callee ran - and
// neither is the rest of the caller's call line after returning; a loop-header line's breakpoint hits at loop entry only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, stopped, frameLine, newGdb } from "./helpers.mjs";

const SRC = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "lines.cpp"), "utf8");
let eng, run;
before(async () => { eng = await loadNodeEngine(); run = await eng.runProgram(SRC, ""); });
after(() => eng && eng.dispose());
const at = async (line) => { const g = newGdb(run, SRC); await send(g, `-break-insert -f ${line}`); await send(g, "-exec-run"); return g; };

test("fixture trace has the second probe on line 8 (then-branch after the callee) - the situation of the bug", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const seq = run.steps.slice(0, 8).map((s) => `${s.fn}:${s.line}`);
  assert.deepEqual(seq.slice(0, 7), ["main:7", "main:8", "pal:3", "pal:4", "pal:5", "main:8", "main:9"]);
});

test("next over a call in an if condition: line 8 is ONE stop (7, 8, 9), not 8 twice", async () => {
  const g = await at(7);
  assert.equal(frameLine(await send(g, "-exec-next")), 8);
  assert.equal(frameLine(await send(g, "-exec-next")), 9);
});

test("step into the callee and out again: 8, 3, 4, 5, then the NEXT line 9 (the rest of line 8 is skipped)", async () => {
  const g = await at(7);
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(frameLine(await send(g, "-exec-step")));
  assert.deepEqual(lines, [8, 3, 4, 5, 9]);
});

test("next from the callee's `}` returns and stops on the caller's next line; finish still stops mid-line on the call", async () => {
  const g = await at(5);
  assert.equal(frameLine(await send(g, "-exec-next")), 9);
  const f = await at(4);
  const fin = await send(f, "-exec-finish");
  assert.deepEqual([stopped(fin).payload.reason, frameLine(fin)], ["function-finished", 8]);
  assert.equal(frameLine(await send(f, "-exec-next")), 9, "after finish, next goes to the next line");
});

test("reverse: next/step backwards do not stop twice on the same line either", async () => {
  const g = await at(9);
  assert.equal(frameLine(await send(g, "-exec-next --reverse")), 8);
  assert.equal(frameLine(await send(g, "-exec-next --reverse")), 7);
  const h = await at(9);
  assert.equal(frameLine(await send(h, "-exec-step --reverse")), 8, "the most recent line is 8 (its second half ran last)");
  assert.equal(frameLine(await send(h, "-exec-step --reverse")), 5, "then back into the callee");
  assert.equal(frameLine(await send(h, "-exec-step --reverse")), 4);
});

test("for-header stops keep their pseudo addresses: init once, increment after each body (different addresses)", async () => {
  const g = await at(9);
  const addrs = [];
  let line = 9;
  const first = payloadOf(await send(g, "1-stack-list-frames")).stack[0].addr;
  addrs.push([9, first]);
  for (let i = 0; i < 4; i++) { const it = await send(g, "-exec-next"); addrs.push([frameLine(it), stopped(it).payload.frame.addr]); }
  assert.deepEqual(addrs.map((a) => a[0]), [9, 10, 9, 10, 9]);
  assert.notEqual(addrs[0][1], addrs[2][1]);
  assert.equal(addrs[2][1], addrs[4][1]);
  void line;
});

test("a breakpoint on a loop-header line (`for`, `while`) hits at loop ENTRY only, not at every re-evaluation (the lesson bundle's recorded hit counts)", async () => {
  const g = newGdb(run, SRC);
  await send(g, ["-break-insert -f 9", "-break-insert -f 13", "-break-insert -f 14"]);
  let it = await send(g, "-exec-run");
  const hits = [];
  while (stopped(it) && !/^exited/.test(stopped(it).payload.reason)) { hits.push(frameLine(it)); it = await send(g, "-exec-continue"); }
  assert.deepEqual(hits, [9, 13, 14, 14, 14], "line 9 once, line 13 once, the body line 14 every iteration");
  const t = payloadOf(await send(g, "-break-list")).BreakpointTable.body.map((b) => [b.line, b.times]);
  assert.deepEqual(t, [["9", "1"], ["13", "1"], ["14", "3"]]);
});
