// Warm-up before the first Run (無感加載): engine.warmUp() compiles small programs with the #include lines of the
// program in the editor and of the common lesson preludes, so the Run finds their PCH ready and a warm compiler.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";
import { warmSources, WARM_PRELUDES, LIMITS } from "../../gdbgui/static/engine/index.js";

const inc = (ws) => ws.map((w) => w.includes.join(","));

test("the default compile budget is 9.5 s, which is also the max", () => {
  assert.equal(LIMITS.compileTimeoutMs, 9500);
  assert.equal(LIMITS.maxCompileTimeoutMs, 9500);
  assert.ok(LIMITS.warmTimeoutMs > LIMITS.maxCompileTimeoutMs);
});

test("warmSources: the editor program's include list first, then each prelude with a different list", () => {
  assert.deepEqual(WARM_PRELUDES.map((p) => p.join(",")), ["iostream,vector", "iostream"]);
  assert.deepEqual(inc(warmSources()), ["iostream,vector", "iostream"]);
  assert.deepEqual(inc(warmSources("")), ["iostream,vector", "iostream"]);
  const src = "#include <iostream>\n#include <cmath>\n#include <vector>\nusing namespace std;\nint main() { return 0; }\n";
  assert.deepEqual(inc(warmSources(src)), ["iostream,cmath,vector", "iostream,vector", "iostream"]);
  assert.deepEqual(inc(warmSources("#include <iostream>\n#include <vector>\nint main() {}\n")), ["iostream,vector", "iostream"]);
  assert.deepEqual(inc(warmSources(src, [["iostream", "vector"]])), ["iostream,cmath,vector", "iostream,vector"]);
  assert.deepEqual(inc(warmSources(src, [])), ["iostream,cmath,vector"]);
  // an include the PCH cannot take (quoted) means the Run builds no PCH: only the preludes are warmed
  assert.deepEqual(inc(warmSources('#include "my.h"\n#include <iostream>\nint main() {}\n')), ["iostream,vector", "iostream"]);
  // duplicates collapse like pchIncludes; bad prelude entries are ignored
  assert.deepEqual(inc(warmSources("#include <iostream>\n#include <iostream>\n", [])), ["iostream"]);
  assert.deepEqual(inc(warmSources("", [["io stream"], [], /** @type {any} */ ("x"), /** @type {any} */ ([1])])), []);
  // the warm program carries exactly those include lines, in order (the PCH key is the ordered list)
  const lines = warmSources(src)[0].source.split("\n").filter((l) => l.startsWith("#include"));
  assert.deepEqual(lines, ["#include <iostream>", "#include <cmath>", "#include <vector>"]);
});

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

test("every kind of warm program compiles and runs cleanly (vector/cout body, plain body, bits/stdc++.h)", async () => {
  const progs = [...warmSources(), ...warmSources("#include <cstdio>\n", []), ...warmSources("#include <bits/stdc++.h>\n", [])];
  assert.deepEqual(inc(progs), ["iostream,vector", "iostream", "cstdio", "bits/stdc++.h"]);
  for (const w of progs) {
    const r = await eng.runProgram(w.source, "");
    assert.equal(r.ok, true, w.includes + ": " + JSON.stringify(r.errors).slice(0, 600));
    assert.deepEqual([r.exit.reason, r.exit.code], ["exit", 0], w.includes + ": " + JSON.stringify(r.exit));
    assert.deepEqual(r.runtimeErrors, [], w.includes);
    console.log(`# warm ${w.includes}: compile ${Math.round(r.timings.compile)} ms, pch ${r.pchFrom}, stdout ${JSON.stringify(r.stdout)}`);
  }
});

test("warmUp builds the PCH of the editor program's #include lines; the Run that follows takes it from memory", async () => {
  const e = await loadNodeEngine();
  try {
    const src = "#include <iostream>\n#include <cmath>\nusing namespace std;\nint main() {\n  double x = sqrt(16.0);\n  cout << x << endl;\n  return 0;\n}\n";
    const w = await e.warmUp({ source: src, preludes: [["iostream", "vector"]] });
    assert.deepEqual(w.map((x) => [x.includes.join(","), x.ok, x.pchFrom]), [["iostream,cmath", true, "built"], ["iostream,vector", true, "built"]]);
    console.log(`# warmUp: ${w.map((x) => `${x.includes} ${x.ms} ms`).join(", ")}`);
    const r = await e.runProgram(src, "");
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 600));
    assert.equal(r.pchFrom, "memory");
    assert.equal(r.stdout, "4\n");
    console.log(`# Run after warmUp: compile ${Math.round(r.timings.compile)} ms`);
  } finally {
    e.dispose();
  }
});

test("a Run requested before a queued warm-up starts skips the warm-up entirely", async () => {
  const e = await loadNodeEngine();
  try {
    const wp = e.warmUp(); // queued: its first program has not started yet
    const rp = e.runProgram("int main() {\n  return 0;\n}\n", "");
    const [w, r] = await Promise.all([wp, rp]);
    assert.deepEqual(w, []);
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 600));
    // and a warm-up after dispose does nothing
    e.dispose();
    assert.deepEqual(await e.warmUp(), []);
  } finally {
    e.dispose();
  }
});
