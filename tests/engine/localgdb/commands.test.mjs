// LocalGdb command semantics on a REAL engine run of programs/types_recursion.cpp (recursion, reference
// parameter, nested vectors, string/double/bool/char/long long, and types outside the supported set):
// breakpoints, run/continue/next/step/finish and reverse, stack commands, variable objects, fast-forward,
// and every MI error path of these commands.
//
// Trace of the program (step index: line function):
//   0:15 main | 1:7 2:8 fact(3) | 3:7 4:8 fact(2) | 5:7 6:10 fact(1) | 7:9 8:10 fact(2) | 9:9 10:10 fact(3)
//   11:16 12:17 main | 13:12 14:13 fill | 15:18 ... 26:29 27:30 28:31 29:30 30:31 31:30 32:31 33:30 (main) 34:33 35:34 36:35
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, stopped, frameLine, newGdb } from "./helpers.mjs";
import { readTemplate, buildJumpCommand } from "./ff_template.mjs";

const SRC_FILE = path.join(ROOT, "tests", "engine", "localgdb", "programs", "types_recursion.cpp");
const source = fs.readFileSync(SRC_FILE, "utf8");
let eng, run;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(source, "");
});
after(() => eng && eng.dispose());
const fresh = (o) => newGdb(run, source, o);
const F = (it) => stopped(it).payload.frame;
const V = { vec: "std::vector<int, std::allocator<int> >", vec2: "std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > >" };

test("engine run of the fixture is as documented (trace shape the assertions below rely on)", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(run.stdout, "6 3 6\n");
  assert.deepEqual(run.steps.slice(0, 12).map((s) => `${s.line}${s.fn[0]}${s.depth}`), ["15m1", "7f2", "8f2", "7f3", "8f3", "7f4", "10f4", "9f3", "10f3", "9f2", "10f2", "16m1"]);
});

// ---- breakpoints -------------------------------------------------------------------------------

test("-break-insert: line, function, temp, disabled, condition, ignore count; bkpt fields and signatures", async () => {
  const g = fresh();
  const b1 = payloadOf(await send(g, "-break-insert -f main")).bkpt;
  assert.deepEqual([b1.number, b1.type, b1.disp, b1.enabled, b1.func, b1.line, b1.times, b1["original-location"], b1["thread-groups"]], ["1", "breakpoint", "keep", "y", "main()", "15", "0", "main", ["i1"]]);
  const b2 = payloadOf(await send(g, "-break-insert -f fact")).bkpt;
  assert.deepEqual([b2.func, b2.line], ["fact(int)", "7"]);
  const b3 = payloadOf(await send(g, "-break-insert -f fill")).bkpt;
  assert.equal(b3.func, "fill(std::vector<int, std::allocator<int> >&, int)");
  const b4 = payloadOf(await send(g, "-break-insert -t -d -c \"n == 2\" -i 3 \"/srv/x/main_real.cpp:8\"")).bkpt;
  assert.deepEqual([b4.disp, b4.enabled, b4.cond, b4.ignore, b4.line, b4["original-location"]], ["del", "n", "n == 2", "3", "8", "/srv/x/main_real.cpp:8"]);
  const b5 = payloadOf(await send(g, "-break-insert 6")).bkpt; // line without code: moves to the next line with code
  assert.equal(b5.line, "7");
  assert.equal(b5.func, "fact(int)");
  assert.deepEqual(payloadOf(await send(g, "-break-list")).BreakpointTable.body.map((b) => b.number), ["1", "2", "3", "4", "5"]);
});

test("-break-insert errors and pending breakpoints", async () => {
  const g = fresh();
  assert.match(payloadOf(await send(g, "-break-insert")).msg, /Usage/);
  assert.equal(payloadOf(await send(g, "-break-insert nosuch.cpp:3")).msg.split(" Make")[0], "No source file named nosuch.cpp.");
  assert.match(payloadOf(await send(g, "-break-insert 500")).msg, /^No line 500 in the current file\. Make breakpoint pending on future shared library load\? \(y or \[n\]\) \[answered N; input not from terminal\]$/);
  assert.match(payloadOf(await send(g, "-break-insert nosuchfn")).msg, /^Function "nosuchfn" not defined\./);
  assert.match(payloadOf(await send(g, "-break-insert *0x401000")).msg, /not supported by the browser engine/);
  const pend = payloadOf(await send(g, "-break-insert -f nosuchfn")).bkpt;
  assert.deepEqual([pend.addr, pend.pending, pend.number], ["<PENDING>", "nosuchfn", "1"]);
  assert.equal(payloadOf(await send(g, "-break-insert -f 500")).bkpt.pending, "500");
  // a pending breakpoint never stops the program
  const it = await send(g, "-exec-run");
  assert.equal(stopped(it).payload.reason, "exited-normally");
});

test("-break-delete / -enable / -disable / -condition: results, notifications, errors", async () => {
  const g = fresh();
  await send(g, ["-break-insert -f 8", "-break-insert -f 9", "-break-insert -f 12"]);
  const dis = await send(g, "-break-disable 1 2");
  assert.deepEqual(dis.map((x) => x.type === "notify" ? [x.message, x.payload.bkpt.enabled] : [x.type, x.payload]), [["breakpoint-modified", "n"], ["breakpoint-modified", "n"], ["output", "^done\r"]]);
  assert.deepEqual(payloadOf(await send(g, "-break-list")).BreakpointTable.body.map((b) => b.enabled), ["n", "n", "y"]);
  // only the enabled one (line 12, in fill) stops the run
  assert.equal(frameLine(await send(g, "-exec-run")), 12);
  await send(g, "-break-enable 1");
  const cond = await send(g, "-break-condition 1 n == 3");
  assert.equal(cond[0].payload.bkpt.cond, "n == 3");
  assert.equal((await send(g, "-break-condition 1")).find((x) => x.type === "notify").payload.bkpt.cond, undefined, "empty expression removes the condition");
  const del = await send(g, "-break-delete 3");
  assert.deepEqual(del[0], { type: "notify", message: "breakpoint-deleted", payload: { id: "3" }, token: null, stream: "stdout" });
  assert.deepEqual(payloadOf(await send(g, "-break-list")).BreakpointTable.body.map((b) => b.number), ["1", "2"]);
  assert.equal(payloadOf(await send(g, "-break-delete 99")).msg, "Bad breakpoint argument: '99'");
  assert.equal(payloadOf(await send(g, "-break-enable x")).msg, "Bad breakpoint argument: 'x'");
  assert.match(payloadOf(await send(g, "-break-delete")).msg, /Usage/);
  assert.match(payloadOf(await send(g, "-break-condition")).msg, /Usage/);
  assert.equal(payloadOf(await send(g, "-break-condition 42 x")).msg, "Bad breakpoint argument: '42'");
});

