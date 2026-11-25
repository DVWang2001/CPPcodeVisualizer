// display "after" (2026-11-25 plan docs/superpowers/plans/2026-11-25-after-view-plan.md): a stop on line L shows the
// state AFTER line L ran — the next stop of the same function call — while the stops themselves stay where they are.
// display "before" (the default) must keep answering exactly as before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "../node_driver.mjs";
import { newGdb, send, payloadOf, stopped, frameLine } from "./helpers.mjs";

const SRC = [
  "#include <iostream>", //  1
  "#include <stack>", //  2
  "int g[3];", //  3
  "void bump(int &r) {", //  4
  "  r = r + 10;", //  5
  "}", //  6
  "int sq(int v) {", //  7
  "  int w = v * v;", //  8
  "  return w;", //  9
  "}", // 10
  "int main() {", // 11
  "  int x = 1;", // 12
  "  x = 5;", // 13
  "  std::stack<int> st;", // 14
  "  st.push(7);", // 15
  "  st.push(8);", // 16
  "  st.pop();", // 17
  "  for (int i = 0; i < 2; i++) {", // 18
  "    g[i] = i + 1;", // 19
  "  }", // 20
  "  bump(x);", // 21
  "  int y = sq(3);", // 22
  '  std::cout << "y=" << y << std::endl;', // 23
  "  return 0;", // 24
  "}", // 25
  "",
].join("\n");

const GRID = [
  "#include <vector>", // 1
  "int main() {", // 2
  "  std::vector<std::vector<int>> dp(2, std::vector<int>(2, 0));", // 3
  "  dp[0][1] = 5;", // 4
  "  dp[1][0] = 7;", // 5
  "  return 0;", // 6
  "}", // 7
  "",
].join("\n");

const SAY = [
  "#include <iostream>", // 1
  "void say(int v) {", // 2
  '  std::cout << "v=" << v << std::endl;', // 3
  "}", // 4
  "int main() {", // 5
  "  say(4);", // 6
  "  return 0;", // 7
  "}", // 8
  "",
].join("\n");

const SWAP = [
  "void SWAP(int* a, int* b) {", // 1
  "  int t = *a;", // 2
  "  *a = *b;", // 3
  "  *b = t;", // 4
  "}", // 5
  "int main() {", // 6
  "  int x = 10, y = 20;", // 7
  "  SWAP(&x, &y);", // 8
  "  return 0;", // 9
  "}", // 10
  "",
].join("\n");

let eng, run, grid, sayRun, swapRun;
before(async () => {
  eng = await loadNodeEngine();
  // a cold first compile can exceed the budget once; retry like cell_jump.test.mjs
  for (let i = 0; i < 2 && !(run && run.ok); i++) run = await eng.runProgram(SRC, "", {});
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  for (let i = 0; i < 2 && !(grid && grid.ok); i++) grid = await eng.runProgram(GRID, "", {});
  assert.equal(grid.ok, true, JSON.stringify(grid.errors));
  for (let i = 0; i < 2 && !(sayRun && sayRun.ok); i++) sayRun = await eng.runProgram(SAY, "", {});
  assert.equal(sayRun.ok, true, JSON.stringify(sayRun.errors));
  for (let i = 0; i < 2 && !(swapRun && swapRun.ok); i++) swapRun = await eng.runProgram(SWAP, "", {});
  assert.equal(swapRun.ok, true, JSON.stringify(swapRun.errors));
});
after(() => eng && eng.dispose());

const afterGdb = (o = {}) => newGdb(run, SRC, { display: "after", ...o });

/** `-stack-list-variables --all-values` of the selected frame as name -> value. */
async function vars(g) {
  const out = {};
  for (const v of payloadOf(await send(g, "-stack-list-variables --all-values")).variables) out[v.name] = v.value;
  return out;
}
const evalExpr = async (g, e) => payloadOf(await send(g, `-data-evaluate-expression ${e}`)).value;

/** Every stop of `-exec-next` from a breakpoint at main to the end: [line, x, i] per stop. */
async function walk(g) {
  await send(g, "-break-insert -f main");
  const out = [];
  let r = await send(g, "-exec-run");
  while (stopped(r) && stopped(r).payload.frame) {
    out.push(frameLine(r));
    r = await send(g, "-exec-next");
  }
  return out;
}

test("after: the stops are the same lines as before (only what they show changes)", async () => {
  assert.deepEqual(await walk(afterGdb()), await walk(newGdb(run, SRC)));
});

