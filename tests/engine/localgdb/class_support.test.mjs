// Phase-1 class/struct support (data fields + non-virtual/non-operator/non-static, in-class-defined
// member functions incl. ctor/dtor; single class, no inheritance). Ground truth for the varobj shape
// below is a real `gdb -i mi -enable-pretty-printing` session (docker exec
// cppcodevisualizer-gdbgui-1, 2026-09-28): a class instance is a STATIC (non-pretty-printed) varobj
// whose children are synthetic public/private/protected "access" pseudo-nodes — one per access level
// that has at least one FIELD, ALWAYS in that fixed public/private/protected order regardless of
// declaration order (confirmed: a class declaring protected, then private, then public still shows
// public/private/protected — an earlier pass of this file wrongly assumed declaration order, since
// its only tests happened to declare public first; see "access pseudo-node order" below), each with
// numchild = fields at that level and an empty value and no `type` key — and only ONE level further
// down do the real fields appear (`v1.public.x`). See varobj.js's
// _ensureAccessChildren/_ensureClassFields. A reference or `this`-pointer to a class gets the SAME
// access-node children directly (no extra pointee/dereference layer) — see "reference to a class" /
// "this" below. Step-sequence/frame correctness (ctor/dtor stepping, implicit destructor calls) is
// covered by tests/engine/instrument.test.mjs; this file covers the MI/varobj protocol layer on top.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, newGdb } from "./helpers.mjs";

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

async function runAndBreak(src, line) {
  const run = await eng.runProgram(src, "");
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const g = newGdb(run, src);
  await send(g, `-break-insert -f ${line}`);
  await send(g, "-exec-run");
  return g;
}

const POINT = `struct Point {
public:
    Point(int a, int b) : x(a), y(b) {}
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

test("-var-create on a class instance: static (non-dynamic) varobj, value '{...}', numchild = distinct access levels with fields", async () => {
  const g = await runAndBreak(POINT, 11);
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  assert.deepEqual(v, { name: "var1", numchild: "1", value: "{...}", type: "Point", "thread-id": "1", has_more: "0" });
});

test("-var-list-children: one access pseudo-node per access level with fields, no `type` key on it, empty value", async () => {
  const g = await runAndBreak(POINT, 11);
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids, { numchild: "1", children: [{ name: "var1.private", exp: "private", numchild: "2", value: "", "thread-id": "1" }], has_more: "0" });
});

test("expanding the access pseudo-node gives the real fields, one level down, plain field names/types", async () => {
  const g = await runAndBreak(POINT, 11);
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  const acc = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`)).children[0].name;
  const fields = payloadOf(await send(g, `-var-list-children --all-values ${acc}`));
  assert.deepEqual(fields, {
    numchild: "2",
    children: [
      { name: `${acc}.x`, exp: "x", numchild: "0", value: "1", type: "int", "thread-id": "1" },
      { name: `${acc}.y`, exp: "y", numchild: "0", value: "2", type: "int", "thread-id": "1" },
    ],
    has_more: "0",
  });
});

test("-data-evaluate-expression: GDB print format `{field = value, ...}`, no access-level grouping", async () => {
  const g = await runAndBreak(POINT, 11);
  const r = payloadOf(await send(g, `1-data-evaluate-expression "a"`));
  assert.deepEqual(r, { value: "{x = 1, y = 2}" });
});

test("access pseudo-node order is ALWAYS public/private/protected, never declaration order (declared protected, private, public here — the order most likely to expose a declaration-order bug)", async () => {
  const src = `struct Widget {
protected:
    int pr;
private:
    int pv;
public:
    Widget(int a, int b, int c) : pr(a), pv(b), pu(c) {}
    int pu;
};
int main() {
    Widget w(1, 2, 3);
    return 0;
}
`;
  const g = await runAndBreak(src, 10);
  const v = payloadOf(await send(g, `3-var-create - * "w"`));
  assert.equal(v.numchild, "3");
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => [c.exp, c.numchild, c.value]), [
    ["public", "1", ""], ["private", "1", ""], ["protected", "1", ""],
  ]);
});

