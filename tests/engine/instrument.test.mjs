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
  ["class inheritance", `struct Base { int x; };\nstruct P : Base { int get() { return x; } };\nint main() {\n    P p;\n    return p.get();\n}\n`, 5],
  ["virtual function", `struct P {\n    virtual int get() { return 1; }\n};\nint main() {\n    P p;\n    return p.get();\n}\n`, 5],
  ["operator overload", `struct P {\n    int x;\n    int operator+(const P& o) const { return x + o.x; }\n};\nint main() {\n    P a{1}, b{2};\n    return a + b;\n}\n`, 6],
  ["static class member", `struct P {\n    static int f() { return 1; }\n};\nint main() {\n    return P::f();\n}\n`, 5],
  ["nested class", `struct Outer {\n    struct Inner { int x; };\n};\nint main() {\n    Outer::Inner i{1};\n    return i.x;\n}\n`, 5],
  ["union", `union U { int a; float b; };\nint main() {\n    U u;\n    u.a = 1;\n    return u.a;\n}\n`, 4],
  ["friend declaration", `struct P {\n    int x;\n    friend int get(const P&);\n};\nint get(const P& p) { return p.x; }\nint main() {\n    P p{1};\n    return get(p);\n}\n`, 6],
  ["default member initializer", `struct P {\n    int x = 5;\n    int f() { return x; }\n};\nint main() {\n    P p;\n    return p.f();\n}\n`, 5],
  ["member function without a body", `struct P {\n    int x;\n    int f();\n};\nint P::f() { return x; }\nint main() {\n    P p{1};\n    return p.f();\n}\n`, 6],
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
  // A plain data struct's fields are serialised too now (class support, Slice B: __vg::j gets a
  // per-type specialization even for a class with zero methods) — this used to show the opaque "<?>".
  assert.deepEqual(r.steps.find((s) => s.line === 20).vars.p, { x: 1, y: 2 });
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

