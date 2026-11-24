// P1 runtime errors in LocalGdb: a recoverable error (overflow, C array out of bounds, ...) stops the program on the
// stop where it happened, like a breakpoint, with reason "runtime-error"; a fatal one ends the run with the existing
// signal stop. Both stopped records carry a "runtime-error" tuple that points into runResult.runtimeErrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { send, stopped, frameLine, newGdb, smallRun, SMALL_SRC } from "./helpers.mjs";

const OVF = { kind: "signed-overflow", fatal: false, step: 1, line: 3, col: 7, inUser: true, values: { op: "+", lhs: 2147483647, rhs: 1, type: "int" }, message: "signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'" };
const DIV = { kind: "div-by-zero", fatal: true, step: 3, line: 5, col: 13, inUser: true, values: { lhs: 7, rhs: 0, type: "int" }, message: "division by zero" };

test("-exec-run stops on the stop where a recoverable error happened, with reason runtime-error", async () => {
  const gdb = newGdb(smallRun({ runtimeErrors: [OVF] }), SMALL_SRC);
  const it = await send(gdb, "-exec-run");
  const s = stopped(it).payload;
  assert.equal(s.reason, "runtime-error");
  assert.equal(s.frame.line, "3");
  assert.deepEqual(s["runtime-error"], { index: "0", kind: "signed-overflow", fatal: "n" });
  assert.ok(it.some((x) => x.type === "console" && /runtime error: signed integer overflow/.test(x.payload)), "the console says what happened");
  // the program goes on: continue runs to the end
  assert.equal(stopped(await send(gdb, "-exec-continue")).payload.reason, "exited-normally");
});

test("-exec-next that arrives on the error's stop reports runtime-error instead of end-stepping-range", async () => {
  const gdb = newGdb(smallRun({ runtimeErrors: [OVF] }), SMALL_SRC);
  await send(gdb, "-break-insert -f 2");
  assert.equal(frameLine(await send(gdb, "-exec-run")), 2);
  const n = stopped(await send(gdb, "-exec-next")).payload;
  assert.equal(n.reason, "runtime-error");
  assert.equal(n.frame.line, "3");
  const n2 = stopped(await send(gdb, "-exec-next")).payload;
  assert.equal(n2.reason, "end-stepping-range");
  assert.equal(n2["runtime-error"], undefined);
});

test("a breakpoint after the error does not hide it; the breakpoint is hit on the next continue", async () => {
  const gdb = newGdb(smallRun({ runtimeErrors: [OVF] }), SMALL_SRC);
  await send(gdb, "-break-insert -f 4");
  assert.equal(stopped(await send(gdb, "-exec-run")).payload.reason, "runtime-error");
  const b = stopped(await send(gdb, "-exec-continue")).payload;
  assert.equal(b.reason, "breakpoint-hit");
  assert.equal(b.frame.line, "4");
});

test("a breakpoint on the error's own stop reports breakpoint-hit and still carries the error", async () => {
  const gdb = newGdb(smallRun({ runtimeErrors: [OVF] }), SMALL_SRC);
  await send(gdb, "-break-insert -f 3");
  const s = stopped(await send(gdb, "-exec-run")).payload;
  assert.equal(s.reason, "breakpoint-hit");
  assert.deepEqual(s["runtime-error"], { index: "0", kind: "signed-overflow", fatal: "n" });
});

test("reverse-continue stops on an error it passes, like on a breakpoint", async () => {
  const gdb = newGdb(smallRun({ runtimeErrors: [OVF] }), SMALL_SRC);
  await send(gdb, "-break-insert -f 5");
  await send(gdb, "-exec-run");
  assert.equal(frameLine(await send(gdb, "-exec-continue")), 5);
  const r = stopped(await send(gdb, "-exec-continue --reverse")).payload;
  assert.equal(r.reason, "runtime-error");
  assert.equal(r.frame.line, "3");
});

test("a fatal error ends the run through the signal stop (SIGFPE for division by zero), which carries the error", async () => {
  const run = smallRun({ runtimeErrors: [DIV], exit: { reason: "trap", code: null, trap: "div-zero", message: "division by zero", runtimeError: 0 } });
  const gdb = newGdb(run, SMALL_SRC);
  const s = stopped(await send(gdb, "-exec-run")).payload;
  assert.equal(s.reason, "signal-received");
  assert.equal(s["signal-name"], "SIGFPE");
  assert.equal(s.frame.line, "5");
  assert.deepEqual(s["runtime-error"], { index: "0", kind: "div-by-zero", fatal: "y" });
  assert.equal(stopped(await send(gdb, "-exec-continue")).payload.reason, "exited-signalled");
});

test("arriving by -exec-next on the stop of a fatal error already carries the error", async () => {
  const run = smallRun({ runtimeErrors: [DIV], exit: { reason: "trap", code: null, trap: "div-zero", message: "division by zero", runtimeError: 0 } });
  const gdb = newGdb(run, SMALL_SRC);
  await send(gdb, "-break-insert -f 4");
  await send(gdb, "-exec-run");
  const n = stopped(await send(gdb, "-exec-next")).payload;
  assert.equal(n.frame.line, "5");
  assert.deepEqual(n["runtime-error"], { index: "0", kind: "div-by-zero", fatal: "y" });
});

test("missing return ends with SIGILL; a run cut at the step limit can be replayed and ends with SIGKILL", async () => {
  const mr = { ...DIV, kind: "missing-return", values: {}, message: "execution reached the end of a value-returning function without returning a value" };
  const g1 = newGdb(smallRun({ runtimeErrors: [mr], exit: { reason: "trap", code: null, trap: "illegal", message: "m", runtimeError: 0 } }), SMALL_SRC);
  assert.equal(stopped(await send(g1, "-exec-run")).payload["signal-name"], "SIGILL");
  const g2 = newGdb(smallRun({ exit: { reason: "step-limit", code: 124, message: "stopped after 200000 recorded steps" } }), SMALL_SRC);
  const s = stopped(await send(g2, "-exec-run")).payload;
  assert.equal(s.reason, "signal-received");
  assert.equal(s["signal-name"], "SIGKILL");
  assert.equal(s.frame.line, "5");
});
