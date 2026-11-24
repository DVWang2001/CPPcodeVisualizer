// P1 runtime errors, trace side: error records ({"err":...}, written by vgerr.h on the fd-3 trace channel) are validated
// like stop records, attached to the stop that was running, and returned as runtimeErrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../../gdbgui/static/engine/trace.js";

const { decodeTrace } = T;
const runtimeExit = (errs) => T.runtimeExit(errs); // namespace access: a missing export fails one test, not the file

const enc = (lines) => new TextEncoder().encode(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
const META = {
  lineCount: 12,
  probes: [
    { line: 3, fn: "main", names: ["x"], u: [], w: [] },
    { line: 4, fn: "main", names: ["x"], u: [], w: [] },
    { line: 5, fn: "main", names: ["x"], u: [], w: [] },
  ],
};
const S = [
  { p: 0, line: 3, fn: "main", depth: 1, frame: 1, n: ["x"], d: { x: 2147483647 } },
  { p: 1, line: 4, fn: "main", depth: 1, frame: 1, n: ["x"], d: {} },
  { p: 2, line: 5, fn: "main", depth: 1, frame: 1, n: ["x"], d: { x: -2147483648 } },
];
const OVF = { err: "signed-overflow", fatal: 0, file: "main.cpp", line: 4, col: 9, v: { op: "+", lhs: 2147483647, rhs: 1, type: "'int'" } };
const DIV = { err: "div-by-zero", fatal: 1, file: "main.cpp", line: 5, col: 13, v: { lhs: 7, rhs: 0, type: "'int'" } };

test("an error record is attached to the stop that was running and returned in runtimeErrors", () => {
  const r = decodeTrace(enc([S[0], S[1], OVF, S[2]]), META);
  assert.deepEqual(r.errors, []);
  assert.equal(r.steps.length, 3);
  assert.equal(r.runtimeErrors.length, 1);
  const e = r.runtimeErrors[0];
  assert.equal(e.kind, "signed-overflow");
  assert.equal(e.fatal, false);
  assert.equal(e.step, 1);
  assert.equal(e.line, 4);
  assert.equal(e.col, 9);
  assert.equal(e.inUser, true);
  assert.deepEqual({ ...e.values }, { op: "+", lhs: 2147483647, rhs: 1, type: "int" });
  assert.match(e.message, /signed integer overflow: 2147483647 \+ 1 cannot be represented in type 'int'/);
});

test("a run without error records has an empty runtimeErrors", () => {
  const r = decodeTrace(enc(S), META);
  assert.deepEqual(r.runtimeErrors, []);
});

test("a fatal error must be the last record; anything after it corrupts the trace", () => {
  const ok = decodeTrace(enc([S[0], S[1], S[2], DIV]), META);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.runtimeErrors[0].fatal, true);
  assert.equal(ok.runtimeErrors[0].step, 2);
  const bad = decodeTrace(enc([S[0], S[1], DIV, S[2]]), META);
  assert.equal(bad.errors[0].kind, "trace-corrupted");
  assert.match(bad.errors[0].reason, /after a fatal runtime error/);
  assert.equal(bad.steps.length, 2);
});

test("a libc++ check has no location: it takes the line of the running stop and is marked as library code", () => {
  const rec = { err: "libcxx", fatal: 1, line: 0, col: 0, msg: "/include/c++/v1/vector:1436: assertion __n < size() failed: vector[] index out of bounds " };
  const r = decodeTrace(enc([S[0], S[1], rec]), META);
  const e = r.runtimeErrors[0];
  assert.equal(e.line, 4);
  assert.equal(e.col, null);
  assert.equal(e.inUser, false);
  assert.equal(e.libcxxMessage, "vector[] index out of bounds");
  // -fno-exceptions "throws" have no assertion prefix: the message is kept whole
  const t = decodeTrace(enc([S[0], { err: "libcxx", fatal: 1, line: 0, col: 0, msg: "out_of_range was thrown in -fno-exceptions mode with message \"vector\"" }]), META);
  assert.equal(t.runtimeErrors[0].libcxxMessage, "out_of_range was thrown in -fno-exceptions mode with message \"vector\"");
});

test("an error located in a header (not the student's file) is shown on the running stop's line", () => {
  const rec = { err: "null-deref", fatal: 1, file: "/include/c++/v1/__iterator/wrap_iter.h", line: 50, col: 102, v: { type: "'const Point'", ptr: 0, tck: 0 } };
  const e = decodeTrace(enc([S[0], rec]), META).runtimeErrors[0];
  assert.equal(e.inUser, false);
  assert.equal(e.line, 3);
  assert.equal(e.col, null);
  assert.equal(e.file, "/include/c++/v1/__iterator/wrap_iter.h");
});

