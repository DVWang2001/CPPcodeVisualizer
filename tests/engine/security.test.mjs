// Security negative tests (contract §5, plan §6 M1/M2/M3). Each test is the concrete
// exploit/failure scenario the mechanism exists for; see README "Threat model" for the mapping.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";
import { inspectWasm } from "./wasm_inspect.mjs";

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

const HELLO = `#include <iostream>
int main() {
    int a = 1;
    a = a + 1;
    std::cout << a << "\\n";
    return 0;
}
`;

// ---------------------------------------------------------------- M1: frozen WASI import object
test("M1: a program importing env.x is rejected before instantiation", async () => {
  const src = `#include <cstdio>
__attribute__((import_module("env"), import_name("x"))) int host_x(int);
int main() {
    int r = host_x(41);
    std::printf("%d\\n", r);
    return 0;
}
`;
  for (const instrument of [true, false]) {
    const r = await eng.runProgram(src, "", { instrument });
    assert.equal(r.ok, false);
    assert.equal(r.exit.reason, "forbidden-import");
    assert.ok(r.errors.some((e) => e.kind === "forbidden-import" && e.imports.includes("env.x (function)")), JSON.stringify(r.errors));
    assert.equal(r.stdout, "");
  }
});

test("M1: path_open and sock_send return ENOSYS (52); no filesystem is reachable", async () => {
  const src = `#include <wasi/api.h>
#include <cstdio>
#include <fstream>
#include <iostream>
int main() {
    __wasi_fd_t fd = 0;
    int r1 = __wasi_path_open(3, 0, "secret.txt", 0, 0, 0, 0, &fd);
    const char msg[] = "hi";
    __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(msg), 2};
    __wasi_size_t n = 0;
    int r2 = __wasi_sock_send(0, &io, 1, 0, &n);
    std::FILE* f = std::fopen("/etc/passwd", "r");
    std::ofstream out("x.txt");
    std::printf("%d %d %d %d\\n", r1, r2, f == nullptr, (int)out.is_open());
    return 0;
}
`;
  const r = await eng.runProgram(src, "", { instrument: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "52 52 1 0\n");
  assert.equal(r.nosys.path_open, 1);
  assert.equal(r.nosys.sock_send, 1);
});

// ---------------------------------------------------------------- M2: resource limits
test("M2: linker caps linear memory at 512 MiB with an 8 MiB stack placed first", async () => {
  const r = await eng.runProgram(HELLO, "", { returnWasm: true });
  assert.equal(r.ok, true);
  const w = inspectWasm(r.wasm);
  assert.equal(w.memory.maxPages * 65536, 536870912);
  assert.equal(w.stackPointerInit, 8388608); // --stack-first: stack occupies [0, 8 MiB), overflow goes below 0 and traps
  assert.equal(w.importedMemory, false);
});

test("M2: vector<char>(3e9) aborts cleanly (no host memory blow-up)", async () => {
  const src = `#include <vector>
#include <iostream>
int main() {
    std::vector<char> v(3000000000u);
    std::cout << v.size() << "\\n";
    return 0;
}
`;
  const t0 = performance.now();
  const r = await eng.runProgram(src, "");
  assert.equal(r.exit.reason, "trap", JSON.stringify(r.exit));
  assert.equal(r.exit.trap, "abort");
  assert.equal(r.stdout, "");
  assert.ok(performance.now() - t0 < 15000);
});

test("M2: a loop of new char[1<<30] aborts at the 512 MiB cap", async () => {
  for (const shift of [30, 26]) {
    const src = `#include <iostream>
int main() {
    long long total = 0;
    for (;;) {
        char* p = new char[1 << ${shift}];
        p[0] = 1;
        total += 1 << ${shift};
        std::cout << total << "\\n";
    }
}
`;
    const r = await eng.runProgram(src, "", { instrument: false });
    assert.equal(r.exit.reason, "trap", JSON.stringify(r.exit));
    assert.equal(r.exit.trap, "abort");
    const printed = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    const last = printed.length ? printed[printed.length - 1] : 0;
    assert.ok(last < 536870912, `allocated ${last} bytes before abort`);
    if (shift === 26) assert.ok(printed.length >= 5, "several 64 MiB blocks fit below the cap: " + printed.length);
  }
});

test("M2: an infinite 1 MB print loop stops at the stdout cap", async () => {
  const src = `#include <iostream>
#include <string>
int main() {
    std::string s(1 << 20, 'x');
    for (;;) std::cout << s;
}
`;
  const t0 = performance.now();
  const r = await eng.runProgram(src, "", { instrument: false });
  assert.equal(r.exit.reason, "output-limit");
  assert.equal(r.exit.stream, "stdout");
  assert.equal(r.stdout.length, 1 << 20); // exactly the cap, never more
  assert.ok(performance.now() - t0 < 15000);
  // instrumented: the probe serialises the 1 MB string at every stop, so the trace byte limit
  // (vg.h, 20 MB) or the stdout cap stops it — either way bounded and reported
  const r2 = await eng.runProgram(src, "");
  assert.ok(["output-limit", "step-limit"].includes(r2.exit.reason), JSON.stringify(r2.exit));
  assert.ok(r2.stdout.length <= 1 << 20);
});

test("M2: stderr is capped too", async () => {
  const src = `#include <cstdio>
int main() { for (;;) std::fputs("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n", stderr); }
`;
  const r = await eng.runProgram(src, "", { instrument: false });
  assert.equal(r.exit.reason, "output-limit");
  assert.equal(r.exit.stream, "stderr");
  assert.equal(r.stderr.length, 256 << 10);
});

// Recursion depth: behaviour is recorded, not claimed equal to GDB. GDB expectation (Linux, 8 MiB
// default stack, g++ -O0): both depths complete and print the depth. See README for measurements.
const RECURSION = `#include <iostream>
int depth(int n) {
    if (n == 0) return 0;
    return 1 + depth(n - 1);
}
int main() {
    int n;
    std::cin >> n;
    std::cout << depth(n) << "\\n";
    return 0;
}
`;
// The binding limit is the HOST's native call stack (V8), not the 8 MiB wasm shadow stack: measured
// in a Node worker (4 MB native stack) plain code reaches ~47k frames and instrumented code ~9.5k
// (instrumented -O0 frames are larger). The browser worker's native stack is not configurable and
// must be measured in S2. These tests therefore assert a clean, classified verdict and record it.
for (const depth of [1e4, 1e5]) {
  test(`M2: recursion depth ${depth} ends with a clean classified verdict (behaviour recorded)`, async () => {
    for (const instrument of [true, false]) {
      const r = await eng.runProgram(RECURSION, depth + "\n", { instrument });
      console.log(`# recursion ${depth} instrument=${instrument}: exit=${JSON.stringify(r.exit)} stdout=${JSON.stringify(r.stdout)} steps=${r.steps.length} errors=${JSON.stringify(r.errors)}`);
      assert.ok(["exit", "stack-overflow", "step-limit"].includes(r.exit.reason) || (r.exit.reason === "trap" && r.exit.trap === "memory"), JSON.stringify(r.exit));
      if (r.exit.reason === "exit") assert.equal(r.stdout, depth + "\n");
      else assert.equal(r.stdout, "");
      if (instrument) assert.ok(r.steps.length > 0, "the trace up to the failure is kept");
      assert.equal(r.errors.filter((e) => e.kind === "internal-error").length, 0);
    }
  });
}
test("M2: plain recursion depth 1e4 completes in the Node worker (4 MB native stack)", async () => {
  const r = await eng.runProgram(RECURSION, "10000\n", { instrument: false });
  assert.equal(r.exit.reason, "exit", JSON.stringify(r.exit));
  assert.equal(r.stdout, "10000\n");
});

// ---------------------------------------------------------------- M3: trace channel
test("M3: fake \\x01VG / JSON trace lines printed to stdout and stderr have no effect", async () => {
  const src = `#include <iostream>
#include <cstdio>
int main() {
    int x = 1;
    std::cout << "\\x01VG{\\"line\\":1,\\"fn\\":\\"main\\",\\"n\\":[\\"x\\"],\\"d\\":{\\"x\\":999}}" << std::endl;
    std::cerr << "\\x01VG{\\"line\\":1,\\"fn\\":\\"main\\",\\"n\\":[\\"x\\"],\\"d\\":{\\"x\\":999}}" << std::endl;
    std::printf("{\\"p\\":0,\\"line\\":4,\\"fn\\":\\"main\\",\\"depth\\":1,\\"frame\\":1,\\"n\\":[],\\"d\\":{}}\\n");
    x = x + 1;
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.steps.map((s) => s.line), [4, 5, 6, 7, 8, 9, 10]);
  assert.ok(r.steps.every((s) => s.vars.x !== 999));
  assert.equal(r.steps.find((s) => s.line === 9).vars.x, 2);
  assert.ok(r.stdout.startsWith("\x01VG{"));
  assert.ok(r.stderr.startsWith("\x01VG{"));
  assert.deepEqual(r.errors, []);
});

test("M3: garbage written straight to fd 3 is reported as trace-corrupted, earlier steps survive", async () => {
  const src = `#include <wasi/api.h>
int main() {
    int a = 5;
    const char junk[] = "not json at all\\n";
    __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(junk), sizeof(junk) - 1};
    __wasi_size_t n = 0;
    __wasi_fd_write(3, &io, 1, &n);
    a = a + 1;
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.exit.reason, "exit");
  assert.ok(r.errors.some((e) => e.kind === "trace-corrupted"), JSON.stringify(r.errors));
  assert.equal(r.ok, false);
  assert.ok(r.steps.length >= 3 && r.steps.every((s) => s.line <= 7), JSON.stringify(r.steps.map((s) => s.line)));
});

