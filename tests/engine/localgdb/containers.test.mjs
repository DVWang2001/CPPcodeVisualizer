// std::deque/list/stack/queue on a real engine run of programs/containers.cpp: var-create value/type text,
// var-list-children flat `.[i]` children, var-update after growth — checked against real GDB (docker exec
// cppcodevisualizer-gdbgui-1, gdb -i mi -enable-pretty-printing), including a second independent verification
// pass (2026-09-28) that caught and corrected three list-specific mistakes in the first pass:
//   deque: value "std::deque with N elements", displayhint "array", print format "{1, 2, 3}" (no index labels)
//   list:  value "std::__cxx11::list" / "empty std::__cxx11::list" when empty (no count either way — the list
//          printer avoids an O(n) size(), so it only distinguishes empty from non-empty); no displayhint at
//          all; type field "std::__cxx11::list<...>" (the __cxx11 tag, like basic_string's); print format
//          labels each child "{[0] = 4, [1] = 5, [2] = 6}" (unlike deque/stack/queue)
//   stack: value "std::stack wrapping: std::deque with N elements", displayhint "array", children bottom-to-top
//   queue: value "std::queue wrapping: std::deque with N elements", displayhint "array", children front-to-back
// std::map/std::set/std::priority_queue/std::unordered_* remain unsupported (documented gap: unordered_*
// iteration order depends on libstdc++'s internal hash-bucket layout, not reproduced here).
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
  const g = await at(20); // after dq={1,2,3}, before push_back(4)
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
  const g = await at(20);
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
  const g = await at(20); // sk pushed 1,2,3
  const v = payloadOf(await send(g, `3-var-create - * "sk"`));
  assert.deepEqual([v.value, v.displayhint], ["std::stack wrapping: std::deque with 3 elements", "array"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => c.value), ["1", "2", "3"]);
});

test("-var-create: queue — 'wrapping: std::deque with N elements', children front-to-back (push order)", async () => {
  const g = await at(20); // qu pushed 1,2,3
  const v = payloadOf(await send(g, `3-var-create - * "qu"`));
  assert.deepEqual([v.value, v.displayhint], ["std::queue wrapping: std::deque with 3 elements", "array"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children.map((c) => c.value), ["1", "2", "3"]);
});

test("-var-create: empty deque — 'with 0 elements', has_more 0, no children", async () => {
  const g = await at(20);
  const v = payloadOf(await send(g, `3-var-create - * "empty_dq"`));
  assert.deepEqual([v.value, v.has_more], ["std::deque with 0 elements", "0"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children, []);
});

test("-var-create: empty list — 'empty std::__cxx11::list' (not 'with 0 elements'), has_more 0", async () => {
  const g = await at(20);
  const v = payloadOf(await send(g, `3-var-create - * "empty_ls"`));
  assert.deepEqual([v.value, v.has_more], ["empty std::__cxx11::list", "0"]);
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${v.name}`));
  assert.deepEqual(kids.children, []);
});

test("-var-create: singular 'element' for a 1-element container", async () => {
  const g = await at(20);
  const v = payloadOf(await send(g, `3-var-create - * "one_sk"`));
  assert.equal(v.value, "std::stack wrapping: std::deque with 1 element");
});

test("-var-update: growth after push_back/push/pop is reflected (numchild via var-list-children, value text, no crash)", async () => {
  const g = await at(20);
  const vdq = payloadOf(await send(g, `3-var-create - * "dq"`));
  const vsk = payloadOf(await send(g, `3-var-create - * "sk"`));
  const vqu = payloadOf(await send(g, `3-var-create - * "qu"`));
  const vls = payloadOf(await send(g, `3-var-create - * "ls"`));
  await send(g, `-var-list-children --all-values ${vdq.name}`);
  await send(g, `-var-list-children --all-values ${vsk.name}`);
  await send(g, `-var-list-children --all-values ${vqu.name}`);
  await send(g, `-var-list-children --all-values ${vls.name}`);
  await send(g, "-break-insert -f 24");
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
  const g = await at(20);
  const dq = payloadOf(await send(g, `1-data-evaluate-expression "dq"`));
  assert.equal(dq.value, "std::deque with 3 elements = {1, 2, 3}");
  const sk = payloadOf(await send(g, `2-data-evaluate-expression "sk"`));
  assert.equal(sk.value, "std::stack wrapping: std::deque with 3 elements = {1, 2, 3}");
  const ls = payloadOf(await send(g, `3-data-evaluate-expression "ls"`));
  assert.equal(ls.value, "std::__cxx11::list = {[0] = 4, [1] = 5, [2] = 6}");
  const els = payloadOf(await send(g, `4-data-evaluate-expression "empty_ls"`));
  assert.equal(els.value, "empty std::__cxx11::list");
});

test("still unsupported: std::map/std::set/std::priority_queue/std::unordered_* (documented gap)", async () => {
  // No fixture declares these; classify()/isSupported() is the contract under test (see types_scopes.test.mjs).
  const { classify, isSupported, parseType } = await import("../../../gdbgui/static/engine/localgdb/types.js");
  for (const q of ["std::map<int,int>", "std::set<int>", "std::priority_queue<int>", "std::unordered_set<int>", "std::unordered_map<int,int>"]) {
    assert.equal(isSupported(classify(parseType(q))), false, q);
  }
});