test("an error before the first stop (a global initialiser) has step -1", () => {
  const e = decodeTrace(enc([OVF, S[0]]), META).runtimeErrors[0];
  assert.equal(e.step, -1);
  assert.equal(e.line, 4);
});

test("columns are mapped back to the original source through meta.cols", () => {
  // line 4 was edited: original cols 1..8 stay at 1..8, 30 inserted bytes, then original col 9.. at out col 39..
  const meta = { ...META, cols: { 4: [[1, 1, 8], [39, 9, 6]] } };
  const at = (col) => decodeTrace(enc([S[0], S[1], { ...OVF, col }]), meta).runtimeErrors[0].col;
  assert.equal(at(5), 5);
  assert.equal(at(39), 9);
  assert.equal(at(41), 11);
  assert.equal(at(20), 9); // inside inserted text: the original position right after the insertion
  // a line without edits keeps its columns
  const e = decodeTrace(enc([S[0], S[1], S[2], { ...DIV, col: 13 }]), meta).runtimeErrors[0];
  assert.equal(e.col, 13);
});

test("stdout stamps stay aligned when an error record sits between stops", () => {
  const r = decodeTrace(enc([S[0], S[1], OVF, S[2]]), META, { stamps: { out: [0, 2, 2, 5], err: [0, 0, 0, 0] } });
  assert.deepEqual(r.stepOffsets.map((o) => o.out), [0, 2, 5]);
});

test("64-bit values that do not fit a double arrive as decimal strings and are kept exact", () => {
  const rec = { err: "signed-overflow", fatal: 0, file: "main.cpp", line: 4, col: 9, v: { op: "+", lhs: "9223372036854775807", rhs: 1, type: "'long long'" } };
  const e = decodeTrace(enc([S[0], S[1], rec]), META).runtimeErrors[0];
  assert.equal(e.values.lhs, "9223372036854775807");
  assert.match(e.message, /9223372036854775807 \+ 1/);
});

for (const [name, rec] of [
  ["an unknown kind", { ...OVF, err: "format-c-drive" }],
  ["an extra field", { ...OVF, extra: 1 }],
  ["a negative line", { ...OVF, line: -1 }],
  ["a line past the end of the file", { ...OVF, line: 99 }],
  ["fatal that is not 0/1", { ...OVF, fatal: true }],
  ["a value that is an object", { ...OVF, v: { lhs: { a: 1 } } }],
  ["an unknown value name", { ...OVF, v: { __proto__x: 1 } }],
  ["a long string value", { ...OVF, v: { type: "x".repeat(300) } }],
  ["a long message", { err: "libcxx", fatal: 1, line: 0, col: 0, msg: "m".repeat(700) }],
]) {
  test(`an error record with ${name} corrupts the trace`, () => {
    const r = decodeTrace(enc([S[0], rec, S[1]]), META);
    assert.equal(r.errors.length, 1, JSON.stringify(r));
    assert.equal(r.errors[0].kind, "trace-corrupted");
    assert.equal(r.steps.length, 1);
    assert.deepEqual(r.runtimeErrors, []);
  });
}

test("at most 64 recoverable error records are accepted (vgerr.h reports each place once and stops at 64)", () => {
  const recs = [S[0]];
  for (let i = 0; i < 65; i++) recs.push({ ...OVF, col: i + 1 });
  const r = decodeTrace(enc(recs), META);
  assert.equal(r.errors[0].kind, "trace-corrupted");
  assert.equal(r.runtimeErrors.length, 64);
});

test("runtimeExit turns a fatal error into the trap exit LocalGdb shows as a signal", () => {
  const mk = (kind, fatal = true) => ({ kind, fatal, step: 0, line: 1, col: 1, inUser: true, values: {}, message: "m" });
  assert.deepEqual(runtimeExit([mk("div-by-zero")]), { reason: "trap", code: null, trap: "div-zero", message: "m", runtimeError: 0 });
  assert.equal(runtimeExit([mk("signed-overflow", false), mk("null-deref")]).trap, "memory");
  assert.equal(runtimeExit([mk("signed-overflow", false), mk("null-deref")]).runtimeError, 1);
  assert.equal(runtimeExit([mk("libcxx")]).trap, "abort");
  assert.equal(runtimeExit([mk("assert")]).trap, "abort");
  assert.equal(runtimeExit([mk("missing-return")]).trap, "illegal");
  assert.equal(runtimeExit([mk("signed-overflow", false)]), null);
  assert.equal(runtimeExit([]), null);
});