test("-var-update: a field mutated through a method call is detected via its classfield varobj", async () => {
  const src = `struct Point {
public:
    Point(int a, int b) : x(a), y(b) {}
    void setX(int v) { x = v; }
private:
    int x;
    int y;
};
int main() {
    Point a(1, 2);
    a.setX(99);
    int done = 1;
    return 0;
}
`;
  const g = await runAndBreak(src, 11);
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  const acc = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`)).children[0].name;
  const before2 = payloadOf(await send(g, `-var-list-children --all-values ${acc}`));
  assert.equal(before2.children.find((c) => c.exp === "x").value, "1");
  await send(g, "-break-insert -f 13");
  await send(g, "-exec-continue");
  const upd = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  assert.deepEqual(upd, [{ name: `${acc}.x`, value: "99", in_scope: "true", type_changed: "false", has_more: "0" }]);
});

test("nested class composition: a field whose own type is another supported class recurses (Rect { Point tl, br; })", async () => {
  const src = `struct Point {
    int x;
    int y;
};
struct Rect {
public:
    Rect(Point a, Point b) : tl(a), br(b) {}
private:
    Point tl;
    Point br;
};
int main() {
    Point a{0, 0}, b{3, 4};
    Rect r(a, b);
    return 0;
}
`;
  const g = await runAndBreak(src, 15);
  const r = payloadOf(await send(g, `1-data-evaluate-expression "r"`));
  assert.equal(r.value, "{tl = {x = 0, y = 0}, br = {x = 3, y = 4}}");
  const v = payloadOf(await send(g, `3-var-create - * "r"`));
  const acc = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`)).children[0].name;
  const fields = payloadOf(await send(g, `-var-list-children --all-values ${acc}`));
  assert.deepEqual(fields.children.map((c) => [c.exp, c.value, c.type]), [["tl", "{...}", "Point"], ["br", "{...}", "Point"]]);
  const tlField = fields.children[0].name;
  const tlAcc = payloadOf(await send(g, `-var-list-children --all-values ${tlField}`)).children[0].name;
  const tlFields = payloadOf(await send(g, `-var-list-children --all-values ${tlAcc}`));
  assert.deepEqual(tlFields.children.map((c) => [c.exp, c.value]), [["x", "0"], ["y", "0"]]);
});

test("a class field of a supported non-scalar type (std::vector, std::string) prints via the same machinery those types already use", async () => {
  const src = `#include <string>
#include <vector>
struct Bag {
    std::vector<int> items;
    std::string label;
};
int main() {
    Bag bag;
    bag.items.push_back(1);
    bag.items.push_back(2);
    bag.label = "x";
    return 0;
}
`;
  const g = await runAndBreak(src, 12);
  const r = payloadOf(await send(g, `1-data-evaluate-expression "bag"`));
  assert.equal(r.value, 'items = std::vector of length 2, capacity 2 = {1, 2}, label = "x"'.replace(/^/, "{") + "}");
});

test("a class with zero fields at one access level does not get an empty pseudo-node for it (only levels WITH fields get one)", async () => {
  const src = `struct OnlyPublic {
public:
    OnlyPublic(int a) : x(a) {}
    int x;
};
int main() {
    OnlyPublic o(5);
    return 0;
}
`;
  const g = await runAndBreak(src, 7);
  const v = payloadOf(await send(g, `3-var-create - * "o"`));
  assert.equal(v.numchild, "1");
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => c.exp), ["public"]);
});

test("a class with a field of an unsupported type is itself unsupported (recursive isSupported), never silently mis-serialised", async () => {
  const src = `#include <map>
struct Weird {
    std::map<int, int> m;
};
int main() {
    Weird w;
    return 0;
}
`;
  const run = await eng.runProgram(src, "");
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const g = newGdb(run, src);
  await send(g, "-break-insert -f 7");
  await send(g, "-exec-run");
  const v = payloadOf(await send(g, `3-var-create - * "w"`));
  assert.match(v.msg, /^type 'Weird' is not supported by the browser engine$/);
});

test("std::stack-list-variables/--simple-values shows the class-typed variable's name/type without a value (matches C-array/struct-not-simple convention)", async () => {
  const g = await runAndBreak(POINT, 11);
  const simple = payloadOf(await send(g, "1-stack-list-variables --simple-values")).variables;
  const a = simple.find((x) => x.name === "a");
  assert.deepEqual(a, { name: "a", type: "Point" }); // no `value` key: not a "simple" type
  const all = payloadOf(await send(g, "2-stack-list-variables --all-values")).variables;
  assert.equal(all.find((x) => x.name === "a").value, "{x = 1, y = 2}");
});

