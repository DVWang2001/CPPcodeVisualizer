// S2 per-line attribution: stdout printed by a line is stamped between that line's stop and the next stop.
// Needs a compiler (integration). The same programs without flushing were wrong before S2 (see S0b report).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
let engine;
before(async () => {
  engine = await loadNodeEngine();
  await engine.runProgram("#include <iostream>\nint main() { return 0; }\n", "", {}); // warm the PCH
});
after(() => engine && engine.dispose());

function perLine(r) {
  const bytes = enc.encode(r.stdout);
  return r.steps.map((s, k) => {
    const o = r.stepOffsets[k];
    const next = k + 1 < r.stepOffsets.length ? r.stepOffsets[k + 1].out : bytes.length;
    return { line: s.line, text: dec.decode(bytes.subarray(o.out, next)) };
  }).filter((x) => x.text !== "");
}

test("s2: cout without endl/flush is attributed to the line that printed it", async () => {
  const src = [
    "#include <iostream>",
    "int main() {",
    "  int a = 1;",
    '  std::cout << "one";',
    "  int b = 2;",
    '  std::cout << "two\\n";',
    "  return a + b - 3;",
    "}",
    "",
  ].join("\n");
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(perLine(r), [{ line: 4, text: "one" }, { line: 6, text: "two\n" }]);
});

test("s2: printf without newline is attributed to its line", async () => {
  const src = [
    "#include <cstdio>",
    "#include <iostream>",
    "int main() {",
    "  int a = 1;",
    '  printf("one");',
    "  int b = 2;",
    '  printf("two\\n");',
    "  return a + b - 3;",
    "}",
    "",
  ].join("\n");
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(perLine(r), [{ line: 5, text: "one" }, { line: 7, text: "two\n" }]);
});

test("s2: digits printed one per loop iteration are each attributed to the loop body line", async () => {
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
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(perLine(r), [
    { line: 4, text: "0" }, { line: 4, text: "1" }, { line: 4, text: "2" }, { line: 6, text: "\n" },
  ]);
});

// KNOWN LIMITATION (for S3): text the caller prints AFTER a call returns (here "6\n", written by endl on line 7)
// is stamped before the caller's next stop, so it is attributed to the callee's last stop (line 5, the closing brace).
// The text printed before the call (here "value ") is correctly attributed to the caller's line 7.
test("s2 known limitation: output before a call goes to the caller's line; output after it goes to the callee's last stop", async () => {
  const src = [
    "#include <iostream>",
    "int f(int n) {",
    "  int result = n * 2;",
    "  return result;",
    "}",
    "int main() {",
    '  std::cout << "value " << f(3) << std::endl;',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(perLine(r), [{ line: 7, text: "value " }, { line: 5, text: "6\n" }]);
});

// Regression guard only: this passes with or without the flush (stdout bytes and stops do not depend on it).
// The attribution tests above are the ones that detect the flush.
test("s2 regression guard: stdout and stops of a simple program are unchanged", async () => {
  const src = "#include <iostream>\nint main() {\n  int x = 1;\n  x = 5;\n  std::cout << x << std::endl;\n  return 0;\n}\n";
  const r = await engine.runProgram(src, "", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "5\n");
  assert.deepEqual(r.steps.map((s) => s.line), [3, 4, 5, 6, 7]);
});