test("hit counts, temporary breakpoint deletion, condition and ignore count", async () => {
  const g = fresh();
  await send(g, ["-break-insert -f 7"]); // hit 3x: fact(3), fact(2), fact(1)
  await send(g, "-exec-run");
  await send(g, "-exec-continue");
  const third = await send(g, "-exec-continue");
  assert.equal(third.find((x) => x.message === "breakpoint-modified").payload.bkpt.times, "3");
  assert.equal(payloadOf(await send(g, "-break-list")).BreakpointTable.body[0].times, "3");
  // temporary: deleted after the stop, disp del, "Temporary breakpoint" console text
  const t = fresh();
  await send(t, "-break-insert -t 8");
  const it = await send(t, "-exec-run");
  assert.equal(stopped(it).payload.disp, "del");
  assert.match(it.find((x) => x.type === "console" && /breakpoint/.test(x.payload)).payload, /^Temporary breakpoint 1, fact \(n=3\) at \/srv\/x\/main_real\.cpp:8\n$/);
  assert.ok(it.some((x) => x.message === "breakpoint-deleted"));
  assert.equal(payloadOf(await send(t, "-break-list")).BreakpointTable.body.length, 0);
  // condition: stops only where true (fact(2) executes line 8 with n == 2)
  const c = fresh();
  await send(c, "-break-insert -f -c \"n == 2\" 8");
  const ci = await send(c, "-exec-run");
  assert.deepEqual([frameLine(ci), F(ci).args], [8, [{ name: "n", value: "2" }]]);
  assert.equal(payloadOf(await send(c, "-break-list")).BreakpointTable.body[0].times, "1");
  // ignore count: the first 2 hits of line 7 are skipped -> stops in fact(1); times counts all three
  const ig = fresh();
  await send(ig, "-break-insert -f -i 2 7");
  const ii = await send(ig, "-exec-run");
  assert.deepEqual(F(ii).args, [{ name: "n", value: "1" }]);
  assert.equal(payloadOf(await send(ig, "-break-list")).BreakpointTable.body[0].times, "3");
});

// ---- execution control ---------------------------------------------------------------------------

test("-exec-run without breakpoints runs to the end: exit items in golden order, then the program output", async () => {
  const g = fresh();
  const outs = [];
  g.socket.on("program_pty_response", (p) => outs.push(p));
  const it = await send(g, "-exec-run");
  assert.deepEqual(it.map((x) => `${x.type}/${x.message}`), ["notify/thread-group-started", "notify/thread-created", "output/null", "notify/running", "console/null", "notify/thread-exited", "notify/thread-group-exited", "notify/stopped"]);
  assert.equal(it[4].payload, "[Inferior 1 (process 4242) exited normally]\n");
  assert.deepEqual(stopped(it).payload, { reason: "exited-normally" });
  assert.deepEqual(outs, ["6 3 6\r\n"]);
});

test("run / continue stop at breakpoints with the golden console text; continue after the last one ends the program", async () => {
  const g = fresh();
  await send(g, ["-break-insert -f 16", "-break-insert -f 33"]);
  const r = await send(g, "-exec-run");
  assert.deepEqual(r.filter((x) => x.type === "console").map((x) => x.payload), ["\n", "Breakpoint 1, main () at /srv/x/main_real.cpp:16\n", "16\tin /srv/x/main_real.cpp\n"]);
  assert.equal(frameLine(await send(g, "-exec-continue")), 33);
  assert.equal(stopped(await send(g, "-exec-continue")).payload.reason, "exited-normally");
});

test("next steps over calls; step enters user functions; a breakpoint inside a stepped-over call stops there", async () => {
  const g = fresh();
  await send(g, "-break-insert -f main");
  await send(g, "-exec-run");
  const n = await send(g, "-exec-next");
  assert.deepEqual([frameLine(n), F(n).func, stopped(n).payload.reason], [16, "main", "end-stepping-range"]);
  const g2 = fresh();
  await send(g2, "-break-insert -f main");
  await send(g2, "-exec-run");
  const s = await send(g2, "-exec-step");
  assert.deepEqual([frameLine(s), F(s).func, F(s).args], [7, "fact", [{ name: "n", value: "3" }]]);
  assert.equal(payloadOf(await send(g2, "1-stack-list-frames")).stack.length, 2);
  const g3 = fresh();
  await send(g3, ["-break-insert -f main", "-break-insert -f 7"]);
  await send(g3, "-exec-run");
  const b = await send(g3, "-exec-next");
  assert.deepEqual([stopped(b).payload.reason, stopped(b).payload.bkptno, F(b).func, frameLine(b)], ["breakpoint-hit", "2", "fact", 7]);
});

test("stepping onto a breakpoint line reports breakpoint-hit (GDB behaviour)", async () => {
  const g = fresh();
  await send(g, ["-break-insert -f 15", "-break-insert -f 16"]);
  await send(g, "-exec-run");
  const n = await send(g, "-exec-next");
  assert.deepEqual([stopped(n).payload.reason, stopped(n).payload.bkptno], ["breakpoint-hit", "2"]);
});

test("returning from a function by next/step does NOT stop on the caller's call line: the statement is finished and the NEXT line is reported (GDB 16.3 reference)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 10");
  const hit = await send(g, "-exec-run"); // fact(1) `}`
  assert.deepEqual([frameLine(hit), F(hit).args], [10, [{ name: "n", value: "1" }]]);
  const back = await send(g, "-exec-next");
  assert.deepEqual([stopped(back).payload.reason, frameLine(back), F(back).func, F(back).args], ["end-stepping-range", 9, "fact", [{ name: "n", value: "2" }]]);
  assert.equal(payloadOf(await send(g, "1-stack-list-frames")).stack.length, 3, "the caller's frame is now frame 0");
  // step out of `}` the same way
  const g2 = fresh();
  await send(g2, "-break-insert -f 10");
  await send(g2, "-exec-run");
  const st = await send(g2, "-exec-step");
  assert.deepEqual([frameLine(st), F(st).args[0].value], [9, "2"]);
});

test("-exec-finish: function-finished at the call line; breakpoints inside are honoured; outermost frame error", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 8");
  const a = await send(g, "-exec-run"); // fact(3) line 8
  assert.deepEqual(F(a).args, [{ name: "n", value: "3" }]);
  const b = await send(g, "-exec-finish"); // fact(2) executes line 8 before fact(3) returns
  assert.deepEqual([stopped(b).payload.reason, F(b).args], ["breakpoint-hit", [{ name: "n", value: "2" }]]);
  await send(g, "-break-disable 1");
  const c = await send(g, "-exec-finish");
  assert.equal(c[0].payload, "Run till exit from #0  fact (n=2) at /srv/x/main_real.cpp:8\n");
  assert.deepEqual([stopped(c).payload.reason, frameLine(c), F(c).func, F(c).args], ["function-finished", 8, "fact", [{ name: "n", value: "3" }]]);
  const d = await send(g, "-exec-finish");
  assert.deepEqual([stopped(d).payload.reason, F(d).func, frameLine(d)], ["function-finished", "main", 15]);
  assert.deepEqual(payloadOf(await send(g, "-exec-finish")), { msg: '"finish" not meaningful in the outermost frame.' });
  // ... and the program continues from there (the callee is not re-entered)
  const nx = await send(g, "-exec-next");
  assert.equal(frameLine(nx), 16);
});