// Regression (independent verifier, round 2 of this feature): a `const Acc&` reference parameter was
// flatly rejected ("type 'const Acc &' is not supported"), even though the plan explicitly assumed
// references would "just work" via the existing generic ref-unwrapping — they didn't, because
// TraceModel.typeInfo()'s "other" -> "class" upgrade only looked at a bare type name, never through a
// ref/ptr wrapper. A reference to a class behaves like the class itself for children, but its OWN
// var-create/evaluate value text is different from both a plain class instance's and a scalar
// reference's — see the real-GDB ground truth in each assertion below.
test("reference to a class (`const Acc&` parameter): var-create/list-children work like a plain instance, but the value text differs from both a plain class and a scalar reference", async () => {
  const src = `struct Acc {
public:
    Acc(int c, int s) : cnt(c), sum(s) {}
private:
    int cnt;
    int sum;
};
int peek(const Acc& a) {
    return 1;
}
int main() {
    Acc a(1, 5);
    int r = peek(a);
    return 0;
}
`;
  const g = await runAndBreak(src, 9);
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  // Same shape as a plain class instance's var-create value ("{...}") — NOT the usual scalar
  // reference's "@addr: value" wrap.
  assert.deepEqual(v, { name: "var1", numchild: "1", value: "{...}", type: "const Acc &", "thread-id": "1", has_more: "0" });
  const acc = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`)).children[0].name;
  const fields = payloadOf(await send(g, `-var-list-children --all-values ${acc}`));
  assert.deepEqual(fields.children.map((c) => [c.exp, c.value]), [["cnt", "1"], ["sum", "5"]]);
  // -data-evaluate-expression on a class reference is a BARE address — no "{...}" or field values
  // (unlike a scalar reference, which shows "@addr: value" here too).
  const ev = payloadOf(await send(g, `1-data-evaluate-expression "a"`));
  assert.match(ev.value, /^@0x[0-9a-f]+$/);
});

// Regression (same verifier round): `this` was flatly rejected too (same root cause as the reference
// case above — `this` is typed `Acc *`, a pointer, and the upgrade never looked through pointers
// either). Fixing it also needed a second piece: `this` is traced as the opaque "<ptr>" placeholder
// generic pointers get (vg.h has no real addresses to give it), so even once -var-create accepted the
// TYPE, expanding it had no real field data to show. The fix traces `this` dereferenced (`*this`,
// reusing the class's own serializer) while keeping the trace key "this" — `this`'s displayed VALUE
// still comes from a pseudo-address (matching real GDB), never from this dereferenced raw data; only
// its CHILDREN read it.
test("`this` inside a member function: var-create/list-children give the object's REAL field data, not a placeholder", async () => {
  const src = `struct Acc {
public:
    Acc(int c, int s) : cnt(c), sum(s) {}
    void add(int v) {
        cnt++;
        sum += v;
    }
private:
    int cnt;
    int sum;
};
int main() {
    Acc a(1, 5);
    a.add(3);
    return 0;
}
`;
  const g = await runAndBreak(src, 5);
  const v = payloadOf(await send(g, `3-var-create - * "this"`));
  assert.equal(v.numchild, "1");
  assert.equal(v.type, "Acc *");
  assert.match(v.value, /^0x[0-9a-f]+$/); // a pseudo-address, not "{...}"
  const acc = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`)).children[0].name;
  const fields = payloadOf(await send(g, `-var-list-children --all-values ${acc}`));
  // Real field data (cnt=1, sum=5 — the object add() was called on), not vg.h's generic "<ptr>"
  // placeholder or undefined.
  assert.deepEqual(fields.children.map((c) => [c.exp, c.value]), [["cnt", "1"], ["sum", "5"]]);
  const ev = payloadOf(await send(g, `1-data-evaluate-expression "this"`));
  assert.equal(ev.value, v.value); // same pseudo-address both ways
});

