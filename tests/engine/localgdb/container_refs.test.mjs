// A container passed by reference (vg.h Registry::cont): `void fill(std::vector<int>& v)` writes the caller's v, and the
// caller's varobj / locals must show that while only the callee runs (bubble sort lesson: arr stayed 3,1,2 on screen).
// std::array stores its first element at its own address, so `int& e = a[0]` must NOT become an alias of the whole array,
// and a pointer to a container keeps its old "<ptr>" behaviour (only references look containers up).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "../node_driver.mjs";
import { send, payloadOf, newGdb } from "./helpers.mjs";

const source = [
  "#include <vector>",                                    // 1
  "#include <array>",                                     // 2
  "void fill(std::vector<int>& v) {",                     // 3
  "  v[0] = 9;",                                          // 4
  "  v.push_back(4);",                                    // 5
  "}",                                                    // 6
  "int touch(std::array<int, 2>& a) {",                   // 7
  "  int& e = a[0];",                                     // 8
  "  e = 7;",                                             // 9
  "  return e;",                                          // 10
  "}",                                                    // 11
  "int main() {",                                         // 12
  "  std::vector<int> v = {1, 2};",                       // 13
  "  std::vector<int>* p = &v;",                          // 14
  "  fill(v);",                                           // 15
  "  std::array<int, 2> a = {1, 2};",                     // 16
  "  int r = touch(a);",                                  // 17
  "  return r + (*p)[0];",                                // 18
  "}",                                                    // 19
  "",
].join("\n");

let eng, run;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(source, "");
  if (!run.ok) run = await eng.runProgram(source, ""); // the engine occasionally fails a first run on a cold worker
});
after(() => eng && eng.dispose());

test("the trace says which caller container a vector reference aliases; std::array element refs and pointers do not", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const inFill = run.steps.find((s) => s.fn === "fill");
  const mainFrame = run.steps.find((s) => s.fn === "main").frame;
  assert.equal(inFill.vars["v.ref()"], `${mainFrame}:v`);
  const inTouch = run.steps.filter((s) => s.fn === "touch");
  assert.ok(inTouch.every((s) => !("e.ref()" in s.vars) && !("a.ref()" in s.vars)), JSON.stringify(inTouch.map((s) => Object.keys(s.vars))));
  const withP = run.steps.find((s) => s.fn === "main" && "p" in s.vars);
  assert.equal(withP.vars.p, "<ptr>", "a pointer to a container is unchanged");
});

test("the caller's vector varobj reports the callee's writes while only the callee runs", async () => {
  const g = newGdb(run, source);
  await send(g, "-break-insert -f 15");
  await send(g, "-exec-run");
  assert.equal(payloadOf(await send(g, '-var-create - * "v"')).type.startsWith("std::vector<int"), true);
  await send(g, "-var-list-children --all-values var1");
  await send(g, "-exec-step");   // into fill, line 4
  await send(g, "-exec-next");   // v[0] = 9 done
  const up = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  assert.deepEqual(up.map((c) => [c.name, c.value]), [["var1.[0]", "9"]]);
  await send(g, "-exec-next");   // push_back(4) done: the size changes
  const up2 = payloadOf(await send(g, "-var-update --all-values *")).changelist;
  assert.ok(up2.some((c) => c.name === "var1"), JSON.stringify(up2));
  const kids = payloadOf(await send(g, "-var-list-children --all-values var1")).children;
  assert.deepEqual(kids.map((c) => c.value), ["9", "2", "4"]);
  await send(g, "-stack-select-frame 1");
  const vars = payloadOf(await send(g, "-stack-list-variables --all-values")).variables;
  assert.match(vars.find((x) => x.name === "v").value, /9, 2, 4/);
});