test("after: assignment, declaration, push and pop lines show the state after the line ran", async () => {
  const g = afterGdb();
  await send(g, "-break-insert -f main");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 12);
  assert.equal((await vars(g)).x, "1"); // int x = 1;
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 13);
  assert.equal((await vars(g)).x, "5"); // x = 5;
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 14);
  assert.match((await vars(g)).st, /with 0 elements/); // std::stack<int> st;
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 15);
  assert.match((await vars(g)).st, /with 1 element/); // st.push(7);
  // the same through a variable object, as the panels read it
  const vo = payloadOf(await send(g, "-var-create - * st"));
  const kids = (name) => send(g, `-var-list-children --all-values ${name}`).then((it) => (payloadOf(it).children || []).map((c) => c.value));
  assert.deepEqual(await kids(vo.name), ["7"]);
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 16);
  const up = payloadOf(await send(g, "-var-update --all-values *")).changelist.find((c) => c.name === vo.name);
  assert.ok(up, "the stack varobj changed at the push(8) stop");
  assert.match(up.value, /with 2 elements/);
  assert.deepEqual(await kids(vo.name), ["7", "8"]); // st.push(8);
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 17);
  await send(g, "-var-update --all-values *");
  assert.deepEqual(await kids(vo.name), ["7"]); // st.pop();
});

test("after: for header and body; a global written by the line; the loop variable after the last increment", async () => {
  const g = afterGdb();
  await send(g, "-break-insert -f 18");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 18);
  assert.equal((await vars(g)).i, "0"); // init ran
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 19);
  assert.equal(await evalExpr(g, "g"), "{1, 0, 0}"); // g[0] = 1 already stored
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 18);
  assert.equal((await vars(g)).i, "1"); // i++ ran
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 19);
  assert.equal(await evalExpr(g, "g"), "{1, 2, 0}");
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 18);
  // documented limit: the loop ends at this increment, `i` no longer exists at the next stop -> its value before the line
  assert.equal((await vars(g)).i, "1");
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 21);
});

test("after: a call line shows the whole line's result; a [step-in] line shows the moment of the call", async () => {
  const plain = afterGdb();
  const la = [];
  plain.socket.on("vg_line_after", (p) => la.push(p));
  await send(plain, "-break-insert -f 21");
  let r = await send(plain, "-exec-run");
  assert.equal(frameLine(r), 21);
  assert.equal((await vars(plain)).x, "15"); // bump(x) ran
  assert.equal(la.at(-1).view, "after");

  const stepIn = afterGdb({ callEntryLines: [21] });
  const la2 = [];
  stepIn.socket.on("vg_line_after", (p) => la2.push(p));
  await send(stepIn, "-break-insert -f 21");
  r = await send(stepIn, "-exec-run");
  assert.equal(frameLine(r), 21);
  assert.equal((await vars(stepIn)).x, "5"); // the call has not happened yet
  assert.equal(la2.at(-1).view, "call");
  r = await send(stepIn, "-exec-step");
  assert.equal(frameLine(r), 5);
  assert.match((await vars(stepIn)).r, /15$/); // r = r + 10 ran (r refers to main's x)
  await send(stepIn, "-stack-select-frame 1");
  assert.equal((await vars(stepIn)).x, "15"); // the caller sees the write through the reference
  await send(stepIn, "-stack-select-frame 0");
  r = await send(stepIn, "-exec-finish");
  assert.equal(frameLine(r), 21);
  assert.equal((await vars(stepIn)).x, "15"); // back on the call line: the whole line ran
  assert.equal(la2.at(-1).view, "after");
});

test("after: a breakpoint inside the callee also shows the call moment (the player will see the callee first)", async () => {
  const g = afterGdb();
  await send(g, "-break-insert -f 22");
  await send(g, "-break-insert -f 8");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 22);
  assert.notEqual((await vars(g)).y, "9");
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 8); // stopped inside sq by the breakpoint
  assert.equal((await vars(g)).w, "9"); // int w = v * v; ran

  const h = afterGdb();
  await send(h, "-break-insert -f 22");
  r = await send(h, "-exec-run");
  assert.equal(frameLine(r), 22);
  assert.equal((await vars(h)).y, "9"); // no stop inside sq: the line's result
});

test("after: return line shows the state after it; the closing brace shows its own", async () => {
  const g = afterGdb();
  const la = [];
  g.socket.on("vg_line_after", (p) => la.push(p));
  await send(g, "-break-insert -f 9");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 9);
  assert.equal((await vars(g)).w, "9");
  assert.equal(la.at(-1).view, "after");
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 10);
  assert.equal(la.at(-1).view, "end");
});

test("after: the output pane gets the program's output up to the state shown, replaced (not appended)", async () => {
  const g = afterGdb();
  const outs = [];
  let pty = 0;
  g.socket.on("vg_program_output", (p) => outs.push(p.text));
  g.socket.on("program_pty_response", () => pty++);
  await send(g, "-break-insert -f 22");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 22);
  assert.deepEqual(outs, [""]);
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 23);
  assert.deepEqual(outs, ["", "y=9\r\n"]); // line 23 printed
  r = await send(g, "-exec-next --reverse");
  assert.equal(frameLine(r), 22);
  assert.deepEqual(outs, ["", "y=9\r\n", ""]); // back: the output is taken away again
  await send(g, "-exec-continue");
  assert.equal(outs.at(-1), "y=9\r\n");
  assert.equal(pty, 0, "display after never appends through program_pty_response");
});