// Regression (same verifier round): ANY class with a std::string/std::vector/class-typed field that a
// constructor's initializer-list doesn't mention was flatly rejected as "constructor initializer" —
// clang's AST gives such a field an IMPLICIT CXXCtorInitializer (default-constructing it) that looks
// almost identical to a genuinely written one, and the instrumenter treated it as an unsupported
// clause instead of recognising it as "nothing was actually written here, skip it". This is a very
// common pattern (a class with a std::string/std::vector member and a constructor that only
// initializes its OTHER fields, or no initializer list at all).
test("a constructor need not mention every std::string/std::vector/class-typed field in its initializer list", async () => {
  const withPartialList = `#include <string>
#include <vector>
struct Named {
public:
    Named(int a) : x(a) {}
    int x;
    std::string label;
    std::vector<int> items;
};
int main() {
    Named n(5);
    return 0;
}
`;
  const withNoListAtAll = `#include <string>
struct Named2 {
public:
    Named2() { int z = 1; (void)z; }
    std::string name;
};
int main() {
    Named2 n;
    return 0;
}
`;
  for (const src of [withPartialList, withNoListAtAll]) {
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, true, JSON.stringify(run.errors));
  }
});

// Regression (independent verifier, round 3 of this feature): the F1/F2 fix above (recursing
// through ref/ptr to find a wrapped class) made TraceModel.typeInfo() infinitely recurse for a
// SELF-REFERENTIAL class — `struct Node { Node* next; }`, i.e. any linked-list or BST node, this
// project's core content — because resolving Node's OWN field list resolved `next`'s type, which
// (being a class again) tried to resolve Node's field list again, forever; the per-qual-string
// typeCache only gets written AFTER resolution finishes, so it never broke the cycle. Fixed with a
// separate per-CLASS-NAME cache (model.js's _classCls) that registers the (still-being-filled)
// object before recursing into its fields, so a self- or mutually-referencing pointer field finds
// and reuses the SAME (eventually complete) object instead of re-entering. This must not hang.
test("a self-referential class (linked-list/BST node shape) compiles, runs and steps without hanging — and its own -var-create actually exercises the code path that hung (runProgram alone does not build a TraceModel)", async () => {
  const src = `struct Node {
    int val;
    Node* next;
};
int main() {
    Node a;
    a.val = 1;
    a.next = 0;
    return 0;
}
`;
  const run = await eng.runProgram(src, "");
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.ok(run.steps.length > 0);
  const g = newGdb(run, src);
  await send(g, "-break-insert -f 9");
  await send(g, "-exec-run");
  // A raw pointer field stays unsupported (no general pointer-chasing in phase 1) — the point of
  // this assertion is that it returns AT ALL (the hang was in TraceModel.typeInfo, only reachable
  // through a real session/-var-create, not through runProgram alone), not that it succeeds.
  const v = payloadOf(await send(g, `3-var-create - * "a"`));
  assert.match(v.msg, /^type 'Node' is not supported by the browser engine$/);

  const src2 = `struct TreeNode {
    int key;
    TreeNode* left;
    TreeNode* right;
};
int main() {
    TreeNode a;
    a.key = 1;
    a.left = 0;
    a.right = 0;
    return 0;
}
`;
  const run2 = await eng.runProgram(src2, "");
  assert.equal(run2.ok, true, JSON.stringify(run2.errors));
  const g2 = newGdb(run2, src2);
  await send(g2, "-break-insert -f 11");
  await send(g2, "-exec-run");
  const v2 = payloadOf(await send(g2, `3-var-create - * "a"`));
  assert.match(v2.msg, /^type 'TreeNode' is not supported by the browser engine$/);
});

// Regression (independent verifier, round 4 of this feature): `this` was accepted for ANY class,
// including a self-referential one (TreeNode above) — isThisPtr only checked "is this a pointer to
// SOME class", not whether that class is itself isSupported(). childKind()'s ptr-to-class unwrap is
// purely type-based (it can't tell "the real `this`" apart from "a field reached through it"), so
// expanding `this` on a BST/linked-list node also expanded its raw-pointer FIELDS (left/right) —
// which have no real backing data (only the literal identifier "this" is traced dereferenced), so
// they showed made-up field values, and a null pointer field looked like a valid, non-null object.
// Fixed by requiring the pointee class to be fully isSupported() too — `this` inside a
// self-referential class's own method is now consistently rejected, matching what a plain `Node`
// value already gets (not a new limitation — consistency with phase 1's existing pointer boundary).
test("`this` inside a self-referential class's own method is consistently rejected too (not accepted with made-up field data for its raw-pointer fields)", async () => {
  const src = `struct TreeNode {
public:
    TreeNode(int k) : key(k), left(nullptr), right(nullptr) {}
    int depth() {
        if (left == nullptr && right == nullptr) return 1;
        return 1;
    }
    int key;
    TreeNode* left;
    TreeNode* right;
};
int main() {
    TreeNode r(5);
    int d = r.depth();
    return 0;
}
`;
  const g = await runAndBreak(src, 5);
  const v = payloadOf(await send(g, `3-var-create - * "this"`));
  assert.match(v.msg, /^type 'TreeNode \*' is not supported by the browser engine$/);
});

