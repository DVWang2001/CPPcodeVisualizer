// std::deque/list/stack/queue/priority_queue/set/map on a real engine run of programs/containers.cpp:
// var-create value/type text, var-list-children flat `.[i]` children, var-update after growth —
// checked against real GDB (docker exec cppcodevisualizer-gdbgui-1, gdb -i mi -enable-pretty-printing),
// including a second independent verification pass (2026-09-28) that caught and corrected three
// list-specific mistakes in the first pass, and a third pass (2026-09-29) adding priority_queue/set/map:
//   deque: value "std::deque with N elements", displayhint "array", print format "{1, 2, 3}" (no index labels)
//   list:  value "std::__cxx11::list" / "empty std::__cxx11::list" when empty (no count either way — the list
//          printer avoids an O(n) size(), so it only distinguishes empty from non-empty); no displayhint at
//          all; type field "std::__cxx11::list<...>" (the __cxx11 tag, like basic_string's); print format
//          labels each child "{[0] = 4, [1] = 5, [2] = 6}" (unlike deque/stack/queue)
//   stack: value "std::stack wrapping: std::deque with N elements", displayhint "array", children bottom-to-top
//   queue: value "std::queue wrapping: std::deque with N elements", displayhint "array", children front-to-back
//   priority_queue: value "std::priority_queue wrapping: std::vector of length N, capacity M", displayhint
//          "array", children in the underlying heap array's raw layout in real GDB — LocalGdb intentionally
//          diverges here (drains top()/pop() into priority order instead; vg.h has no way to read the raw
//          heap array, only iterate — see vg.h's is_priority_queue<T>), a documented simplification
//   set:   value "std::set with N elements", NO displayhint (like list), children flat `.[i]`, print format
//          DOES label each child "{[0] = 1, [1] = 2, [2] = 3}" (like list, unlike deque/stack/queue/pqueue).
//          multiset/unordered_set/unordered_multiset share the same shape (unordered_* iterate in the wasm
//          sysroot's own hash-bucket order, not guaranteed to match a native GDB session's for the same input)
//   map:   value "std::map with N elements", displayhint "map", children FLAT and ALTERNATING (key, value,
//          key, value, ... — numchild = 2×N, not N; key child type "const K", value child type "V") — this
//          is GDB's newer map display; the older `{first = K, second = V}` pair-struct format is not
//          replicated. multimap/unordered_map/unordered_multimap share the same shape.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, newGdb } from "./helpers.mjs";

const SRC = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "containers.cpp"), "utf8");
let eng, run;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(SRC, "");
});
after(() => eng && eng.dispose());
const fresh = () => newGdb(run, SRC);
async function at(line) {
  const g = fresh();
  await send(g, `-break-insert -f ${line}`);
  await send(g, "-exec-run");
  return g;
}

test("engine run of the fixture compiles and reaches every line", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
});