test("-exec-finish finishes the SELECTED frame", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 10");
  await send(g, "-exec-run"); // fact(1): frames fact(1), fact(2), fact(3), main
  await send(g, "-break-disable 1");
  await send(g, "-stack-select-frame 2"); // fact(3)
  const it = await send(g, "-exec-finish");
  assert.equal(it[0].payload, "Run till exit from #2  fact (n=3) at /srv/x/main_real.cpp:8\n");
  assert.deepEqual([stopped(it).payload.reason, F(it).func, frameLine(it)], ["function-finished", "main", 15]);
});

test("reverse execution: next/step/continue/finish backwards, no-history at the start, forward again afterwards", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 22");
  assert.equal(frameLine(await send(g, "-exec-run")), 22);
  assert.equal(frameLine(await send(g, "-exec-next --reverse")), 21);
  assert.equal(frameLine(await send(g, "-exec-step --reverse")), 20);
  // reverse-step into a callee: from line 18 the previous step is fill's last step
  const g2 = fresh();
  await send(g2, "-break-insert -f 18");
  await send(g2, "-exec-run");
  const rs = await send(g2, "-exec-step --reverse");
  assert.deepEqual([F(rs).func, frameLine(rs)], ["fill", 13]);
  assert.equal(payloadOf(await send(g2, "1-stack-list-frames")).stack.length, 2);
  const rf = await send(g2, "-exec-finish --reverse");
  assert.deepEqual([F(rf).func, frameLine(rf), stopped(rf).payload.reason], ["main", 17, "end-stepping-range"]);
  assert.match(rf[0].payload, /^Run back to call of #0  fill \(v=\.\.\., n=3\) at /);
  // reverse-next steps over the callee: from 18 to 17, not into fill
  const g3 = fresh();
  await send(g3, "-break-insert -f 18");
  await send(g3, "-exec-run");
  const rn = await send(g3, "-exec-next --reverse");
  assert.deepEqual([F(rn).func, frameLine(rn)], ["main", 17]);
  // reverse-continue: breakpoint behind us, then no more history
  const g4 = fresh();
  await send(g4, ["-break-insert -f 20", "-break-insert -f 26"]);
  await send(g4, "-exec-run");
  await send(g4, "-exec-continue");
  const rc = await send(g4, "-exec-continue --reverse");
  assert.deepEqual([stopped(rc).payload.reason, frameLine(rc)], ["breakpoint-hit", 20]);
  const nh = await send(g4, "-exec-continue --reverse");
  assert.equal(stopped(nh).payload.reason, "no-history");
  assert.equal(frameLine(nh), 15);
  assert.ok(nh.some((x) => x.type === "console" && /No more reverse-execution history/.test(x.payload)));
  assert.equal(stopped(await send(g4, "-exec-next --reverse")).payload.reason, "no-history");
  // going forward again from the start: next steps over fact()
  assert.equal(frameLine(await send(g4, "-exec-next")), 16);
  assert.deepEqual(payloadOf(await send(fresh(), "-exec-next --reverse")), { msg: "The program is not being run." });
});

test("exec commands after the program ended: not being run; -exec-run restarts", async () => {
  const g = fresh();
  await send(g, "-exec-run");
  for (const c of ["-exec-continue", "-exec-next", "-exec-step", "-exec-finish"]) assert.deepEqual(payloadOf(await send(g, c)), { msg: "The program is not being run." }, c);
  await send(g, "-break-insert -f 17");
  assert.equal(frameLine(await send(g, "-exec-run")), 17);
});

// ---- stack commands ------------------------------------------------------------------------------

test("-stack-list-frames / -arguments / -variables / -select-frame / -thread-info in a recursive call", async () => {
  const g = fresh();
  await send(g, "-break-insert -f -c \"n == 1\" 7");
  await send(g, "-exec-run");
  const fr = payloadOf(await send(g, "3-stack-list-frames"));
  assert.deepEqual(fr.stack.map((f) => [f.level, f.func, f.line]), [["0", "fact", "7"], ["1", "fact", "8"], ["2", "fact", "8"], ["3", "main", "15"]]);
  assert.equal(new Set(fr.stack.map((f) => f.addr)).size, 3, "same call site -> same address, other sites differ");
  assert.equal(fr.stack[1].addr, fr.stack[2].addr);
  assert.deepEqual(payloadOf(await send(g, "-stack-list-frames 1 2")).stack.map((f) => f.level), ["1", "2"]);
  const args = payloadOf(await send(g, "-stack-list-arguments 1"))["stack-args"];
  assert.deepEqual(args.map((a) => a.args.map((x) => x.value)), [["1"], ["2"], ["3"], []]);
  assert.deepEqual(payloadOf(await send(g, "-stack-list-arguments 0"))["stack-args"][0].args, [{ name: "n" }]);
  assert.deepEqual(payloadOf(await send(g, "-stack-list-variables --simple-values")).variables, [{ name: "n", arg: "1", type: "int", value: "1" }, { name: "r", type: "int", value: "0" }]);
  await send(g, "-stack-select-frame 2");
  assert.deepEqual(payloadOf(await send(g, "-stack-list-variables --all-values")).variables.map((v) => [v.name, v.value]), [["n", "3"], ["r", "0"]]);
  assert.deepEqual(payloadOf(await send(g, "-stack-select-frame 9")), { msg: "Invalid frame level: 9" });
  const ti = payloadOf(await send(g, "-thread-info"));
  assert.equal(ti["current-thread-id"], "1");
  assert.deepEqual([ti.threads[0].state, ti.threads[0].frame.func, ti.threads[0].frame.level], ["stopped", "fact", "0"]);
  assert.match(ti.threads[0]["target-id"], /^Thread 0x[0-9a-f]+ \(LWP \d+\)$/);
  assert.equal(payloadOf(await send(g, "-thread-select 1"))["new-thread-id"], "1");
  assert.match(payloadOf(await send(g, "-thread-select 7")).msg, /Invalid thread id/);
  // a stop resets the selected frame to 0
  await send(g, "-exec-next");
  assert.equal(payloadOf(await send(g, "-stack-list-variables --simple-values")).variables[0].value, "1");
});