// Sanity (same round): `this` must still work for a class that genuinely has no unsupported
// fields — the fix above must not have over-corrected into rejecting `this` universally.
test("`this` still works fully for a class with no raw-pointer fields (the fix above did not over-reject)", async () => {
  const src = `struct Acc {
public:
    Acc(int c) : cnt(c) {}
    int get() { return cnt; }
private:
    int cnt;
};
int main() {
    Acc a(7);
    int g = a.get();
    return 0;
}
`;
  const g = await runAndBreak(src, 4);
  const v = payloadOf(await send(g, `3-var-create - * "this"`));
  assert.equal(v.numchild, "1");
  assert.match(v.value, /^0x[0-9a-f]+$/);
});

// Regression (independent verifier, round 4→5 of this feature): the round-3 "unmentioned
// class-typed field" check string-matched the field declaration's raw qualType against the class
// registry, rejecting on a MATCH and skipping otherwise — but "const In in;" spells its type
// "const In" and "In arr[2];" spells it "In [2]", neither matching the registry's plain key "In",
// so the wrong-call-stack bug (In::In shown as a sibling of Out::Out under main, instead of nested
// inside it) came back through those spellings. A round-4 fix added const/array normalization but
// — the actual bug an independent verifier caught — kept the SAME polarity (registry match →
// reject, no match → skip), so a typedef/using alias or a redundant "struct In" elaborated spelling
// STILL fell through to "skip" and reproduced the bug. A round-5 fix switched to a structural
// check ("starts with std::" is the only safe-to-skip case, since user namespaces are forbidden so
// a registered class name is never std::-prefixed) — but round 5's OWN independent verifier then
// found the SAME bug class survives through this check too, in both directions: `std::pair<In,
// int>`/`std::array<In,2>`/`std::tuple<In>` (a registered class as a std container's template
// argument) still "starts with std::" and was wrongly SKIPPED, silently reproducing the exact
// wrong-call-stack bug this whole check exists to prevent; and a bare `using namespace std;`
// spelling of `std::string`/`std::vector` (the majority spelling in this project's own lesson
// corpus) does NOT start with `std::` and was wrongly REJECTED, a regression against the original
// F4 fix. The final (round-6) fix stops trying to recognise "is this std" or "is this a registered
// class" from the AS-WRITTEN spelling at all: `instrumentAst`'s caller wraps the entire user file
// in `namespace __vg_user { ... }` before handing it to clang purely so `-ast-dump-filter` can pick
// out the user's own declarations, which means every registered class's fully-resolved
// (desugared) name is always `__vg_user::ClassName` — and clang's `desugaredQualType` resolves
// sugar recursively, through template arguments, typedefs/using aliases, and `using namespace
// std;` alike. So: skip iff neither the desugared nor the as-written spelling contains the
// substring `__vg_user::` (a substring user code can never produce itself, since this engine
// rejects user namespaces and any identifier starting with `__vg`).
test("an unmentioned class-typed field is rejected through EVERY spelling that names it (const, array, typedef, using, elaborated struct/class), including nested inside std::pair/std::array/std::tuple — the polarity is 'only unreachable-from-__vg_user is safe to skip'", async () => {
  const rejectedDecls = ["const In in;", "In arr[2];", "typedef In InT; InT in;", "using InU = In; InU in;", "struct In in;"];
  for (const decl of rejectedDecls) {
    const src = `struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, false, decl);
    assert.equal(run.errors[0].construct, "constructor initializer", decl);
  }

  // Round-6 regression cases: a registered class reachable only through a std container's template
  // argument, not as the field's own top-level type — must still be rejected, not silently accepted.
  const rejectedTemplateFields = [
    { include: "#include <utility>", decl: "std::pair<In,int> pr;" },
    { include: "#include <array>", decl: "std::array<In,2> arr;" },
    { include: "#include <tuple>", decl: "std::tuple<In> tp;" },
    { include: "#include <vector>\n#include <utility>", decl: "std::vector<std::pair<In,int>> v;" },
  ];
  for (const { include, decl } of rejectedTemplateFields) {
    const src = `${include}
struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, false, decl);
    assert.equal(run.errors[0].construct, "constructor initializer", decl);
  }
});