test("after: a call line's printed output includes what its callee printed (the line's whole result)", async () => {
  const g = newGdb(sayRun, SAY, { display: "after" });
  const la = [];
  const outs = [];
  g.socket.on("vg_line_after", (p) => la.push(p));
  g.socket.on("vg_program_output", (p) => outs.push(p.text));
  await send(g, "-break-insert -f 6");
  const r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 6);
  assert.equal(la.at(-1).view, "after");
  assert.equal(la.at(-1).stdout, "v=4\n");
  assert.equal(outs.at(-1), "v=4\r\n");
  // display before: S3 keeps cutting at the very next stop (say's first line), so the call line printed nothing yet
  const b = newGdb(sayRun, SAY);
  const lb = [];
  b.socket.on("vg_line_after", (p) => lb.push(p));
  await send(b, "-break-insert -f 6");
  await send(b, "-exec-run");
  assert.equal(lb.at(-1).stdout, "");
});

test("after: writes through pointers — the pointee, the pointer's child varobj and the caller's frame show the line's result", async () => {
  const g = newGdb(swapRun, SWAP, { display: "after" });
  await send(g, "-break-insert -f 3");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 3); // *a = *b;
  assert.equal(await evalExpr(g, "*a"), "20");
  assert.equal(await evalExpr(g, "t"), "10");
  const pa = payloadOf(await send(g, "-var-create - * a"));
  const kids = payloadOf(await send(g, `-var-list-children --all-values ${pa.name}`)).children;
  assert.deepEqual(kids.map((c) => [c.exp, c.value]), [["*a", "20"]]); // what the pointer panel reads
  await send(g, "-stack-select-frame 1");
  assert.deepEqual([(await vars(g)).x, (await vars(g)).y], ["20", "20"]); // main sees the write through a
  await send(g, "-stack-select-frame 0");
  r = await send(g, "-exec-next");
  assert.equal(frameLine(r), 4); // *b = t;
  assert.equal(await evalExpr(g, "*b"), "10");
  await send(g, "-stack-select-frame 1");
  assert.deepEqual([(await vars(g)).x, (await vars(g)).y], ["20", "10"]);
  // display before at the same stop: *a = *b has not run
  const b = newGdb(swapRun, SWAP);
  await send(b, "-break-insert -f 3");
  await send(b, "-exec-run");
  assert.equal(await evalExpr(b, "*a"), "10");
});

test("before (default): unchanged — values before the line, output only at the end, no view field", async () => {
  const g = newGdb(run, SRC);
  const la = [];
  const outs = [];
  const pty = [];
  g.socket.on("vg_line_after", (p) => la.push(p));
  g.socket.on("vg_program_output", (p) => outs.push(p));
  g.socket.on("program_pty_response", (p) => pty.push(p));
  await send(g, "-break-insert -f 13");
  let r = await send(g, "-exec-run");
  assert.equal(frameLine(r), 13);
  assert.equal((await vars(g)).x, "1"); // x = 5 has not run
  assert.equal("view" in la.at(-1), false);
  await send(g, "-exec-continue");
  assert.deepEqual(outs, []);
  assert.deepEqual(pty, ["y=9\r\n"]);
  // explicit "before" answers byte for byte like the default
  const a = newGdb(run, SRC), b = newGdb(run, SRC, { display: "before" });
  const cmds = ["-break-insert -f 21", "-exec-run", "-stack-list-variables --all-values", "-exec-step", "-stack-list-frames", "-stack-list-arguments 1", "-exec-finish", "-stack-list-variables --all-values", "-data-evaluate-expression g"];
  for (const c of cmds) assert.deepEqual(await send(b, c), await send(a, c), c);
});

test("cell last write: display after counts the write of the stop's own line", async () => {
  const at4 = async (display) => {
    const g = newGdb(grid, GRID, display ? { display } : {});
    await send(g, "-break-insert -f 4");
    const r = await send(g, "-exec-run");
    assert.equal(frameLine(r), 4);
    return g;
  };
  const ga = await at4("after");
  const a = payloadOf(await send(ga, "-vg-cell-last-write dp 0 1"));
  assert.equal(a.line, "4"); // dp[0][1] = 5 is already shown
  assert.equal(a.how, "assignment");
  const stop4 = String(ga.session.topStep());
  assert.deepEqual(payloadOf(await send(ga, `-vg-cell-last-write dp 0 1 ${stop4}`)), a); // BEFORE = the stop the player was on
  const gb = await at4(null);
  const b = payloadOf(await send(gb, "-vg-cell-last-write dp 0 1"));
  assert.equal(b.line, "3"); // before the line: only the declaration filled it
  assert.equal(b.how, "value-change");
  // seeking to the writing step shows the written value in display "after"
  const s = await send(ga, `-vg-seek-step ${a.step}`);
  assert.equal(frameLine(s), 4);
  assert.equal(await evalExpr(ga, "dp[0][1]"), "5");
});