test("locals follow GDB's block rules: innermost block first, later declarations listed, shadowing, reference arguments", async () => {
  const g = fresh();
  await send(g, ["-break-insert -f 31", "-break-insert -f 12"]);
  await send(g, "-exec-run"); // fill line 12 first
  const fill = payloadOf(await send(g, "-stack-list-variables --simple-values")).variables;
  assert.deepEqual(fill.map((v) => v.name + (v.arg ? "(arg)" : "")), ["i", "v(arg)", "n(arg)"], "for-variable first (block of the for), then parameters");
  assert.deepEqual(fill.find((v) => v.name === "v"), { name: "v", arg: "1", type: `${V.vec} &` });
  const all = payloadOf(await send(g, "-stack-list-variables --all-values")).variables.find((v) => v.name === "v");
  assert.match(all.value, /^@0x[0-9a-f]+: std::vector of length 0, capacity 0$/);
  assert.equal(payloadOf(await send(g, "-stack-list-arguments 1"))["stack-args"][0].args[0].value.startsWith("@0x"), true);
  await send(g, "-exec-continue"); // main line 31 (inside the loop)
  const main = payloadOf(await send(g, "-stack-list-variables --simple-values")).variables;
  assert.deepEqual(main.map((v) => v.name), ["i", "x", "v", "g", "s", "d", "b", "c", "big", "m", "arr", "p", "pt", "y"], "i (for block) first; every main-level local incl. the ones declared later");
  const by = Object.fromEntries(main.map((v) => [v.name, v]));
  assert.deepEqual([by.x.value, by.d.value, by.b.value, by.c.value, by.big.value, by.y.value, by.i.value], ["6", "0.10000000000000001", "true", "97 'a'", "1234567890123", "0", "0"]);
  assert.equal("value" in by.v, false, "vector: no value with --simple-values");
  assert.equal("value" in by.s, false, "std::string is a class: no value with --simple-values");
  assert.equal("value" in by.arr, false);
  assert.deepEqual([by.arr.type, by.p.type, by.pt.type, by.m.type, by.s.type, by.g.type], ["int [3]", "int *", "Pt", "std::pair<int, int>", "std::string", V.vec2]);
  assert.equal("value" in by.p, true, "pointers are simple values");
});

// ---- variable objects ----------------------------------------------------------------------------

test("-var-create: supported types with GDB's type strings, value strings and dynamic fields", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  const mk = async (e) => payloadOf(await send(g, `3-var-create - * "${e}"`));
  assert.deepEqual(await mk("x"), { name: "var1", numchild: "0", value: "6", type: "int", "thread-id": "1", has_more: "0" });
  assert.deepEqual(await mk("v"), { name: "var2", numchild: "0", value: "std::vector of length 3, capacity 4", type: V.vec, "thread-id": "1", displayhint: "array", dynamic: "1", has_more: "1" });
  assert.deepEqual(await mk("g"), { name: "var3", numchild: "0", value: "std::vector of length 2, capacity 2", type: V.vec2, "thread-id": "1", displayhint: "array", dynamic: "1", has_more: "1" });
  assert.deepEqual(await mk("s"), { name: "var4", numchild: "0", value: "\"hi\"", type: "std::string", "thread-id": "1", displayhint: "string", dynamic: "1", has_more: "0" });
  assert.deepEqual((await mk("d")).value, "0.10000000000000001");
  assert.deepEqual([(await mk("b")).value, (await mk("c")).value, (await mk("big")).value, (await mk("y")).type], ["true", "97 'a'", "1234567890123", "int"]);
  // std::pair as a bare (non-container-element) type — a leaf, no displayhint/dynamic (unlike
  // vector/map/etc.): its numchild="0" comes from having no children listed, not from pretty-printing.
  assert.deepEqual(await mk("m"), { name: "var10", numchild: "0", value: "{first = 2, second = 0}", type: "std::pair<int, int>", "thread-id": "1", has_more: "0" });
  // command with explicit name and thread/frame flags
  const named = payloadOf(await send(g, "-var-create myvar * x"));
  assert.equal(named.name, "myvar");
  assert.equal(payloadOf(await send(g, "-var-create myvar * x")).msg, "Duplicate variable object name");
  assert.equal(payloadOf(await send(g, "-var-info-type myvar")).type, "int");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression myvar")).value, "6");
});

test("-var-create: unsupported types and expressions get an explicit MI error; GDB's own errors are reproduced; the counter advances on failures", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  const err = async (e) => { const it = await send(g, `3-var-create - * "${e}"`); const r = it.find((x) => x.type === "result"); assert.equal(r.message, "error", e); assert.equal(r.token, 3); return r.payload.msg; };
  // "pt" (struct Pt { int a; int b; };) used to be unsupported here too — class support (Slice C)
  // now creates a proper varobj for a plain data struct; see class_support.test.mjs. "m" (a bare
  // std::pair<int,int>, not inside a container) used to be unsupported too — see the "supported
  // types" test above for its var-create now that pair-as-an-element-type is supported.
  for (const [e, ty] of [["p", "int \\*"]]) assert.match(await err(e), new RegExp(`^type '${ty}.*' is not supported by the browser engine$`), e);
  assert.match(await err("*p"), /^expression '\*p' is not supported|^operator '\*' in expression '\*p' is not supported by the browser engine$/);
  assert.match(await err("g[0]"), /^expression 'g\[0\]' \(its value is a container\) is not supported by the browser engine$/);
  assert.equal(await err("x +"), "A syntax error in expression, near `'.");
  assert.equal(await err("x / 0"), "Division by zero");
  assert.match(await err("&(m)"), /^type 'std::pair.*\*' is not supported by the browser engine$/);
  assert.equal(await err("v.capacity()"), "Cannot evaluate function -- may be inlined");
  assert.equal(await err("v.size()"), "Cannot evaluate function -- may be inlined");
  assert.equal(await err("nosuch"), 'No symbol "nosuch" in current context.');
  assert.equal(payloadOf(await send(g, "-var-create - * \"x\"")).name, "var10", "9 failed creates each consumed a varN (like GDB)");
  // unsupported names for the other varobj commands
  assert.equal(payloadOf(await send(g, "-var-list-children --all-values \"var1\"")).msg, "Variable object not found");
  assert.equal(payloadOf(await send(g, "-var-delete var1")).msg, "Variable object not found");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression nope")).msg, "Variable object not found");
  assert.equal(payloadOf(await send(g, "-var-info-type nope")).msg, "Variable object not found");
  assert.equal(payloadOf(await send(g, "-var-update --all-values nope")).msg, "Variable object not found");
  assert.match(payloadOf(await send(g, "-var-create")).msg, /Usage/);
  assert.match(payloadOf(await send(g, "-var-list-children")).msg, /Usage/);
});