test("...but a genuinely std::-prefixed field (const-qualified, or an array of them) is still safely skipped, and a pointer-to-class field is skipped too (its own construction is trivial and untraced regardless of what it points to)", async () => {
  const skippedDecls = ["std::string label;", "const std::string label;", "std::string labels[2];", "std::vector<int> v;", "In* p;"];
  for (const decl of skippedDecls) {
    const src = `#include <string>
#include <vector>
struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, true, `${decl}: ${JSON.stringify(run.errors)}`);
  }
});

// Round-6 regression: the SAME fields above, spelled without the std:: prefix under
// `using namespace std;` — the majority spelling in this project's own lesson corpus — must still
// be safely skipped, not rejected (a round-5 fix's regression: it kept `std::` as the safe-to-skip
// signal, and these spellings don't contain that substring even though they name the same types).
test("a field spelled without std:: under `using namespace std;` is still safely skipped", async () => {
  const skippedDecls = ["string label;", "vector<int> v;"];
  for (const decl of skippedDecls) {
    const src = `#include <string>
#include <vector>
using namespace std;
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, true, `${decl}: ${JSON.stringify(run.errors)}`);
  }
});

// Round-6 finding (F-A): a registered class reachable only through a std container's template
// argument (never as the field's own top-level type) must still be rejected — clang's
// desugaredQualType resolves through std::pair/array/tuple/vector recursively, so this is caught by
// the same primary check as a bare class field, not a separate special case.
test("a registered class hidden inside a std::pair/array/tuple/vector template argument is rejected, not silently accepted", async () => {
  const rejected = [
    { include: "#include <utility>", decl: "std::pair<In,int> pr;" },
    { include: "#include <array>", decl: "std::array<In,2> arr;" },
    { include: "#include <tuple>", decl: "std::tuple<In> tp;" },
    { include: "#include <vector>\n#include <utility>", decl: "std::vector<std::pair<In,int>> v;" },
  ];
  for (const { include, decl } of rejected) {
    const src = `${include}
struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, false, decl);
    assert.equal(run.errors[0].construct, "constructor initializer", decl);
  }
});

// Known residual limitation (documented, not a bug): clang's JSON AST dump never exposes a
// desugared/canonical spelling for an ARRAY-typed field (ConstantArrayType), even when its element
// is a registered class or a std type — only the as-written spelling is available for arrays. So an
// array field named only through a typedef/using alias (of either a class or a std type), or spelled
// without `std::` under `using namespace std;`, can't be resolved and defaults to REJECTION (the
// safe direction — never silently accepted with wrong data). This test locks in that the fallback
// stays on the safe side, not that it's the ideal outcome.
test("an array field this can't resolve (aliased element type, or std-type spelled without std:: prefix) is rejected, never silently accepted", async () => {
  const rejected = [
    { extra: "typedef In InT;", decl: "InT arr[2];" },
    { extra: "using namespace std;", decl: "string labels[2];", stdOnly: true },
  ];
  for (const { extra, decl, stdOnly } of rejected) {
    const src = `#include <string>
${stdOnly ? "" : `struct In {
public:
    In() : q(3) {}
    int q;
};
`}${extra}
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, false, decl);
    assert.equal(run.errors[0].construct, "constructor initializer", decl);
  }
});

