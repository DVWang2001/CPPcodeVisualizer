// Requirement 7 / spec F8: bits/stdc++.h, bits/extc++.h (pb_ds) and the std::__gcd / __int64 shims
// compile; class-based examples compile WITHOUT instrumentation (opts.instrument=false) while the
// instrumenter refuses them explicitly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadNodeEngine, ROOT } from "./node_driver.mjs";
import { gxxRun, gxxVersion } from "./gxx.mjs";

const E1 = path.join(ROOT, "experiments", "frontend-only", "e1");
const OOP = path.join(ROOT, "examples", "cpp", "cf_oop");
const GXX = gxxVersion();
let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

const read = (p) => fs.readFileSync(p, "utf8");
const inputOf = (jsonPath) => { try { return JSON.parse(read(jsonPath)).program_input || ""; } catch { return ""; } };

for (const id of ["CC-2602B", "CC-2603B", "CC-2604B", "CC-2605B", "CC-2606B", "CC-2608B"]) {
  test(`${id} (std::__gcd${id === "CC-2602B" ? ", __int64" : ""}) compiles and runs uninstrumented; instrumenter refuses the class`, async () => {
    const src = read(path.join(OOP, id + ".cpp"));
    const stdin = inputOf(path.join(OOP, id + ".gdbgui.json"));
    const r = await eng.runProgram(src, stdin, { instrument: false });
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
    assert.equal(r.exit.reason, "exit");
    assert.equal(r.instrumented, false);
    assert.equal(r.steps.length, 0);
    if (GXX) {
      const g = gxxRun(src, stdin);
      assert.ok(g.ok, g.log);
      assert.equal(r.stdout, g.stdout);
    } else assert.ok(r.stdout.length > 0);
    const ri = await eng.runProgram(src, stdin);
    assert.equal(ri.ok, false);
    assert.equal(ri.errors[0].kind, "unsupported");
    assert.match(ri.errors[0].message, /^unsupported construct: class member function \(line \d+\)$/);
  });
}

test("std::__gcd works for signed/unsigned/__int64 alongside libc++'s <numeric> template", async () => {
  const src = `#include <bits/stdc++.h>
using namespace std;
int main() {
    __int64 a = -12, b = 18;
    cout << __gcd(a, b) << " " << std::__gcd(12u, 18u) << " " << __gcd(0, 5) << " " << gcd(12, 18) << "\\n";
    int arr[5] = {1, 2, 3, 4, 5};
    rotate(arr, arr + 2, arr + 5);
    cout << arr[0] << arr[4] << "\\n";
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
  // libstdc++'s std::__gcd is plain Euclid on the given (signed) values: __gcd(-12, 18) == 6
  assert.equal(r.stdout, "6 6 5 6\n32\n");
  if (GXX) assert.equal(r.stdout, gxxRun(src, "").stdout);
});

for (const std of ["c++17", "c++20", "c++23"]) {
  test(`bits/stdc++.h (${std}) compiles, instrumented, and matches the C++17 reference output`, async () => {
    const src = read(path.join(E1, "cases", "stdcpp.cpp"));
    const r = await eng.runProgram(src, "", { std });
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
    const expected = GXX ? gxxRun(src, "").stdout : "13 2 1 4 2 5 00000101 0042\n";
    assert.equal(r.stdout, expected);
  });
}

test("bits/extc++.h (pb_ds full case) matches the production GCC 14.2 reference output", async () => {
  const src = read(path.join(E1, "cases", "pbds_full.cpp"));
  const ref = read(path.join(E1, "cases", "pbds_full.gcc-ref.txt")).replace(/\r\n/g, "\n");
  const r = await eng.runProgram(src, "", { instrument: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
  assert.equal(r.stdout, ref);
  const ri = await eng.runProgram(src, "");
  assert.equal(ri.ok, true, "pb_ds program also instruments: " + JSON.stringify(ri.errors).slice(0, 800));
  assert.equal(ri.stdout, ref);
  assert.ok(ri.steps.length > 10);
});

test("bits/extc++.h small case matches local g++", async () => {
  const src = read(path.join(E1, "cases", "extcpp.cpp"));
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
  assert.equal(r.stdout, GXX ? gxxRun(src, "").stdout : "3 3\n4\n1\n");
});

test("C++17 features (optional, structured bindings, if constexpr) and C++20/23 cases", async () => {
  const hello = read(path.join(E1, "cases", "hello17.cpp"));
  const h = await eng.runProgram(hello, "vgdb\n", { instrument: false });
  assert.equal(h.ok, true, JSON.stringify(h.errors).slice(0, 800));
  assert.equal(h.stdout, "Hello, vgdb 3 3\n");
  const hi = await eng.runProgram(hello, "vgdb\n"); // `if constexpr` is refused by the instrumenter, explicitly
  assert.equal(hi.errors[0].message, "unsupported construct: if constexpr (line 7)");
  for (const [file, std] of [["cxx20.cpp", "c++20"], ["cxx23.cpp", "c++23"]]) {
    const r = await eng.runProgram(read(path.join(E1, "cases", file)), "", { std, instrument: false });
    assert.equal(r.ok, true, file + " " + JSON.stringify(r.errors).slice(0, 800));
    assert.equal(r.exit.reason, "exit");
  }
});

test("a syntax error returns the clang diagnostics of the ORIGINAL source (not the instrumented one)", async () => {
  const r = await eng.runProgram("int main() {\n    int x = ;\n    return 0;\n}\n", "");
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].kind, "compile");
  assert.match(r.errors[0].message, /main\.cpp:2:\d+: error: expected expression/);
});