test("-var-list-children: nested vectors, numchild after expansion, ranges, value flags; scalars and strings have no children", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  await send(g, "3-var-create - * \"g\"");
  const top = payloadOf(await send(g, "-var-list-children --all-values \"var1\""));
  assert.deepEqual(Object.keys(top), ["numchild", "displayhint", "children", "has_more"]);
  assert.deepEqual([top.numchild, top.displayhint, top.has_more], ["2", "array", "0"]);
  assert.deepEqual(top.children[0], { name: "var1.[0]", exp: "[0]", numchild: "0", value: "std::vector of length 2, capacity 2", type: V.vec, "thread-id": "1", displayhint: "array", dynamic: "1" });
  const kids = payloadOf(await send(g, "-var-list-children --all-values \"var1.[1]\""));
  assert.deepEqual(kids.children.map((c) => [c.name, c.exp, c.value, c.type, c.numchild]), [["var1.[1].[0]", "[0]", "7", "int", "0"], ["var1.[1].[1]", "[1]", "7", "int", "0"]]);
  assert.deepEqual(Object.keys(kids.children[0]), ["name", "exp", "numchild", "value", "type", "thread-id"]);
  assert.equal(payloadOf(await send(g, "-var-list-children --all-values \"var1\"")).children[1].numchild, "2", "numchild is the real count once the children were listed");
  assert.equal(payloadOf(await send(g, "-var-list-children --no-values \"var1\"")).children[0].value, undefined);
  assert.equal(payloadOf(await send(g, "-var-list-children --simple-values \"var1\"")).children[0].value, undefined, "vectors are not simple");
  assert.equal(payloadOf(await send(g, "-var-list-children --simple-values \"var1.[1]\"")).children[0].value, "7");
  assert.deepEqual(payloadOf(await send(g, "-var-list-children --all-values var1 1 2")).children.map((c) => c.name), ["var1.[1]"]);
  await send(g, ["3-var-create - * \"s\"", "3-var-create - * \"x\""]);
  assert.deepEqual(payloadOf(await send(g, "-var-list-children --all-values var2")), { numchild: "0", has_more: "0" });
  assert.deepEqual(payloadOf(await send(g, "-var-list-children --all-values var3")), { numchild: "0", has_more: "0" });
  // -var-delete counts the instantiated descendants; -c deletes only children
  assert.deepEqual(payloadOf(await send(g, "-var-delete -c var1")), { ndeleted: "4" }, "var1.[0], var1.[1] and the two listed grandchildren");
  assert.deepEqual(payloadOf(await send(g, "-var-delete var1")), { ndeleted: "1" });
  assert.deepEqual(payloadOf(await send(g, "-var-delete var3")), { ndeleted: "1" });
});

test("-var-update: value changes, in_scope false when the block is left (once), value again when re-entered; roots newest first", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 31");
  await send(g, "-exec-run"); // line 31 first visit: i == 0, y == 0
  await send(g, "3-var-create - * \"y\"");
  await send(g, "3-var-create - * \"i\"");
  await send(g, "3-var-create - * \"v\"");
  await send(g, "-var-list-children --all-values var3");
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")), { changelist: [] });
  await send(g, "-exec-next"); // line 30 (y += i ran: y stays 0, i is still 0)
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")), { changelist: [] });
  await send(g, "-exec-next"); // line 31, i == 1
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [{ name: "var2", value: "1", in_scope: "true", type_changed: "false", has_more: "0" }]);
  await send(g, "-exec-next"); await send(g, "-exec-next"); // line 30 (y == 1), line 31 (i == 2)
  const u2 = payloadOf(await send(g, "1-var-update --all-values *")).changelist;
  assert.deepEqual(u2.map((c) => [c.name, c.value]), [["var2", "2"], ["var1", "1"]], "newest root first");
  // leave the loop (line 30 with y == 3, then 33, then 34): i's block ends -> in_scope false, reported once; y keeps updating
  for (let i = 0; i < 3; i++) await send(g, "-exec-next");
  const u3 = payloadOf(await send(g, "1-var-update --all-values *")).changelist;
  assert.deepEqual(u3.map((c) => [c.name, c.in_scope, c.value]), [["var2", "false", undefined], ["var1", "true", "3"]]);
  assert.deepEqual(Object.keys(u3[0]), ["name", "in_scope", "type_changed", "has_more"]);
  await send(g, "-exec-next");
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [], "an out-of-scope varobj is not reported again");
  // reverse into the loop again: re-entering the block reports the value; --no-values omits it
  for (let i = 0; i < 3; i++) await send(g, "-exec-next --reverse"); // back to lines 34, 33, 30 -> line 30 again: inside i's block
  const back = payloadOf(await send(g, "1-var-update --no-values *")).changelist;
  assert.deepEqual(back, [{ name: "var2", in_scope: "true", type_changed: "false", has_more: "0" }]);
});

test("varobj scope across frames: a recursive frame's varobj stays valid in callees; a returned frame's varobj goes out of scope", async () => {
  const g = fresh();
  await send(g, "-break-insert -f -c \"n == 2\" 7");
  await send(g, "-exec-run"); // fact(2) line 7
  await send(g, "3-var-create - * \"n\"");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression var1")).value, "2");
  await send(g, "-exec-next"); // line 8
  await send(g, "-exec-step"); // into fact(1), line 7: n of fact(2) is now frame 1 of the stack
  assert.equal(payloadOf(await send(g, "1-stack-list-frames")).stack.length, 4, "fact(1), fact(2), fact(3), main");
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [], "still in scope, unchanged (the value is read from the caller's frame)");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression var1")).value, "2");
  // a varobj of the callee's frame
  await send(g, "3-var-create - * \"n\"");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression var2")).value, "1");
  await send(g, "-exec-next"); // fact(1) line 10 (n == 1)
  await send(g, "-exec-next"); // returns: fact(2) call line 8
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [{ name: "var2", in_scope: "false", type_changed: "false", has_more: "0" }]);
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression var1")).value, "2");
  // finish out of fact(2): its varobj dies too
  await send(g, "-break-disable 1");
  await send(g, "-exec-finish");
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [{ name: "var1", in_scope: "false", type_changed: "false", has_more: "0" }]);
  // a varobj created after -stack-select-frame binds to the selected frame
  const h = fresh();
  await send(h, "-break-insert -f -c \"n == 1\" 7");
  await send(h, "-exec-run");
  await send(h, "-stack-select-frame 2");
  await send(h, "3-var-create - * \"n\"");
  assert.equal(payloadOf(await send(h, "-var-evaluate-expression var1")).value, "3");
});