// Round-6 finding F-C (independent verifier, same round): an array field's as-written spelling
// starting with `std::` is NOT by itself a reliable "safe to skip" signal, because a registered
// class can still be hiding inside the std container's OWN template arguments
// (`std::pair<In,int> arr[2];`) — the array fallback has no desugared spelling to check (see the
// residual-limitation test above), so this is the array-field version of F-A itself, not just the
// alias/bare-spelling gap. Fixed by requiring BOTH a literal `std::` prefix AND that the
// bracket-stripped spelling mentions none of the currently-registered class names anywhere (any
// template-argument position, any nesting depth, const/volatile-qualified, multi-dimensional).
test("an array of a std::pair/array/tuple that itself wraps a registered class is rejected, not silently accepted (F-C)", async () => {
  const rejected = [
    { include: "#include <utility>", decl: "std::pair<In,int> arr[2];" },
    { include: "#include <array>", decl: "std::array<In,2> arr[1];" },
    { include: "#include <tuple>", decl: "std::tuple<In> arr[2];" },
    { include: "#include <utility>", decl: "std::pair<int,In> arr[2][2];" },
    { include: "#include <utility>", decl: "const std::pair<In,int> arr[2];" },
    { include: "#include <utility>", decl: "volatile std::pair<In,int> arr[2];" },
  ];
  for (const { include, decl } of rejected) {
    const src = `${include}
struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, false, decl);
    assert.equal(run.errors[0].construct, "constructor initializer", decl);
  }
});

// Sanity companion to F-C: an array of a std container that does NOT wrap any registered class must
// still be safely skipped (no over-correction from the new "mentions a registered class name"
// check).
test("an array of a std container that wraps only std/scalar types is still safely skipped", async () => {
  const skipped = [
    { include: "#include <array>\n#include <string>", decl: "std::array<std::string,2> a;" },
    { include: "#include <utility>\n#include <string>", decl: "std::pair<int,std::string> arr[2];" },
    { include: "#include <string>", decl: "std::string arr[2];" },
  ];
  for (const { include, decl } of skipped) {
    const src = `${include}
struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    ${decl}
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
    const run = await eng.runProgram(src, "");
    assert.equal(run.ok, true, `${decl}: ${JSON.stringify(run.errors)}`);
  }
});

// Regression (same verifier round): the F2 fix made isSupported() accept ANY pointer-to-class type,
// not just `this` specifically — but only `this` is actually traced dereferenced (instrument.js's
// probe() special-cases the literal name "this"); every OTHER Class* pointer (`Acc* ap = &a;`, or a
// `P*` parameter) is still traced as vg.h's generic opaque "<ptr>" placeholder, so accepting it
// silently showed WRONG field data (and a null pointer looked like a valid, non-null object). Fixed
// by moving the exception from isSupported() (type-only, can't know a name) to a name-based check
// (isThisPtr) at the point of -var-create/-data-evaluate-expression: only the exact expression
// "this" gets through; any other Class* stays explicitly rejected, same as before this feature.
test("a Class* other than `this` is explicitly rejected, never silently shown with wrong field data", async () => {
  const src = `struct Acc {
public:
    Acc(int c) : cnt(c) {}
private:
    int cnt;
};
int main() {
    Acc a(7);
    Acc* ap = &a;
    return 0;
}
`;
  const g = await runAndBreak(src, 9);
  const v = payloadOf(await send(g, `3-var-create - * "ap"`));
  assert.match(v.msg, /^type 'Acc \*' is not supported by the browser engine$/);
});

// Regression (same verifier round): the F4 fix silently skipped ANY implicit (unmentioned)
// initializer clause, including one for a field whose type is ANOTHER registered class with its own
// (instrumented) default constructor. That constructor DOES run and DOES emit trace records — C++
// constructs fields in DECLARATION order regardless of the init-list's own order, so an unmentioned
// class-typed field declared before any WRITTEN clause has its (traced) constructor called before
// this constructor's own frame would otherwise get pushed (only a written clause can carry
// pushFrame()), showing the nested call under the wrong caller frame. Narrowed the skip to fields
// whose type is NOT a registered class (std::string/std::vector/scalars are still safe to skip —
// their default construction, real but uninstrumented, emits no trace records either way); a
// registered-class-typed implicit field is rejected explicitly instead, same safe behaviour this
// had before this feature existed for that one narrow shape.
test("an unmentioned field whose type is ANOTHER registered class is rejected explicitly (not silently given the wrong call stack)", async () => {
  const src = `struct In {
public:
    In() : q(3) {}
    int q;
};
struct Out {
public:
    Out(int a) : z(a) {}
    In in;
    int z;
};
int main() {
    Out o(5);
    return 0;
}
`;
  const run = await eng.runProgram(src, "");
  assert.equal(run.ok, false);
  assert.equal(run.errors[0].kind, "unsupported");
  assert.equal(run.errors[0].construct, "constructor initializer");
});