// Phase-1 class support: data fields + non-virtual, non-operator, non-static, in-class-defined member
// functions (incl. ctor/dtor), single class (no inheritance). Step sequence/depth/frame/args checked
// against a real `gdb -i mi` session (docker exec cppcodevisualizer-gdbgui-1, 2026-09-28): implicit
// destructor calls at scope exit need NO extra instrumentation — the compiler's real call already
// runs the destructor's own (independently instrumented) body — and `this` is just another traced
// parameter, first in the args list, typed `Class *` (`const Class *` for a const method).
test("class support: ctor/dtor/method stepping matches real GDB exactly (implicit destructor call at scope exit, `this` as first arg)", async () => {
  const src = `struct Point {
public:
    Point(int a, int b) : x(a), y(b) {}
    ~Point() {}
    int sum() const { return x + y; }
private:
    int x;
    int y;
};
int main() {
    Point a(1, 2);
    int r = a.sum();
    return 0;
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 800));
  assert.deepEqual(r.steps.map((s) => [s.line, s.fn]), [
    [11, "main"], [3, "Point::Point"], [12, "main"], [5, "Point::sum"], [13, "main"], [14, "main"], [4, "Point::~Point"],
  ]);
  assert.deepEqual(r.steps.map((s) => s.depth), [1, 2, 1, 2, 1, 1, 2]);
  const [, ctor, , method, , , dtor] = r.steps; // steps: [main, ctor, main, method, main, main, dtor]
  // `this` is traced dereferenced (*this, reusing the class's own serializer), not as vg.h's
  // generic "<ptr>" placeholder — varobj.js's DISPLAYED value for `this` still comes from a
  // pseudo-address (see class_support.test.mjs), never from this raw data; only its expanded
  // CHILDREN read it. At the ctor's first (only) probe the fields are still D6-zero — the
  // init-list hasn't run yet at that exact instant.
  assert.deepEqual({ ...ctor.vars }, { this: { x: 0, y: 0 }, a: 1, b: 2 });
  assert.deepEqual({ ...method.vars }, { this: { x: 1, y: 2 } });
  assert.deepEqual({ ...dtor.vars }, { this: { x: 1, y: 2 } });
  // ctor and dtor/method activations must be DIFFERENT frame ids (they are separate calls)
  assert.notEqual(ctor.frame, method.frame);
  assert.notEqual(ctor.frame, dtor.frame);
  assert.equal(r.decls["Point::Point"].this, "Point *");
  assert.equal(r.decls["Point::~Point"].this, "Point *");
  assert.equal(r.decls["Point::sum"].this, "const Point *"); // const method: this is a pointer to const
  assert.deepEqual(Object.keys(r.functions).sort(), ["Point::Point", "Point::sum", "Point::~Point", "main"].sort());
  assert.deepEqual(r.functions["Point::Point"].params, ["this", "a", "b"]);
  assert.deepEqual(r.functions["Point::sum"].params, ["this"]);
});

test("class support: multi-line member-initializer-list steps one clause per line (bottom-up ordering), same frame throughout the constructor", async () => {
  const src = `struct Point {
    int x;
    int y;
    Point(int a, int b)
        : x(a),
          y(b)
    {
        int z = 0;
        (void)z;
    }
    int sum() const { return x + y; }
};
int main() {
    Point a(1, 2);
    return a.sum();
}
`;
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 800));
  assert.deepEqual(r.steps.map((s) => [s.line, s.fn]), [
    [14, "main"], [5, "Point::Point"], [6, "Point::Point"], [8, "Point::Point"], [9, "Point::Point"], [10, "Point::Point"],
    [15, "main"], [11, "Point::sum"], [16, "main"],
  ]);
  // one constructor call = one activation, from the FIRST init-list clause through the closing brace
  const ctorSteps = r.steps.filter((s) => s.fn === "Point::Point");
  assert.equal(new Set(ctorSteps.map((s) => s.frame)).size, 1);
  assert.deepEqual(ctorSteps.map((s) => s.depth), [2, 2, 2, 2, 2]);
});

test("class support: still unsupported — inheritance, virtual, operator overload, static members, nested class, union, friend, default member initializer, out-of-line definition (explicit errors, never silently mis-instrumented)", async () => {
  const cases = [
    ["class inheritance", `struct Base { int x; };\nstruct P : Base { int get() { return x; } };\nint main() { P p; return p.get(); }\n`],
    ["virtual function", `struct P { virtual int get() { return 1; } };\nint main() { P p; return p.get(); }\n`],
    ["operator overload", `struct P { int x; int operator+(const P& o) const { return x + o.x; } };\nint main() { P a{1}, b{2}; return a + b; }\n`],
    ["static class member", `struct P { static int f() { return 1; } };\nint main() { return P::f(); }\n`],
    ["nested class", `struct Outer { struct Inner { int x; }; };\nint main() { Outer::Inner i{1}; return i.x; }\n`],
    ["union", `union U { int a; float b; };\nint main() { U u; u.a = 1; return u.a; }\n`],
    ["friend declaration", `struct P { int x; friend int get(const P&); };\nint get(const P& p) { return p.x; }\nint main() { P p{1}; return get(p); }\n`],
    ["default member initializer", `struct P { int x = 5; int f() { return x; } };\nint main() { P p; return p.f(); }\n`],
    ["member function without a body", `struct P { int x; int f(); };\nint P::f() { return x; }\nint main() { P p{1}; return p.f(); }\n`],
  ];
  for (const [construct, src] of cases) {
    const r = await eng.runProgram(src, "");
    assert.equal(r.ok, false, construct);
    assert.equal(r.errors[0].kind, "unsupported", construct + ": " + JSON.stringify(r.errors[0]));
    assert.equal(r.errors[0].construct, construct, construct);
  }
});

test("class support: a plain data struct with no constructor/destructor at all is unaffected (no methods to instrument)", async () => {
  const src = "struct P { int x; int y; };\nint main() { P p{1, 2}; return p.x + p.y; }\n";
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 800));
  assert.deepEqual(Object.keys(r.functions), ["main"]);
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

test("D5: a bare long/size_t/sizeof(pointer) is a non-fatal warning (kind width-warning), never rejects or blocks ok", async () => {
  const cases = [
    ["long a = 1; int main() { return 0; }", "long", 1],
    ["int main() { long a = 1; return 0; }", "long", 1],
    ["#include <cstddef>\nsize_t n = 5;\nint main() { return 0; }\n", "size_t", 2],
    ["int main() { int x = 1; int* p = &x; int s = sizeof(p); return 0; }", "sizeof(pointer)", 1],
    ["int main() { int s = sizeof(int*); return 0; }", "sizeof(pointer)", 1],
    ["struct S { long f; };\nint main() { S s{1}; return 0; }\n", "long", 1],
    ["void fn(long p) {}\nint main() { fn(1); return 0; }\n", "long", 1],
  ];
  for (const [src, construct, line] of cases) {
    const r = await eng.runProgram(src, "");
    assert.equal(r.ok, true, `${construct}: ${JSON.stringify(r.errors)}`);
    const w = r.errors.find((e) => e.kind === "width-warning");
    assert.ok(w, `${construct}: no width-warning in ${JSON.stringify(r.errors)}`);
    assert.equal(w.construct, construct, JSON.stringify(r.errors));
    assert.equal(w.line, line, JSON.stringify(r.errors));
  }
});

test("D5: cv-qualified and array long/size_t (const long, volatile long, long[N]) still warn (independent verifier advisory)", async () => {
  const cases = [
    ["int main() { const long c = 3; return 0; }", "long"],
    ["int main() { volatile long v = 3; return 0; }", "long"],
    ["int main() { long a[3]; a[0] = 1; return 0; }", "long"],
    ["#include <cstddef>\nint main() { const size_t n = 3; return 0; }\n", "size_t"],
  ];
  for (const [src, construct] of cases) {
    const r = await eng.runProgram(src, "");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const w = r.errors.find((e) => e.kind === "width-warning");
    assert.ok(w, `${src}: ${JSON.stringify(r.errors)}`);
    assert.equal(w.construct, construct);
  }
  const clean = await eng.runProgram("int main() { const int c = 3; return 0; }", "");
  assert.ok(!clean.errors.some((e) => e.kind === "width-warning"), JSON.stringify(clean.errors));
});

test("D5: long long, long double, and sizeof of a non-pointer never produce a width-warning", async () => {
  const clean = [
    "long long a = 1; int main() { return 0; }",
    "unsigned long long a = 1; int main() { return 0; }",
    "long double a = 1; int main() { return 0; }",
    "int main() { int s = sizeof(int); return 0; }",
    "int main() { int x = 1; return 0; }",
  ];
  for (const src of clean) {
    const r = await eng.runProgram(src, "");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(!r.errors.some((e) => e.kind === "width-warning"), `${src}: ${JSON.stringify(r.errors)}`);
  }
});

test("cStr escapes C++ string literals (quotes, backslashes, control chars, trigraph '?')", () => {
  assert.equal(cStr('operator""_km'), '"operator\\"\\"_km"');
  assert.equal(cStr("a\\b\n?"), '"a\\\\b\\012\\?"');
  assert.equal(cStr("計算"), '"計算"');
});