test("vector varobj: growth is reported with new_num_children; the children show the new elements (reference parameter)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 12");
  await send(g, "-exec-run"); // fill line 12: v (reference parameter) is still empty
  const c = payloadOf(await send(g, "3-var-create - * \"v\""));
  assert.equal(c.type, `${V.vec} &`);
  assert.match(c.value, /^@0x[0-9a-f]+: std::vector of length 0, capacity 0$/);
  assert.equal(payloadOf(await send(g, "-var-list-children --all-values var1")).numchild, "0");
  await send(g, "-exec-next"); // fill's `}` line: 3 elements
  const upd = payloadOf(await send(g, "1-var-update --all-values *")).changelist;
  assert.equal(upd.length, 1);
  assert.match(upd[0].value, /^@0x[0-9a-f]+: std::vector of length 3, capacity 4$/);
  assert.deepEqual([upd[0].name, upd[0].in_scope, upd[0].displayhint, upd[0].dynamic, upd[0].new_num_children], ["var1", "true", "array", "1", "3"]);
  const kids = payloadOf(await send(g, "-var-list-children --all-values var1")).children.map((c) => c.value);
  assert.deepEqual(kids, ["0", "1", "4"]);
});

test("-data-evaluate-expression: plain variables only; errors like -var-create", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  const ev = async (e) => payloadOf(await send(g, `-data-evaluate-expression "${e}"`));
  assert.deepEqual(await ev("x"), { value: "6" });
  assert.deepEqual(await ev("v"), { value: "std::vector of length 3, capacity 4 = {0, 1, 4}" }, "print format: the pretty-printer children are included");
  assert.deepEqual(await ev("arr"), { value: "{1, 2, 3}" });
  assert.deepEqual(await ev("g"), { value: "std::vector of length 2, capacity 2 = {std::vector of length 2, capacity 2 = {7, 7}, std::vector of length 2, capacity 2 = {7, 7}}" });
  assert.deepEqual(await ev("s"), { value: "\"hi\"" });
  assert.deepEqual(await ev("c"), { value: "97 'a'" });
  assert.deepEqual(await ev("INF"), { msg: 'No symbol "INF" in current context.' });
  assert.deepEqual(await ev("x * 2"), { value: "12" });
  assert.deepEqual(await ev("m"), { value: "{first = 2, second = 0}" });
  assert.equal((await ev("v.size()")).msg, "Cannot evaluate function -- may be inlined");
  assert.equal((await ev("nosuch")).msg, 'No symbol "nosuch" in current context.');
});

// ---- fast-forward -------------------------------------------------------------------------------

/** blob of a fast-forward response */
function blobOf(items) {
  const c = items.find((x) => x.type === "console" && x.payload.startsWith("@@FF@@"));
  assert.ok(c, "no @@FF@@ console item");
  assert.ok(c.payload.endsWith("@@/FF@@\n"));
  return { text: c.payload, blob: JSON.parse(c.payload.slice(6, c.payload.indexOf("@@/FF@@"))) };
}

test("[fast @N]: python exec is recognised, simulated on the trace, blob + echo + per-next items in golden order", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 30");
  await send(g, "-exec-run"); // line 30 (first visit)
  const cmd = buildJumpCommand(31, 2);
  const it = await send(g, [cmd, "1-thread-info", "1-stack-list-frames"]);
  // command echo first (log, with the marker), then ^running once, then running/console/stopped per `next`
  assert.deepEqual(it[0], { type: "log", message: null, payload: cmd + "\n", stream: "stdout" });
  assert.deepEqual(it.slice(1, 5).map((x) => `${x.type}/${x.message || x.payload}`), ["output/^running\r", "notify/running", "console/31\tin /srv/x/main_real.cpp\n", "notify/stopped"]);
  const { text, blob } = blobOf(it);
  assert.deepEqual(blob.stacks.map((s) => s[0].line), [31, 30, 31]);
  assert.deepEqual([blob.landed, blob.steps], [true, 3]);
  assert.equal(text.indexOf('"counts": {"31": 2, "30": 1}') > 0, true, "counts keep Python insertion order and separators");
  assert.deepEqual(Object.keys(blob.stacks[0][0]), ["func", "addr", "line", "fullname", "args"]);
  assert.deepEqual([blob.stacks[0][0].func, blob.stacks[0][0].fullname, blob.stacks[0][0].args], ["main", "/workspace/main.cpp", []]);
  assert.match(blob.stacks[0][0].addr, /^0x[0-9a-f]+$/);
  // 3 internal nexts -> 3 stopped notifications, 2 running without ^running
  assert.equal(it.filter((x) => x.message === "stopped").length, 3);
  assert.equal(it.filter((x) => x.type === "output").length, 1);
  // the following refresh commands see the landing stop
  assert.equal(payloadOf(it, 0).threads[0].frame.line, "31");
  assert.equal(payloadOf(it, 1).stack[0].line, "31");
  // and the UI-side state continues from there
  assert.equal(frameLine(await send(g, "-exec-next")), 30);
});

test("[fast @N]: program exits before the target -> landed false, exit items, program output after the packet", async () => {
  const g = fresh();
  const outs = [];
  g.socket.on("program_pty_response", (p) => outs.push(p));
  await send(g, "-break-insert -f 30");
  await send(g, "-exec-run");
  const it = await send(g, buildJumpCommand(999, 1));
  const { blob } = blobOf(it);
  assert.deepEqual([blob.landed, blob.steps, blob.stacks.length], [false, 10, 9], "9 stops (31,30,31,30,31,30,33,34,35) + the next that exits (counted, no stack)");
  assert.deepEqual(blob.stacks.map((s) => s[0].line), [31, 30, 31, 30, 31, 30, 33, 34, 35]);
  assert.ok(it.some((x) => x.message === "stopped" && x.payload.reason === "exited-normally"));
  assert.deepEqual(outs, ["6 3 6\r\n"]);
  assert.deepEqual(payloadOf(await send(g, "-exec-next")), { msg: "The program is not being run." });
});

test("[fast @N]: step limit, missing program, non-template python", async () => {
  const g = fresh();
  const notRunning = await send(g, buildJumpCommand(31, 1));
  assert.equal(notRunning[0].type, "log");
  assert.equal(notRunning[1].message, "error");
  assert.equal(notRunning[1].payload.msg, "Error while executing Python code.");
  await send(g, "-break-insert -f 30");
  await send(g, "-exec-run");
  const lim = blobOf(await send(g, buildJumpCommand(999, 1, 2))).blob;
  assert.deepEqual([lim.landed, lim.steps, lim.stacks.length], [false, 2, 2], "limit reached: steps == limit, landed false");
  assert.match(payloadOf(await send(g, "python print(1)")).msg, /not supported by the browser engine/);
});

