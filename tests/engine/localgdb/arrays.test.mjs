// C arrays (1-D, multi-dimensional; int/char/double/bool/long long/std::string/std::vector elements) on a real engine
// run of programs/arrays.cpp: stack listing, varobjs, updates, expressions, &(array), GDB print format.
//
// programs/arrays.cpp stops (line: what happened): 6 7 8 10 11 12 13 14 15 16 18 (cand declared, uninitialised)
// 19 (cand = {6, 8, 10}) 20 (a[1] = 60) 21 22
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, newGdb } from "./helpers.mjs";

const SRC = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "arrays.cpp"), "utf8");
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

test("engine run of the fixture: arrays in the trace, decls give `int[3]`-style types", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(run.decls.main.cand, "int[3]");
  assert.equal(run.decls.main.m, "int[2][3]");
  assert.deepEqual(run.steps.map((s) => s.line), [6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22]);
});

test("-stack-list-variables: array types `int [3]`, --simple-values omits the value (golden `cand`), --all-values prints like GDB", async () => {
  const g = await at(20);
  const simple = payloadOf(await send(g, "1-stack-list-variables --simple-values")).variables;
  const by = Object.fromEntries(simple.map((v) => [v.name, v]));
  assert.deepEqual(by.cand, { name: "cand", type: "int [3]" });
  assert.deepEqual([by.m.type, by.s.type, by.L.type, by.names.type, by.vs.type], ["int [2][3]", "char [10]", "long long [2]", "std::string [2]", "std::vector<int, std::allocator<int> > [2]"]);
  assert.ok(!simple.some((v) => v.name === "g"), "globals are not locals");
  const all = Object.fromEntries(payloadOf(await send(g, "1-stack-list-variables --all-values")).variables.map((v) => [v.name, v.value]));
  assert.equal(all.a, "{5, 60, 7}");
  assert.equal(all.m, "{{1, 2, 3}, {4, 5, 6}}");
  assert.equal(all.z, "{9, 0 <repeats 14 times>}");
  assert.match(all.big, /^\{0, 1, 2, .*, 198, 199\.\.\.\}$/, "200-element limit");
  assert.equal(all.big.split(", ").length, 200);
  assert.equal(all.s, '"ab\\000\\000\\000\\000\\000\\000\\000"', "char array as a string, final NUL not printed");
  assert.equal(all.d, "{0.5, 1.25}");
  assert.equal(all.f, "{true, false}");
  assert.equal(all.L, "{1234567890123, -1}");
  assert.equal(all.names, '{"x", "yz"}');
  assert.equal(all.vs, "{std::vector of length 2, capacity 2 = {3, 3}, std::vector of length 0, capacity 0}");
  assert.equal(all.cand, "{6, 8, 10}");
});

test("-var-create: value `[N]`, numchild N, not dynamic; children `var.i` / exp `i`; multi-dimensional; char/string/vector elements; globals", async () => {
  const g = await at(20);
  const mk = async (e) => payloadOf(await send(g, `3-var-create - * "${e}"`));
  assert.deepEqual(await mk("cand"), { name: "var1", numchild: "3", value: "[3]", type: "int [3]", "thread-id": "1", has_more: "0" });
  assert.deepEqual(payloadOf(await send(g, "-var-list-children --all-values var1")), { numchild: "3", children: [
    { name: "var1.0", exp: "0", numchild: "0", value: "6", type: "int", "thread-id": "1" },
    { name: "var1.1", exp: "1", numchild: "0", value: "8", type: "int", "thread-id": "1" },
    { name: "var1.2", exp: "2", numchild: "0", value: "10", type: "int", "thread-id": "1" }], has_more: "0" });
  assert.equal(payloadOf(await send(g, "-var-list-children --simple-values var1")).children[0].value, "6");
  const m = await mk("m");
  assert.deepEqual([m.numchild, m.value, m.type], ["2", "[2]", "int [2][3]"]);
  const mc = payloadOf(await send(g, `-var-list-children --all-values ${m.name}`)).children;
  assert.deepEqual(mc.map((c) => [c.name, c.exp, c.numchild, c.value, c.type]), [[`${m.name}.0`, "0", "3", "[3]", "int [3]"], [`${m.name}.1`, "1", "3", "[3]", "int [3]"]]);
  assert.deepEqual(payloadOf(await send(g, `-var-list-children --all-values ${m.name}.1`)).children.map((c) => c.value), ["4", "5", "6"]);
  const s = await mk("s");
  assert.deepEqual([s.value, s.numchild, s.type], ["[10]", "10", "char [10]"]);
  assert.deepEqual(payloadOf(await send(g, `-var-list-children --all-values ${s.name} 0 3`)).children.map((c) => c.value), ["97 'a'", "98 'b'", "0 '\\000'"]);
  const names = await mk("names");
  assert.deepEqual(payloadOf(await send(g, `-var-list-children --all-values ${names.name}`)).children.map((c) => [c.value, c.type, c.displayhint]), [['"x"', "std::string", "string"], ['"yz"', "std::string", "string"]]);
  const vs = await mk("vs");
  const vk = payloadOf(await send(g, `-var-list-children --all-values ${vs.name}`)).children;
  assert.deepEqual(vk[0], { name: `${vs.name}.0`, exp: "0", numchild: "0", value: "std::vector of length 2, capacity 2", type: "std::vector<int, std::allocator<int> >", "thread-id": "1", displayhint: "array", dynamic: "1" });
  assert.deepEqual(payloadOf(await send(g, `-var-list-children --all-values ${vs.name}.0`)).children.map((c) => c.name), [`${vs.name}.0.[0]`, `${vs.name}.0.[1]`]);
  const glob = await mk("g");
  assert.deepEqual([glob.type, glob.value, "thread-id" in glob], ["int [4]", "[4]", false]);
  assert.deepEqual(payloadOf(await send(g, `-var-delete ${m.name}`)), { ndeleted: "6" }, "m + 2 rows + 3 listed elements of row 1");
});