test("-var-create: deque — value, type, displayhint array, flat .[i] children", async () => {
  const g = await at(30); // after dq={1,2,3}, before push_back(4)
  const v = payloadOf(await send(g, `3-var-create - * "dq"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, v.displayhint, v.dynamic, v.has_more],
    ["std::deque with 3 elements", "std::deque<int, std::allocator<int> >", "0", "array", "1", "1"]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.equal(kids.displayhint, "array");
  assert.deepEqual(kids.children.map((c) => [c.name, c.exp, c.value, c.type]), [
    [`${v.name}.[0]`, "[0]", "1", "int"],
    [`${v.name}.[1]`, "[1]", "2", "int"],
    [`${v.name}.[2]`, "[2]", "3", "int"],
  ]);
});

test("-var-create: list — value/type carry the __cxx11 tag, no count, no displayhint at all", async () => {
  const g = await at(30);
  const v = payloadOf(await send(g, `3-var-create - * "ls"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, v.dynamic, "displayhint" in v],
    ["std::__cxx11::list", "std::__cxx11::list<int, std::allocator<int> >", "0", "1", false]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.equal("displayhint" in kids, false);
  assert.deepEqual(kids.children.map((c) => c.value), ["4", "5", "6"]);
});

test("-var-create: stack — 'wrapping: std::deque with N elements', children bottom-to-top (push order)", async () => {
  const g = await at(30); // sk pushed 1,2,3
  const v = payloadOf(await send(g, `3-var-create - * "sk"`));
  assert.deepEqual([v.value, v.displayhint], ["std::stack wrapping: std::deque with 3 elements", "array"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => c.value), ["1", "2", "3"]);
});

test("-var-create: queue — 'wrapping: std::deque with N elements', children front-to-back (push order)", async () => {
  const g = await at(30); // qu pushed 1,2,3
  const v = payloadOf(await send(g, `3-var-create - * "qu"`));
  assert.deepEqual([v.value, v.displayhint], ["std::queue wrapping: std::deque with 3 elements", "array"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => c.value), ["1", "2", "3"]);
});

test("-var-create: empty deque — 'with 0 elements', has_more 0, no children", async () => {
  const g = await at(30);
  const v = payloadOf(await send(g, `3-var-create - * "empty_dq"`));
  assert.deepEqual([v.value, v.has_more], ["std::deque with 0 elements", "0"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children, []);
});

test("-var-create: empty list — 'empty std::__cxx11::list' (not 'with 0 elements'), has_more 0", async () => {
  const g = await at(30);
  const v = payloadOf(await send(g, `3-var-create - * "empty_ls"`));
  assert.deepEqual([v.value, v.has_more], ["empty std::__cxx11::list", "0"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children, []);
});

// Regression: a dynamic container that starts genuinely empty (has_more "0" at -var-create, like
// deque/set/map/pqueue all do — only vector is unconditionally "1") must still report has_more "1"
// on the FIRST -var-update once it grows, even though -var-list-children was never called. Ground
// truth from a real `gdb -i mi -enable-pretty-printing` session against the exact same push sequence.
// Before this fix, has_more was hardcoded "0" in every -var-update changelist entry: the frontend
// (GdbVariable.tsx) uses a growing has_more:"1" in the changelist as its ONLY trigger to ever call
// -var-list-children for a container that started empty (its create-time has_more was already "0",
// so the create-time recovery path never fires either) — so numchild stayed stuck at 0 forever and
// the container looked permanently empty in the UI despite `value` correctly updating underneath.
// No existing test caught this: the deque/stack/queue growth test above starts non-empty (dq/sk/qu
// already have 3 pushed elements before the tested breakpoint), never exercising empty-to-first-insert.
for (const [decl, typeDecl, ops, label] of [
  ["#include <deque>", "deque<int>", ["x.push_back(5);"], "deque"],
  ["#include <set>", "set<int>", ["x.insert(5);"], "set"],
  ["#include <map>", "map<int,int>", ["x[1] = 10;"], "map"],
]) {
  test(`-var-update: ${label} growing from empty reports has_more "1" without -var-list-children ever being called first`, async () => {
    const src = [decl, "using namespace std;", "int main() {", `    ${typeDecl} x;`, `    ${ops[0]}`, "    return 0;", "}", ""].join("\n");
    const localRun = await eng.runProgram(src, "");
    assert.equal(localRun.ok, true, JSON.stringify(localRun.errors));
    const g = newGdb(localRun, src);
    await send(g, "-break-insert -f 5"); // the push_back/insert/[]= line itself, x still empty here
    await send(g, "-exec-run");
    const v = payloadOf(await send(g, `3-var-create - * "x"`));
    assert.equal(v.has_more, "0", "starts empty, like real GDB");
    await send(g, "-exec-next"); // runs the insert, lands on the next line
    const upd = payloadOf(await send(g, "-var-update --all-values *")).changelist;
    const entry = upd.find((u) => u.name === v.name);
    assert.ok(entry, "x should appear in the changelist (its value changed)");
    assert.equal(entry.has_more, "1", `${label}: has_more must flip to "1" once non-empty, or the frontend never refetches children`);
  });
}

test("-var-create: singular 'element' for a 1-element container", async () => {
  const g = await at(30);
  const v = payloadOf(await send(g, `3-var-create - * "one_sk"`));
  assert.equal(v.value, "std::stack wrapping: std::deque with 1 element");
});

test("-var-update: growth after push_back/push/pop is reflected (numchild via var-list-children, value text, no crash)", async () => {
  const g = await at(30);
  const vdq = payloadOf(await send(g, `3-var-create - * "dq"`));
  const vsk = payloadOf(await send(g, `3-var-create - * "sk"`));
  const vqu = payloadOf(await send(g, `3-var-create - * "qu"`));
  const vls = payloadOf(await send(g, `3-var-create - * "ls"`));
  await send(g, `-var-list-children --all-values ${vdq.name}`);
  await send(g, `-var-list-children --all-values ${vsk.name}`);
  await send(g, `-var-list-children --all-values ${vqu.name}`);
  await send(g, `-var-list-children --all-values ${vls.name}`);
  await send(g, "-break-insert -f 37");
  await send(g, "-exec-continue");
  const upd = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  const by = Object.fromEntries(upd.map((u) => [u.name, u]));
  assert.equal(by[vdq.name].value, "std::deque with 4 elements");
  assert.equal(by[vsk.name].value, "std::stack wrapping: std::deque with 4 elements");
  assert.equal(by[vqu.name].value, "std::queue wrapping: std::deque with 2 elements");
  assert.equal(by[vls.name].value, "std::__cxx11::list"); // still 2 elements, still no count
  const dqKids = payloadOf(await send(g, `-var-list-children --all-values ${vdq.name}`));
  assert.deepEqual(dqKids.children.map((c) => c.value), ["1", "2", "3", "4"]);
  const skKids = payloadOf(await send(g, `-var-list-children --all-values ${vsk.name}`));
  assert.deepEqual(skKids.children.map((c) => c.value), ["1", "2", "3", "9"]);
  const quKids = payloadOf(await send(g, `-var-list-children --all-values ${vqu.name}`));
  assert.deepEqual(quKids.children.map((c) => c.value), ["2", "3"]);
  const lsKids = payloadOf(await send(g, `-var-list-children --all-values ${vls.name}`));
  assert.deepEqual(lsKids.children.map((c) => c.value), ["5", "6"]);
});

test("-data-evaluate-expression: GDB print format with children (deque/stack plain, list index-labelled)", async () => {
  const g = await at(30);
  const dq = payloadOf(await send(g, `1-data-evaluate-expression "dq"`));
  assert.equal(dq.value, "std::deque with 3 elements = {1, 2, 3}");
  const sk = payloadOf(await send(g, `2-data-evaluate-expression "sk"`));
  assert.equal(sk.value, "std::stack wrapping: std::deque with 3 elements = {1, 2, 3}");
  const ls = payloadOf(await send(g, `3-data-evaluate-expression "ls"`));
  assert.equal(ls.value, "std::__cxx11::list = {[0] = 4, [1] = 5, [2] = 6}");
  const els = payloadOf(await send(g, `4-data-evaluate-expression "empty_ls"`));
  assert.equal(els.value, "empty std::__cxx11::list");
});

test("-var-create: priority_queue — value/type match real GDB, displayhint array; children are OUR priority-drain order, not GDB's raw heap array (documented divergence)", async () => {
  const g = await at(30); // pq pushed 3,1,4
  const v = payloadOf(await send(g, `3-var-create - * "pq"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, v.displayhint, v.dynamic, v.has_more],
    ["std::priority_queue with 3 elements", "std::priority_queue<int, std::vector<int, std::allocator<int> >, std::less<int> >", "0", "array", "1", "1"]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  // Real GDB shows the raw heap array {4, 1, 3}; we show priority-extraction order {4, 3, 1} — see vg.h.
  assert.deepEqual(kids.children.map((c) => c.value), ["4", "3", "1"]);
});

test("-var-create: set — value/type/children match real GDB exactly, NO displayhint (like list)", async () => {
  const g = await at(30); // st = {3, 1, 2}
  const v = payloadOf(await send(g, `3-var-create - * "st"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, "displayhint" in v, v.dynamic, v.has_more],
    ["std::set with 3 elements", "std::set<int, std::less<int>, std::allocator<int> >", "0", false, "1", "1"]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.equal("displayhint" in kids, false);
  assert.deepEqual(kids.children.map((c) => [c.name, c.exp, c.value, c.type]), [
    [`${v.name}.[0]`, "[0]", "1", "int"],
    [`${v.name}.[1]`, "[1]", "2", "int"],
    [`${v.name}.[2]`, "[2]", "3", "int"],
  ]);
});

test("-var-create: map — value/type/children (flat alternating key,value, numchild 2×N) match real GDB exactly", async () => {
  const g = await at(30); // mp = {1: 10, 2: 20}
  const v = payloadOf(await send(g, `3-var-create - * "mp"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, v.displayhint, v.dynamic, v.has_more],
    ["std::map with 2 elements", "std::map<int, int, std::less<int>, std::allocator<std::pair<int const, int> > >", "0", "map", "1", "1"]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.equal(kids.displayhint, "map");
  assert.deepEqual(kids.children.map((c) => [c.exp, c.value, c.type]), [
    ["[0]", "1", "const int"], ["[1]", "10", "int"],
    ["[2]", "2", "const int"], ["[3]", "20", "int"],
  ]);
});

test("-var-update: priority_queue/set/map growth after push/insert/[]= is reflected (new_num_children, values)", async () => {
  const g = await at(30);
  const vpq = payloadOf(await send(g, `3-var-create - * "pq"`));
  const vst = payloadOf(await send(g, `4-var-create - * "st"`));
  const vmp = payloadOf(await send(g, `5-var-create - * "mp"`));
  await send(g, `-var-list-children --all-values ${vpq.name}`);
  await send(g, `-var-list-children --all-values ${vst.name}`);
  await send(g, `-var-list-children --all-values ${vmp.name}`);
  await send(g, "-break-insert -f 37");
  await send(g, "-exec-continue"); // pq.push(5); st.insert(0); mp[3] = 30;
  const upd = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  const by = Object.fromEntries(upd.map((u) => [u.name, u]));
  assert.equal(by[vpq.name].value, "std::priority_queue with 4 elements");
  assert.equal(by[vpq.name].new_num_children, "4");
  assert.equal(by[vst.name].value, "std::set with 4 elements");
  assert.equal(by[vst.name].new_num_children, "4");
  assert.equal(by[vmp.name].value, "std::map with 3 elements");
  assert.equal(by[vmp.name].new_num_children, "6"); // 3 entries × 2 (flat alternating)
  const pqKids = payloadOf(await send(g, `-var-list-children --all-values ${vpq.name}`));
  assert.deepEqual(pqKids.children.map((c) => c.value), ["5", "4", "3", "1"]);
  const stKids = payloadOf(await send(g, `-var-list-children --all-values ${vst.name}`));
  assert.deepEqual(stKids.children.map((c) => c.value), ["0", "1", "2", "3"]);
  const mpKids = payloadOf(await send(g, `-var-list-children --all-values ${vmp.name}`));
  assert.deepEqual(mpKids.children.map((c) => c.value), ["1", "10", "2", "20", "3", "30"]);
});

test("still unsupported (documented gap): a map/set/priority_queue of an unsupported key/element type", async () => {
  const { classify, isSupported, parseType } = await import("../../../gdbgui/static/engine/localgdb/types.js");
  for (const q of ["std::map<int,int*>", "std::set<int*>", "std::priority_queue<int*>"]) {
    assert.equal(isSupported(classify(parseType(q))), false, q);
  }
});

test("std::pair (standalone element type, not map's key/value) is supported when both members are", async () => {
  const { classify, isSupported, parseType } = await import("../../../gdbgui/static/engine/localgdb/types.js");
  assert.equal(isSupported(classify(parseType("std::pair<int,int>"))), true);
  // still correctly rejected when a member itself isn't supported, same as map's key/value check.
  assert.equal(isSupported(classify(parseType("std::pair<int,int*>"))), false);
});

// 走迷宮教案（BFS 用 queue<pair<int,int>> 存座標）驗證容器渲染時發現：pair 當某個容器的「元素型別」
// （不是 map 的 key/value——那條路本來就通）從來沒有支援過，classify() 對 std::pair 直接落到
// default 的 {kind:"other"}，isSupported() 因此永遠回 false，-var-create 直接被拒絕、回
// "type '...' is not supported by the browser engine"。對照真實 GDB（docker exec 起
// `gdb -i mi -enable-pretty-printing`）：一個 queue<pair<int,int>> 元素是葉節點字串
// "{first = X, second = Y}"（numchild="0"，不會再往下展開），不是 map 那種攤平交錯的 key/value
// 子節點——這支測試鎖住這個格式。
test("-var-create: queue<pair<int,int>> — pair elements format as leaf \"{first = X, second = Y}\" strings", async () => {
  const src = [
    "#include <queue>",
    "#include <utility>",
    "using namespace std;",
    "int main() {",
    "    queue<pair<int,int>> q;",
    "    q.push({1, 0});",
    "    q.push({2, 3});",
    "    return 0;",
    "}",
    "",
  ].join("\n");
  const localRun = await eng.runProgram(src, "");
  assert.equal(localRun.ok, true, JSON.stringify(localRun.errors));
  const g = newGdb(localRun, src);
  await send(g, "-break-insert -f 8");
  await send(g, "-exec-run");
  const v = payloadOf(await send(g, `3-var-create - * "q"`));
  assert.deepEqual(
    [v.value, v.type, v.numchild, v.displayhint, v.dynamic, v.has_more],
    [
      "std::queue wrapping: std::deque with 2 elements",
      "std::queue<std::pair<int, int>, std::deque<std::pair<int, int>, std::allocator<std::pair<int, int> > > >",
      "0",
      "array",
      "1",
      "1",
    ]
  );
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => [c.exp, c.numchild, c.value, c.type]), [
    ["[0]", "0", "{first = 1, second = 0}", "std::pair<int, int>"],
    ["[1]", "0", "{first = 2, second = 3}", "std::pair<int, int>"],
  ]);
});