test("[fast @N] in a recursive stack: whole stack per stop, args only while the pc is in the function's own block (gdb.Frame.block())", async () => {
  const g = fresh();
  await send(g, "-break-insert -f -c \"n == 1\" 7");
  await send(g, "-exec-run"); // fact(1) line 7
  const one = blobOf(await send(g, buildJumpCommand(10, 1))).blob;
  assert.deepEqual(one.stacks.length, 1);
  const st = one.stacks[0];
  assert.deepEqual(st.map((f) => [f.func, f.line, f.args.map((a) => a.value)]), [["fact", 10, ["1"]], ["fact", 8, ["2"]], ["fact", 8, ["3"]], ["main", 15, []]]);
  assert.deepEqual(Object.keys(st[0].args[0]), ["name", "value"]);
  // inside fill: `step` from main line 17 enters fill at line 12 (the for line: innermost block is the `for`, not the function block)
  const h = fresh();
  await send(h, "-break-insert -f 17");
  await send(h, "-exec-run");
  await send(h, "-exec-step");
  const b = blobOf(await send(h, buildJumpCommand(13, 1))).blob;
  assert.deepEqual(b.stacks[0].map((f) => [f.func, f.line, f.args.length]), [["fill", 13, 2], ["main", 17, 0]], "at the `}` line the pc is in the function block: args listed");
  const h2 = fresh();
  await send(h2, "-break-insert -f 17");
  await send(h2, "-exec-run");
  await send(h2, "-exec-step");
  assert.equal(payloadOf(await send(h2, "-stack-list-arguments 1"))["stack-args"][0].args.length, 2, "-stack-list-arguments lists them regardless");
});

// ---- integer / arithmetic expressions and &(name) (F2) -------------------------------------------