test("-var-update: element changes are reported through the children; the array varobj (value [N]) never changes; uninitialised array is zeros (D6)", async () => {
  const g = await at(18); // cand declared, not written yet
  await send(g, ["3-var-create - * \"cand\"", "3-var-create - * \"a\""]);
  assert.deepEqual(payloadOf(await send(g, "-var-list-children --all-values var1")).children.map((c) => c.value), ["0", "0", "0"]);
  await send(g, "-var-list-children --all-values var2");
  assert.equal(payloadOf(await send(g, "-data-evaluate-expression cand")).value, "{0, 0, 0}");
  await send(g, "-exec-next"); // line 19: cand = {6, 8, 10}
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist.map((c) => [c.name, c.value]), [["var1.0", "6"], ["var1.1", "8"], ["var1.2", "10"]]);
  await send(g, "-exec-next"); // line 20: a[1] = 60
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [{ name: "var2.1", value: "60", in_scope: "true", type_changed: "false", has_more: "0" }]);
});

test("arrays in expressions, -data-evaluate-expression print format, &(array)", async () => {
  const g = await at(20);
  const tv = async (e) => { const r = payloadOf(await send(g, `3-var-create - * "${e}"`)); return r.msg || [r.value, r.type]; };
  assert.deepEqual(await tv("cand[2]"), ["10", "int"]);
  assert.deepEqual(await tv("cand[1] + a[2]"), ["15", "int"]);
  assert.deepEqual(await tv("m[1][2] * 2"), ["12", "int"]);
  assert.deepEqual(await tv("s[1]"), ["98 'b'", "char"]);
  assert.deepEqual(await tv("L[0] + 1"), ["1234567890124", "long long"]);
  assert.deepEqual(await tv("d[1] * 2"), ["2.5", "double"]);
  assert.deepEqual(await tv("g[3]"), ["4", "int"]);
  assert.deepEqual(await tv("vs[0][1]"), ["3", "int"]);
  assert.equal(await tv("cand[3]"), "Cannot access memory at address 0x0");
  assert.match(await tv("m[1]"), /container\) is not supported by the browser engine$/);
  assert.match(await tv("cand + 1"), /not supported by the browser engine$/, "array-to-pointer decay is not modelled");
  const ev = async (e) => payloadOf(await send(g, `-data-evaluate-expression "${e}"`)).value;
  assert.equal(await ev("m"), "{{1, 2, 3}, {4, 5, 6}}");
  assert.equal(await ev("names"), '{"x", "yz"}');
  const p = payloadOf(await send(g, "3-var-create - * \"&(cand)\""));
  assert.deepEqual([p.type, p.numchild, p.has_more], ["int (*)[3]", "1", "0"]);
  const pc = payloadOf(await send(g, `-var-list-children --all-values ${p.name}`)).children[0];
  assert.deepEqual(pc, { name: `${p.name}.*&(cand)`, exp: "*&(cand)", numchild: "3", value: "[3]", type: "int [3]", "thread-id": "1" });
  assert.deepEqual(payloadOf(await send(g, `-var-list-children --all-values "${p.name}.*&(cand)"`)).children.map((c) => c.value), ["6", "8", "10"]);
  assert.match(await ev("&cand"), /^\(int \(\*\)\[3\]\) 0x7ffe[0-9a-f]+$/);
});
