// Scalar pointers and references (vg.h `v`/`vd`, model.js pseudo addresses, varobj.js pointer varobjs, expr.js unary `*`)
// on a REAL engine run of programs/pointers_refs.cpp:
//   SWAP(int* a, int* b) swaps *a/*b (a = &x, b = &y), RSWAP(int& a, int& b) swaps through references,
//   main then points `p` at x and writes through it; `none` is a null pointer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, newGdb } from "./helpers.mjs";

const source = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "pointers_refs.cpp"), "utf8");
let eng, run;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(source, "");
});
after(() => eng && eng.dispose());

const at = async (line, ...cmds) => {
  const g = newGdb(run, source);
  await send(g, `-break-insert -f ${line}`);
  await send(g, "-exec-run");
  const out = [];
  for (const c of cmds) out.push(payloadOf(await send(g, c)));
  return { g, out };
};
const addr = (v) => /^0x[0-9a-f]+$/.test(v);

test("the trace carries pointer targets and reference aliases (shape the model relies on)", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const swap = run.steps.find((s) => s.fn === "SWAP");
  assert.ok(swap.vars.a && typeof swap.vars.a === "object", "a tracked pointer is an object ({__vgp, __vgv}) in the raw trace");
  assert.equal(swap.vars.a.__vgv, 10, "with the pointee's value as of that stop");
  const rswap = run.steps.find((s) => s.fn === "RSWAP");
  assert.ok(Object.keys(rswap.vars).includes("a.ref()"), "a reference gets a `.ref()` pseudo variable");
});

test("a pointer parameter shows the address of the variable it points to, equal to &(x) in the caller; null prints 0x0", async () => {
  const { g, out } = await at(6, "-stack-list-variables --all-values", "-var-create - * &(a)", "-data-evaluate-expression a");
  const vars = out[0].variables;
  const a = vars.find((v) => v.name === "a"), b = vars.find((v) => v.name === "b");
  assert.equal(a.type, "int *");
  assert.ok(addr(a.value) && addr(b.value) && a.value !== b.value, JSON.stringify(vars));
  assert.equal(out[2].value, `(int *) ${a.value}`);
  // the same address comes out of the caller's `&(x)`
  await send(g, "-stack-select-frame 1");
  const ax = payloadOf(await send(g, "-var-create - * &(x)"));
  assert.equal(ax.value, a.value);
  const ay = payloadOf(await send(g, "-var-create - * &(y)"));
  assert.equal(ay.value, b.value);
  const main = payloadOf(await send(g, "-stack-list-variables --all-values")).variables;
  assert.equal(main.find((v) => v.name === "none").value, "0x0");
});

test("-var-create of a pointer: value = pointee address, one child `*a` with the pointee's current value; follows writes through the pointer", async () => {
  const { g, out } = await at(6, "-var-create - * a", "-var-create - * *a", "-var-create - * &(*a)", "-var-list-children --all-values var1");
  assert.equal(out[0].type, "int *");
  assert.equal(out[0].numchild, "1");
  assert.ok(addr(out[0].value));
  assert.deepEqual({ numchild: out[1].numchild, value: out[1].value, type: out[1].type }, { numchild: "0", value: "10", type: "int" });
  assert.equal(out[2].value, out[0].value); // &(*a) is a's own value
  assert.equal(out[2].type, "int *");
  assert.deepEqual(out[3].children.map((c) => [c.exp, c.value, c.type]), [["*a", "10", "int"]]);
  await send(g, "-exec-next"); // t = *a done; line 7 is `*a = *b`
  await send(g, "-exec-next"); // `*a = *b` done: x is 20 now, written through the pointer while only SWAP's frame runs
  const up = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  assert.deepEqual(up.map((c) => [c.name, c.value]).sort(), [["var1.*a", "20"], ["var2", "20"]]);
});

test("*b and *a in -data-evaluate-expression; dereferencing null is GDB's memory error", async () => {
  const { g, out } = await at(6, "-data-evaluate-expression *b", "-data-evaluate-expression *a + *b");
  assert.equal(out[0].value, "20");
  assert.equal(out[1].value, "30");
  await send(g, "-stack-select-frame 1");
  const it = await send(g, `3-data-evaluate-expression *none`);
  assert.equal(it.find((x) => x.type === "result").payload.msg, "Cannot access memory at address 0x0");
});

test("a pointer declared later in main follows the variable it was given (p = &x, then *p = 5)", async () => {
  const { out } = await at(24, "-var-create - * p", "-var-create - * *p", "-var-create - * x");
  assert.equal(out[1].value, "5");
  assert.equal(out[2].value, "5"); // x itself was written through p
  assert.ok(addr(out[0].value));
});