test("-var-create of arithmetic expressions: C++ types and GDB's value spelling (int wrap, truncating division, bool, double, char, long long, subscripts)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run"); // x = 6, y = 3, d = 0.1, b = true, c = 'a', big = 1234567890123, v = [0,1,4], g = [[7,7],[7,7]], s = "hi"
  const mk = async (e) => payloadOf(await send(g, `3-var-create - * "${e}"`));
  const first = await mk("x + 1");
  assert.deepEqual(first, { name: "var1", numchild: "0", value: "7", type: "int", "thread-id": "1", has_more: "0" });
  const tv = async (e) => { const r = await mk(e); return [r.value, r.type]; };
  assert.deepEqual(await tv("x - 10"), ["-4", "int"]);
  assert.deepEqual(await tv("x / 4"), ["1", "int"]);
  assert.deepEqual(await tv("-x / 4"), ["-1", "int"]);
  assert.deepEqual(await tv("x % 4"), ["2", "int"]);
  assert.deepEqual(await tv("(x + 2) * 3"), ["24", "int"]);
  assert.deepEqual(await tv("x * 1000000000"), ["1705032704", "int"], "32-bit wrap-around");
  assert.deepEqual(await tv("2147483647 + 1"), ["-2147483648", "int"]);
  assert.deepEqual(await tv("x > 3"), ["true", "bool"]);
  assert.deepEqual(await tv("x == 7 || b"), ["true", "bool"]);
  assert.deepEqual(await tv("x < 3 && y"), ["false", "bool"]);
  assert.deepEqual(await tv("!b"), ["false", "bool"]);
  assert.deepEqual(await tv("b + b"), ["2", "int"]);
  assert.deepEqual(await tv("c + 1"), ["98", "int"]);
  assert.deepEqual(await tv("d * 2"), ["0.20000000000000001", "double"]);
  assert.deepEqual(await tv("x / 4.0"), ["1.5", "double"]);
  assert.deepEqual(await tv("big * 2"), ["2469135780246", "long long"]);
  assert.deepEqual(await tv("big + x"), ["1234567890129", "long long"]);
  assert.deepEqual(await tv("x ? 10 : 20"), ["10", "int"]);
  assert.deepEqual(await tv("g[1][0] + 1"), ["8", "int"]);
  assert.deepEqual(await tv("v[y - 1]"), ["4", "int"]);
  assert.deepEqual(await tv("s[0]"), ["104 'h'", "char"]);
  const konst = await mk("1 + 2");
  assert.deepEqual([konst.value, konst.type, "thread-id" in konst], ["3", "int", false], "no variable: no thread-id (GDB: no valid block)");
  // errors: GDB texts
  const err = async (e) => { const it = await send(g, `3-var-create - * "${e}"`); const r = it.find((x) => x.type === "result"); assert.equal(r.message, "error"); return r.payload.msg; };
  assert.equal(await err("x / 0"), "Division by zero");
  assert.equal(await err("x % 0"), "Division by zero");
  assert.equal(await err("v[10]"), "Cannot access memory at address 0x0");
  assert.equal(await err("x + zz"), 'No symbol "zz" in current context.');
  assert.equal(await err("v.size() + 1"), "Cannot evaluate function -- may be inlined");
  assert.equal(await err("x +"), "A syntax error in expression, near `'.");
  assert.match(await err("x )"), /^A syntax error in expression, near `\)'\.$/);
  assert.match(await err("*p"), /is not supported by the browser engine$/);
  assert.match(await err("f(x)"), /is not supported by the browser engine$/);
  assert.match(await err("x -> y"), /is not supported by the browser engine$/);
  assert.match(await err("g[0]"), /container\) is not supported by the browser engine$/);
});

test("-data-evaluate-expression evaluates the same expressions (value only)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  const ev = async (e) => payloadOf(await send(g, `-data-evaluate-expression "${e}"`));
  assert.deepEqual(await ev("x + 1"), { value: "7" });
  assert.deepEqual(await ev("x > 3"), { value: "true" });
  assert.deepEqual(await ev("v[1] + v[2]"), { value: "5" });
  assert.deepEqual(await ev("x / 0"), { msg: "Division by zero" });
  assert.match((await ev("&(x)")).value, /^\(int \*\) 0x7ffe[0-9a-f]+$/);
  assert.match((await ev("&v")).value, /^\(std::vector<int, std::allocator<int> > \*\) 0x7ffe[0-9a-f]+$/);
});

test("expression varobjs update like GDB's: value changes, out of scope with the block of the variables they use", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 31");
  await send(g, "-exec-run"); // i == 0, y == 0
  await send(g, "3-var-create - * \"y + i\"");   // var1: block of i (the for block)
  await send(g, "3-var-create - * \"x - 1\"");   // var2: main's function block
  await send(g, "-exec-next"); await send(g, "-exec-next"); // line 31 again: i == 1
  assert.deepEqual(payloadOf(await send(g, "1-var-update --all-values *")).changelist, [{ name: "var1", value: "1", in_scope: "true", type_changed: "false", has_more: "0" }]);
  for (let k = 0; k < 6; k++) await send(g, "-exec-next"); // out of the loop
  const u = payloadOf(await send(g, "1-var-update --all-values *")).changelist;
  assert.deepEqual(u, [{ name: "var1", in_scope: "false", type_changed: "false", has_more: "0" }]);
});

test("&(name): pointer varobjs shaped like the golden's (numchild 1, `T *`, child `*&(name)`; vector: `_Vector_base` child)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 31");
  await send(g, "-exec-run");
  const mk = async (e) => payloadOf(await send(g, `3-var-create - * "${e}"`));
  const p = await mk("&(y)");
  assert.deepEqual(Object.keys(p), ["name", "numchild", "value", "type", "thread-id", "has_more"]);
  assert.deepEqual([p.name, p.numchild, p.type, p["thread-id"], p.has_more], ["var1", "1", "int *", "1", "0"]);
  assert.match(p.value, /^0x7ffe[0-9a-f]+$/);
  assert.equal((await mk("&y")).type, "int *", "without parentheses too");
  assert.equal(payloadOf(await send(g, "-var-evaluate-expression var1")).value, p.value, "the address is stable");
  const kids = payloadOf(await send(g, "-var-list-children --all-values var1"));
  assert.deepEqual(kids, { numchild: "1", children: [{ name: "var1.*&(y)", exp: "*&(y)", numchild: "0", value: "0", type: "int", "thread-id": "1" }], has_more: "0" });
  const pv = await mk("&(v)");
  assert.equal(pv.type, `${V.vec} *`);
  const vk = payloadOf(await send(g, `-var-list-children --all-values ${pv.name}`));
  const T = "std::_Vector_base<int, std::allocator<int> >";
  assert.deepEqual(vk, { numchild: "1", children: [{ name: `${pv.name}.${T}`, exp: T, numchild: "1", value: "{...}", type: T, "thread-id": "1" }], has_more: "0" });
  assert.match(payloadOf(await send(g, `-var-list-children --all-values "${pv.name}.${T}"`)).msg, /not supported by the browser engine/);
  const pg = await mk("&(g)");
  assert.equal(payloadOf(await send(g, `-var-list-children ${pg.name}`)).children[0].exp, "std::_Vector_base<" + V.vec + ", std::allocator<" + V.vec + " > >");
  // update: the child follows the variable, the pointer itself never changes
  await send(g, "-exec-next"); await send(g, "-exec-next"); await send(g, "-exec-next"); // y += i ... line 31, i = 1
  await send(g, "-exec-next"); await send(g, "-exec-next"); // line 30 again: y == 3
  const u = payloadOf(await send(g, "1-var-update --all-values *")).changelist;
  assert.deepEqual(u.map((c) => [c.name, c.value]), [["var1.*&(y)", "3"]]);
  // -var-delete counts the listed child
  assert.deepEqual(payloadOf(await send(g, "-var-delete var1")), { ndeleted: "2" });
  // unsupported pointees keep the explicit error, and unknown names the GDB one
  assert.match(payloadOf(await send(g, "3-var-create - * \"&(m)\"")).msg, /not supported by the browser engine/);
  assert.equal(payloadOf(await send(g, "3-var-create - * \"&(nosuch)\"")).msg, 'No symbol "nosuch" in current context.');
});

test("-exec-run clears breakpoint hit counts (GDB): times back to 0, then 1 after the first hit of the new run (verifier A3)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 7");
  await send(g, "-exec-run");
  await send(g, "-exec-continue");
  assert.equal(payloadOf(await send(g, "-break-list")).BreakpointTable.body[0].times, "2");
  const again = await send(g, "-exec-run");
  assert.equal(again.find((x) => x.message === "breakpoint-modified").payload.bkpt.times, "1");
  assert.equal(payloadOf(await send(g, "-break-list")).BreakpointTable.body[0].times, "1");
  const g2 = fresh();
  await send(g2, "-break-insert -f 16");
  await send(g2, "-exec-run");
  await send(g2, "-break-disable 1");
  await send(g2, "-exec-continue"); // runs to the end
  await send(g2, "-break-enable 1");
  assert.equal(payloadOf(await send(g2, "-break-list")).BreakpointTable.body[0].times, "1");
  await send(g2, "-exec-run");
  assert.equal(payloadOf(await send(g2, "-break-list")).BreakpointTable.body[0].times, "1", "reset to 0 at run, 1 after the hit");
});

test("expression literals (verifier A4): octal, hex, true/false, integer suffixes with C++ literal types", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  const tv = async (e) => { const r = payloadOf(await send(g, `3-var-create - * "${e}"`)); return r.msg || [r.value, r.type]; };
  assert.deepEqual(await tv("010"), ["8", "int"]);
  assert.deepEqual(await tv("0x10"), ["16", "int"]);
  assert.deepEqual(await tv("0x10 + 010 + x"), ["30", "int"]);
  assert.deepEqual(await tv("true"), ["true", "bool"]);
  assert.deepEqual(await tv("false || x > 5"), ["true", "bool"]);
  assert.deepEqual(await tv("2LL * big"), ["2469135780246", "long long"]);
  assert.deepEqual(await tv("2LL"), ["2", "long long"]);
  assert.deepEqual(await tv("1U"), ["1", "unsigned int"]);
  assert.deepEqual(await tv("1UL"), ["1", "unsigned long"]);
  assert.deepEqual(await tv("1U - 2"), ["4294967295", "unsigned int"]);
  assert.deepEqual(await tv("x - 7U"), ["4294967295", "unsigned int"]);
  assert.deepEqual(await tv("2147483648"), ["2147483648", "long"]);
  assert.deepEqual(await tv("0xffffffff"), ["4294967295", "unsigned int"]);
  assert.equal(await tv("08"), 'Invalid number "08".');
  assert.equal(await tv("1uu"), 'Invalid number "1uu".');
  assert.equal(await tv("99999999999999999999"), "Numeric constant too large.");
});

test("expression depth / length limits give an explicit error, never an internal error (verifier A5)", async () => {
  const g = fresh();
  await send(g, "-break-insert -f 33");
  await send(g, "-exec-run");
  for (const e of ["(".repeat(200) + "x" + ")".repeat(200), "x" + " + 1".repeat(2000), "-".repeat(500) + "x", "v[".repeat(100) + "0" + "]".repeat(100)]) {
    const r = (await send(g, `3-var-create - * "${e}"`)).find((x) => x.type === "result");
    assert.equal(r.message, "error");
    assert.equal(r.payload.msg, "expression too long or nested too deeply: not supported by the browser engine");
    const d = (await send(g, `-data-evaluate-expression "${e}"`)).find((x) => x.type === "result");
    assert.equal(d.payload.msg, "expression too long or nested too deeply: not supported by the browser engine");
  }
  assert.ok(!g.session.subcommandLog.some((s) => s.items.some((x) => x.payload && typeof x.payload.msg === "string" && /internal error/.test(x.payload.msg))));
});
