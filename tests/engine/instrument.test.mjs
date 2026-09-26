// Instrumenter (requirement 6): explicit refusal of unsupported constructs, supported syntax,
// `decls` (function -> variable -> AST qualType) and D6 uninitialised-variable marking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";
import { cStr } from "../../gdbgui/static/engine/instrument.js";

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

const H = "#include <iostream>\n#include <vector>\nusing namespace std;\n";
const UNSUPPORTED = [
  ["switch", `int main() {\n    int x = 1;\n    switch (x) { case 1: x = 2; break; default: break; }\n    return x;\n}\n`, 6],
  ["do-while", `int main() {\n    int x = 0;\n    do { x++; } while (x < 3);\n    return x;\n}\n`, 6],
  ["goto", `int main() {\n    int x = 0;\n    again:\n    x++;\n    if (x < 3) goto again;\n    return 0;\n}\n`, 6],
  ["try", `int main() {\n    try { int x = 1; } catch (...) {}\n    return 0;\n}\n`, 5],
  ["lambda", `int main() {\n    auto f = [](int a) { return a + 1; };\n    return f(1);\n}\n`, 5],
  ["template", `template <class T> T twice(T x) { return x * 2; }\nint main() {\n    return twice(2);\n}\n`, 4],
  ["class member function", `struct P {\n    int x;\n    int get() const { return x; }\n};\nint main() {\n    P p{1};\n    return p.get();\n}\n`, 4],
  ["namespace", `namespace util { int f() { return 1; } }\nint main() {\n    return util::f();\n}\n`, 4],
  ["overloaded function f", `int f(int a) { return a; }\nint f(double a) { return 2; }\nint main() {\n    return f(1);\n}\n`, 5],
  ["if with initializer", `int main() {\n    if (int y = 3; y > 2) return 1;\n    return 0;\n}\n`, 5],
  ["static local variable", `int count() {\n    static int n = 0;\n    return ++n;\n}\nint main() {\n    return count();\n}\n`, 5],
  ["function-like macro in while condition", `#define LT(a, b) ((a) < (b))\nint main() {\n    int i = 0;\n    while (LT(i, 3)) i++;\n    return i;\n}\n`, 7],
  ["if constexpr", `int main() {\n    if constexpr (sizeof(int) == 4) return 1;\n    return 0;\n}\n`, 5],
  ["macro in for increment", `#define rep(i, n) for (int i = 0; i < (n); ++i)\nint main() {\n    int s = 0;\n    rep(i, 3) s += i;\n    return s;\n}\n`, 7],
];

for (const [construct, body, lineInFile] of UNSUPPORTED) {
  test(`unsupported construct is refused explicitly: ${construct}`, async () => {
    const src = H + body;
    const r = await eng.runProgram(src, "");
    assert.equal(r.ok, false);
    const e = r.errors[0];
    assert.equal(e.kind, "unsupported", JSON.stringify(r.errors).slice(0, 600));
    assert.ok(e.construct.startsWith(construct.split(" in ")[0].split(" for ")[0]) || e.construct === construct || e.message.includes(construct.split(" ")[0]), e.message);
    assert.match(e.message, /^unsupported construct: /);
    if (lineInFile) assert.equal(e.line, lineInFile, e.message);
    assert.equal(r.steps.length, 0);
    assert.equal(r.stdout, "");
  });
}

test("supported: recursion, reference params, range-for, globals, long long, structs without methods, macros that are safe", async () => {
  const src = `#include <iostream>
#include <vector>
#define N 3
#define SHOW(x) std::cout << (x) << "\\n"
struct Pt { int x, y; };
long long g_sum = 0;
void add(std::vector<int>& v, int k) {
    v.push_back(k);
}
long long fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int main() {
    std::vector<int> v;
    for (int i = 0; i < N; ++i) add(v, i);
    for (int e : v) g_sum += e;
    Pt p = {1, 2};
    long long f = fact(5);
    SHOW(f + g_sum + p.x);
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 800));
  assert.equal(r.stdout, "124\n");
  const fns = new Set(r.steps.map((s) => s.fn));
  assert.deepEqual([...fns].sort(), ["add", "fact", "main"]);
  assert.equal(Math.max(...r.steps.filter((s) => s.fn === "fact").map((s) => s.depth)), 6); // main=1, fact(5..1)=2..6
  const inAdd = r.steps.find((s) => s.fn === "add" && s.line === 9);
  assert.deepEqual(inAdd.vars.v, [0]);           // reference parameter shows the caller's vector
  assert.equal(r.steps.find((s) => s.line === 20).vars.g_sum, 3);
  assert.equal(r.steps.find((s) => s.line === 20).vars.p, "<?>");
  assert.equal(r.decls.main.v, "std::vector<int>");
  assert.equal(r.decls.main.f, "long long");
  assert.equal(r.decls.main.g_sum, "long long");
  assert.equal(r.decls.fact.n, "int");
  assert.equal(r.decls.add.v, "std::vector<int> &");
  assert.equal(r.globals.g_sum, "long long");
  // one step per stop: consecutive records on the same line of the same activation are merged
  for (let i = 1; i < r.steps.length; i++) {
    const a = r.steps[i - 1], b = r.steps[i];
    assert.ok(!(a.line === b.line && a.fn === b.fn && a.frame === b.frame));
  }
});

test("D6: variables declared without initialiser show 0 and are flagged until first written", async () => {
  const src = `#include <iostream>
int main() {
    int h, w;
    int a[3];
    std::cin >> h >> w;
    a[0] = h;
    int s = h + w + a[0];
    std::cout << s << "\\n";
    return 0;
}
`;
  const r = await eng.runProgram(src, "4 5\n");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stdout, "13\n");
  const at = (line) => r.steps.find((s) => s.line === line);
  assert.deepEqual(at(5).uninit.sort(), ["a", "h", "w"]);
  assert.equal(at(5).vars.h, 0);
  assert.deepEqual(at(5).vars.a, [0, 0, 0]);
  assert.deepEqual(at(6).uninit, ["a"]);          // h and w were written by `cin >> h >> w`
  assert.equal(at(6).vars.h, 4);
  assert.equal(at(7).uninit, undefined);          // a written by a[0] = h
  assert.equal(at(7).vars.a[0], 4);
  assert.deepEqual(r.uninitDecls.map((u) => u.name).sort(), ["a", "h", "w"]);
});

test("D6 is per activation: a recursive call's own uninitialised local is flagged independently", async () => {
  const src = `int f(int n) {
    int r;
    if (n == 0) return 0;
    r = f(n - 1) + 1;
    return r;
}
int main() {
    int x = f(2);
    return x - 2;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const retLines = r.steps.filter((s) => s.fn === "f" && s.line === 5);
  assert.ok(retLines.length === 2 && retLines.every((s) => !s.uninit), JSON.stringify(retLines));
  const conds = r.steps.filter((s) => s.fn === "f" && s.line === 3);
  assert.equal(conds.length, 3);
  assert.ok(conds.every((s) => s.uninit && s.uninit.includes("r")));
});

test("cStr escapes C++ string literals (quotes, backslashes, control chars, trigraph '?')", () => {
  assert.equal(cStr('operator""_km'), '"operator\\"\\"_km"');
  assert.equal(cStr("a\\b\n?"), '"a\\\\b\\012\\?"');
  assert.equal(cStr("計算"), '"計算"');
});