test("a reference parameter shares its referent's address (what GDB's &(ref) and the memory view alias on)", async () => {
  const { g, out } = await at(12, "-var-create - * a", "-var-create - * &(a)", "-stack-list-variables --all-values", "-data-evaluate-expression &(a)");
  assert.equal(out[0].type, "int &");
  assert.equal(out[0].value, "20");
  const vars = out[2].variables;
  const a = vars.find((v) => v.name === "a");
  const m = /^@(0x[0-9a-f]+): 20$/.exec(a.value);
  assert.ok(m, a.value);
  assert.equal(out[1].value, m[1]);
  assert.equal(out[3].value, `(int *) ${m[1]}`);
  await send(g, "-stack-select-frame 1");
  const ax = payloadOf(await send(g, "-var-create - * &(x)"));
  assert.equal(ax.value, m[1], "the reference and the caller's variable have the same address");
});

test("a caller's variable shows the value a callee wrote through a pointer while only the callee runs", async () => {
  const { g } = await at(6);
  await send(g, "-stack-select-frame 1");
  assert.equal(payloadOf(await send(g, "-var-create - * x")).value, "10"); // `*a = *b` has not run yet
  await send(g, "-stack-select-frame 0");
  await send(g, "-exec-next"); // `*a = *b`: x becomes 20 inside SWAP
  const up = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  assert.deepEqual(up.map((c) => [c.name, c.value]), [["var1", "20"]]);
  await send(g, "-stack-select-frame 1");
  const vars = payloadOf(await send(g, "-stack-list-variables --all-values")).variables;
  assert.equal(vars.find((v) => v.name === "x").value, "20");
  assert.equal(vars.find((v) => v.name === "y").value, "20", "y is still 20 until `*b = t`");
});

// ---- regressions found by an independent verification pass (programs/pointers_edge.cpp) ----
const edge = fs.readFileSync(path.join(ROOT, "tests", "engine", "localgdb", "programs", "pointers_edge.cpp"), "utf8");
let edgeRun;
const atEdge = async (line, ...cmds) => {
  edgeRun ??= await eng.runProgram(edge, "");
  assert.equal(edgeRun.ok, true, JSON.stringify(edgeRun.errors));
  const g = newGdb(edgeRun, edge);
  await send(g, `-break-insert -f ${line}`);
  await send(g, "-exec-run");
  const out = [];
  for (const c of cmds) { const it = await send(g, c); out.push(it.some((x) => x.type === "result" && x.payload !== undefined) ? payloadOf(it) : null); }
  return { g, out };
};

test("an array is never taken for the scalar its first element's address points to (the caller's array keeps its shape)", async () => {
  const { out } = await atEdge(8, "-stack-select-frame 1", "-stack-list-variables --all-values", "-data-evaluate-expression arr[1]");
  assert.deepEqual(out[1].variables.find((v) => v.name === "arr"), { name: "arr", type: "int [3]", value: "{1, 2, 3}" });
  assert.equal(out[2].value, "2");
});

test("a pointer in a caller's frame follows what the callee wrote through its copy (*p after store5(p) writes x)", async () => {
  const { out } = await atEdge(13, "-stack-select-frame 1", "-stack-list-variables --all-values", "-data-evaluate-expression *p", "-var-create - * *p");
  const x = out[1].variables.find((v) => v.name === "x");
  assert.equal(x.value, "5");
  assert.equal(out[2].value, "5");
  assert.equal(out[3].value, "5");
});

test("a pointer to a global has the global's address (&(G))", async () => {
  const { out } = await atEdge(18, "-stack-list-variables --all-values", "-var-create - * &(G)", "-var-create - * *g");
  const gp = out[0].variables.find((v) => v.name === "g");
  assert.equal(gp.value, out[1].value);
  assert.equal(out[2].value, "9"); // `*g = 9` ran at line 17
});

test("a callee assigning through `int*& r` moves the caller's pointer too", async () => {
  const src = "void setp(int*& r, int* to) {\n  r = to;\n  int t = 0;\n}\nint main() {\n  int a = 1, b = 2;\n  int* pp = &a;\n  setp(pp, &b);\n  return 0;\n}\n";
  const r = await eng.runProgram(src, "");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const g = newGdb(r, src);
  await send(g, "-break-insert -f 3");
  await send(g, "-exec-run");
  assert.equal(payloadOf(await send(g, "-data-evaluate-expression *r")).value, "2");
  await send(g, "-stack-select-frame 1");
  const pp = payloadOf(await send(g, "-stack-list-variables --all-values")).variables.find((v) => v.name === "pp");
  const ab = payloadOf(await send(g, "-var-create - * &(b)"));
  assert.equal(pp.value, ab.value, "pp points at b while setp runs");
  assert.equal(payloadOf(await send(g, "-data-evaluate-expression *pp")).value, "2");
});
