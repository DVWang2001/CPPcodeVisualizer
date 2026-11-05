// S3: after-state of each stop (variables changed by its line, output it printed).
// Unit tests need no compiler; the integration tests compile a few small programs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { nextInFrame, diffVars, afterStates } from "../../gdbgui/static/engine/localgdb/afterState.js";
import { loadNodeEngine } from "./node_driver.mjs";

const enc = new TextEncoder();
const st = (line, vars, extra = {}) => ({ line, fn: "main", depth: 1, frame: 1, vars, ...extra });

test("nextInFrame: next stop of the same activation; deeper stops are skipped", () => {
  const steps = [
    st(3, {}),
    st(4, { x: 1 }, { depth: 2, frame: 2, fn: "f" }),   // callee
    st(5, { x: 1 }, { depth: 2, frame: 2, fn: "f" }),   // callee
    st(7, { x: 1 }),                                       // back in main
  ];
  assert.equal(nextInFrame(steps, 0), 3);
  assert.equal(nextInFrame(steps, 1), 2);
  assert.equal(nextInFrame(steps, 3), -1);
});

test("diffVars: added, changed and unchanged variables", () => {
  const d = diffVars({ a: 1, b: 2 }, { a: 1, b: 5, c: "x" });
  assert.deepEqual(d, [
    { name: "b", from: 2, to: 5, existed: true },
    { name: "c", from: undefined, to: "x", existed: false },
  ]);
  assert.deepEqual(diffVars({ v: [1, 2] }, { v: [1, 2] }), []);
  assert.deepEqual(diffVars({ v: [1, 2] }, { v: [1, 3] }), [{ name: "v", from: [1, 2], to: [1, 3], existed: true }]);
});

test("afterStates: a stop's after-state is the next stop of its activation, with the variables it changed", () => {
  const steps = [st(3, {}), st(4, { x: 1 }), st(5, { x: 5 }), st(6, { x: 5 })];
  // "hi" is written between the stamp of line 5 (k=2) and the stamp of line 6 (k=3)
  const offs = [{ out: 0, err: 0 }, { out: 0, err: 0 }, { out: 0, err: 0 }, { out: 2, err: 0 }];
  const r = afterStates({ steps, stepOffsets: offs, stdout: enc.encode("hi"), stderr: enc.encode(""), exit: { reason: "exit" } });
  assert.deepEqual(r[1].after, { kind: "stop", line: 5, changed: [{ name: "x", from: 1, to: 5, existed: true }] });
  assert.equal(r[1].stdout, "");
  assert.equal(r[2].stdout, "hi");           // printed by line 5 (between its stamp and line 6's)
  assert.equal(r[3].stdout, "");             // the last stop: from its own stamp to the end
});

test("afterStates: the last stop of main is program-end; a stop with no later same-activation stop is frame-exit", () => {
  const steps = [st(3, {}), st(9, { x: 1 }, { depth: 2, frame: 2, fn: "f" }), st(10, {}, { depth: 2, frame: 2, fn: "f" }), st(4, { x: 1 })];
  const offs = steps.map(() => ({ out: 0, err: 0 }));
  const r = afterStates({ steps, stepOffsets: offs, stdout: enc.encode(""), stderr: enc.encode(""), exit: { reason: "exit" } });
  assert.equal(r[2].after.kind, "frame-exit");   // line 10 is the callee's closing brace
  assert.equal(r[3].after.kind, "program-end");  // main's last stop
});

test("afterStates: when the run did not finish normally, a stop without a successor is unfinished, not an exit", () => {
  const steps = [st(3, {}), st(4, { p: 0 })];
  const offs = steps.map(() => ({ out: 0, err: 0 }));
  const r = afterStates({ steps, stepOffsets: offs, stdout: enc.encode(""), stderr: enc.encode(""), exit: { reason: "trap" } });
  assert.deepEqual(r[1].after, { kind: "unfinished", reason: "trap", changed: [] });
});

test("afterStates: null offsets give null output (never a guessed attribution)", () => {
  const steps = [st(3, {}), st(4, {})];
  const offs = [{ out: null, err: null }, { out: null, err: null }];
  const r = afterStates({ steps, stepOffsets: offs, stdout: enc.encode("x"), stderr: enc.encode(""), exit: { reason: "exit" } });
  assert.equal(r[0].stdout, null);
  assert.equal(r[1].stdout, null);
});

// ---- integration ----
let eng;
before(async () => {
  eng = await loadNodeEngine();
  await eng.runProgram("#include <iostream>\nint main() { return 0; }\n", "", {});
});
after(() => eng && eng.dispose());

async function runAfter(src) {
  const r = await eng.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return afterStates({ steps: r.steps, stepOffsets: r.stepOffsets, stdout: enc.encode(r.stdout), stderr: enc.encode(r.stderr || ""), exit: r.exit });
}

test("integration: the line that declares b changes b from undefined to 2; the line that prints shows its text", async () => {
  const src = [
    "#include <iostream>",
    "int main() {",
    "  int a = 1;",
    '  std::cout << "one" << std::endl;',
    "  int b = 2;",
    "  return a + b - 3;",
    "}",
    "",
  ].join("\n");
  const r = await runAfter(src);
  const lineB = r.find((x) => x.line === 5);
  assert.deepEqual(lineB.after, { kind: "stop", line: 6, changed: [{ name: "b", from: undefined, to: 2, existed: false }] });
  const printLine = r.find((x) => x.line === 4);
  assert.equal(printLine.stdout, "one\n");
  assert.equal(r[r.length - 1].after.kind, "program-end");
});

test("integration: a loop body line's after-state changes i by one each time", async () => {
  const src = [
    "#include <iostream>",
    "int main() {",
    "  for (int i = 0; i < 3; i++) {",
    "    std::cout << i;",
    "  }",
    '  std::cout << "\\n";',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const r = await runAfter(src);
  const bodies = r.filter((x) => x.line === 4);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((x) => x.stdout), ["0", "1", "2"]);
});
