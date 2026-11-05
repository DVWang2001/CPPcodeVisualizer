// S1 host stamps: per-stop stdout/stderr byte offsets (exec.worker.js stamps -> trace.js stepOffsets).
// Unit tests need no compiler; the integration tests compile two small programs once each.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { decodeTrace } from "../../gdbgui/static/engine/trace.js";
import { loadNodeEngine } from "./node_driver.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const META = {
  lineCount: 10,
  probes: [
    { line: 3, fn: "main", names: ["x"], u: [], w: [] },
    { line: 4, fn: "main", names: ["x"], u: [], w: [] },
  ],
};
const bytesOf = (recs) => enc.encode(recs.map((r) => JSON.stringify(r) + "\n").join(""));
const rec = (p, d) => ({ p, line: META.probes[p].line, fn: "main", depth: 1, frame: 1, n: ["x"], d });

// records: line 3 (x=1), line 4 (x=5), line 4 again (merged into the same stop), line 3 (no change)
const RECS = [rec(0, { x: 1 }), rec(1, { x: 5 }), rec(1, {}), rec(0, {})];

test("s1 stamps: one offset per stop, taken from the first record of a merged stop", () => {
  const r = decodeTrace(bytesOf(RECS), META, { stamps: { out: [0, 0, 2, 5], err: [0, 0, 0, 0] } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.stepOffsets, [{ out: 0, err: 0 }, { out: 0, err: 0 }, { out: 5, err: 0 }]);
});

test("s1 stamps: a stamp count that does not match the record count gives null offsets", () => {
  const r = decodeTrace(bytesOf(RECS), META, { stamps: { out: [0, 0, 2], err: [0, 0, 0] } });
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.stepOffsets, [{ out: null, err: null }, { out: null, err: null }, { out: null, err: null }]);
});

test("s1 stamps: decreasing stamps are refused (null offsets)", () => {
  const r = decodeTrace(bytesOf(RECS), META, { stamps: { out: [0, 4, 2, 5], err: [0, 0, 0, 0] } });
  assert.ok(r.stepOffsets.every((o) => o.out === null && o.err === null));
});

test("s1 stamps: without stamps the offsets exist but are null (existing callers unaffected)", () => {
  const r = decodeTrace(bytesOf(RECS), META);
  assert.equal(r.stepOffsets.length, r.steps.length);
  assert.ok(r.stepOffsets.every((o) => o.out === null && o.err === null));
  assert.deepEqual(r.steps.map((s) => s.line), [3, 4, 3]);
});

test("s1 stamps: malformed stamps objects are ignored, steps are not truncated (verifier P4)", () => {
  const good = decodeTrace(bytesOf(RECS), META);
  for (const bad of [{}, { out: 5, err: 5 }, { out: [0] }]) {
    const r = decodeTrace(bytesOf(RECS), META, { stamps: bad });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.steps, good.steps);
    assert.ok(r.stepOffsets.every((o) => o.out === null && o.err === null));
  }
});

test("s1 stamps: a trace error keeps the steps before it but drops all offsets", () => {
  const bad = enc.encode(JSON.stringify(rec(0, { x: 1 })) + "\n" + "{not json}\n");
  const r = decodeTrace(bad, META, { stamps: { out: [0, 1], err: [0, 0] } });
  assert.equal(r.errors.length, 1);
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.stepOffsets, [{ out: null, err: null }]);
});

// ---- integration: real compile + run through the same path the browser uses ----
let engine;
before(async () => {
  engine = await loadNodeEngine();
  // warm the PCH cache: the first compile of a fresh engine builds it and can exceed the 8 s budget on a loaded host
  await engine.runProgram("#include <iostream>\nint main() { return 0; }\n", "", {});
});
after(() => engine && engine.dispose());

const PROG_ENDL = [
  "#include <iostream>",
  "int main() {",
  "  int a = 1;",
  '  std::cout << "one" << std::endl;',
  "  int b = 2;",
  '  std::cout << "two\\n";',
  "  return a + b - 3;",
  "}",
  "",
].join("\n");

test("s1 integration: stdout bytes sliced by the stop offsets give the output of each line (endl flushes)", async () => {
  const r = await engine.runProgram(PROG_ENDL, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stepOffsets.length, r.steps.length);
  const bytes = enc.encode(r.stdout);
  const segs = r.steps.map((s, k) => {
    const o = r.stepOffsets[k];
    const next = k + 1 < r.stepOffsets.length ? r.stepOffsets[k + 1].out : bytes.length;
    return { line: s.line, text: dec.decode(bytes.subarray(o.out, next)) };
  });
  const printed = segs.filter((s) => s.text !== "");
  assert.deepEqual(printed, [{ line: 4, text: "one\n" }, { line: 6, text: "two\n" }]);
  // offsets are byte positions: they never exceed the stdout length and never go backwards
  const outs = r.stepOffsets.map((o) => o.out);
  assert.ok(outs.every((v) => Number.isInteger(v) && v >= 0 && v <= bytes.length));
  assert.ok(outs.every((v, i) => i === 0 || v >= outs[i - 1]));
});

test("s1 integration: segments always concatenate to the full stdout (no byte is lost or duplicated)", async () => {
  const src = PROG_ENDL.replace("std::endl", "std::flush");
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const bytes = enc.encode(r.stdout);
  let joined = "";
  r.steps.forEach((s, k) => {
    const o = r.stepOffsets[k];
    const next = k + 1 < r.stepOffsets.length ? r.stepOffsets[k + 1].out : bytes.length;
    joined += dec.decode(bytes.subarray(o.out, next));
  });
  assert.equal(joined, r.stdout);
});
