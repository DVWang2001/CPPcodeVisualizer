// Watchdogs (plan §6 M2): compile/AST time budget with pipeline-worker respawn, and the execution
// wall-clock terminate().
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

const OK = `#include <iostream>
int main() {
    int s = 0;
    for (int i = 0; i < 3; ++i) s += i;
    std::cout << s << "\\n";
    return 0;
}
`;

// Template-driven constexpr bomb: 900 nested instantiations, each forcing a ~1M-step constant
// evaluation. Memory stays small; clang's semantic analysis alone (the AST stage) takes minutes.
const BOMB = `#include <iostream>
constexpr long burn(int k) {
    long s = 0;
    for (int i = 0; i < 300000; ++i) s += i ^ k;
    return s;
}
template <int N> struct T { static constexpr long v = burn(N) + T<N - 1>::v; };
template <> struct T<0> { static constexpr long v = 0; };
int main() {
    std::cout << (T<900>::v & 1) << "\\n";
    return 0;
}
`;

test("warm-up: a normal program compiles (PCH built outside the student budget)", async () => {
  const r = await eng.runProgram(OK, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "3\n");
});

for (const instrument of [true, false]) {
  test(`compile bomb (instrument=${instrument}) is stopped within 10 s, worker respawned, next run works`, async () => {
    const before = eng.respawns;
    const t0 = performance.now();
    const r = await eng.runProgram(BOMB, "", { instrument });
    const ms = performance.now() - t0;
    console.log(`# compile bomb instrument=${instrument}: ${Math.round(ms)} ms, errors=${JSON.stringify(r.errors)}`);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].kind, "compile-timeout", JSON.stringify(r.errors));
    assert.ok(ms < 10000, `returned after ${ms} ms`);
    assert.equal(eng.respawns, before + 1);
    const again = await eng.runProgram(OK, "");
    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.stdout, "3\n");
  });
}

test("for(;;){} without any probe is terminated by the wall-clock watchdog", async () => {
  const src = `int main() {
    for (;;) {}
}
`;
  const t0 = performance.now();
  const r = await eng.runProgram(src, "", { execTimeoutMs: 1500 });
  const ms = performance.now() - t0;
  assert.equal(r.exit.reason, "timeout");
  assert.ok(r.timings.exec >= 1400 && r.timings.exec < 4000, `exec ${r.timings.exec} ms`);
  assert.ok(ms < 15000);
});

test("while(true) x++ with probes hits the 200000-step limit and keeps the trace", async () => {
  const src = `int main() {
    long long x = 0;
    while (true) {
        x++;
    }
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.exit.reason, "step-limit", JSON.stringify(r.exit));
  assert.equal(r.rawSteps, 200000);
  assert.ok(r.steps.length > 1000);
});

test("execution timeout is clamped to 30 s and compile budget to 9.5 s", async () => {
  const { normalizeRequest } = await import("../../gdbgui/static/engine/index.js");
  const q = normalizeRequest("int main(){}", "", { execTimeoutMs: 1e9, compileTimeoutMs: 1e9 });
  assert.equal(q.execTimeoutMs, 30000);
  assert.equal(q.compileTimeoutMs, 9500);
  assert.throws(() => normalizeRequest("int main(){}", "", { evil: 1 }), /unknown option/);
  assert.throws(() => normalizeRequest(42, ""), /source must be a string/);
  assert.throws(() => normalizeRequest("x".repeat(300 * 1024), ""), /larger than/);
  assert.throws(() => normalizeRequest("int main(){}", "", { std: "c++98" }), /std must be/);
});