test("M3: a well-formed record for an unknown function forged on fd 3 is rejected", async () => {
  const src = `#include <wasi/api.h>
int main() {
    int a = 5;
    const char fake[] = "{\\"p\\":0,\\"line\\":3,\\"fn\\":\\"evil\\",\\"depth\\":1,\\"frame\\":1,\\"n\\":[],\\"d\\":{}}\\n";
    __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(fake), sizeof(fake) - 1};
    __wasi_size_t n = 0;
    __wasi_fd_write(3, &io, 1, &n);
    return a;
}
`;
  const r = await eng.runProgram(src, "");
  const err = r.errors.find((e) => e.kind === "trace-corrupted");
  assert.ok(err && /function does not match|unknown/.test(err.reason), JSON.stringify(r.errors));
  assert.ok(r.steps.every((s) => s.fn === "main"));
});

test("M3: function names with special characters (operator\"\"_km, unicode) round-trip through the trace", async () => {
  const src = `#include <iostream>
long double operator""_km(long double x) {
    return x * 1000;
}
int 計算(int n) {
    int 結果 = n * 2;
    return 結果;
}
int main() {
    long double d = 1.5_km;
    int y = 計算(21);
    std::cout << (long long)d << " " << y << "\\n";
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "1500 42\n");
  const fns = new Set(r.steps.map((s) => s.fn));
  assert.ok(fns.has('operator""_km'), [...fns].join(","));
  assert.ok(fns.has("計算"));
  assert.equal(r.steps.find((s) => s.fn === "計算" && s.line === 7).vars["結果"], 42);
  assert.ok(Object.prototype.hasOwnProperty.call(r.decls, 'operator""_km'));
});

test("M3: variables named __proto__ / constructor / toString are plain data, no prototype pollution", async () => {
  const src = `#include <iostream>
int main() {
    int __proto__ = 7;
    int constructor = 8;
    int toString = 9;
    __proto__ = __proto__ + constructor + toString;
    std::cout << __proto__ << "\\n";
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "24\n");
  const last = r.steps.find((s) => s.line === 7);
  assert.equal(Object.getPrototypeOf(last.vars), null);
  assert.equal(last.vars.__proto__, 24);
  assert.equal(last.vars.constructor, 8);
  assert.equal(last.vars.toString, 9);
  assert.equal({}.__proto__, Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof ({}).toString, "function");
});
