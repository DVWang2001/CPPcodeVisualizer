// -vg-seek-step and -vg-cell-last-write (live-quiz heatmap "jump to the step that filled this cell"; experiment C0).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { newGdb, send, stopped } from "./helpers.mjs";

const LESSONS = "examples/lessons/";
let eng;
const runs = {};
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

async function lesson(dir, file) {
  const key = dir + file;
  if (!runs[key]) {
    const b = JSON.parse(fs.readFileSync(LESSONS + dir + "/" + file, "utf8"));
    for (let i = 0; i < 2 && !(runs[key] && runs[key].run.ok); i++) runs[key] = { b, run: await eng.runProgram(b.source_code, b.program_input || "", {}) };
    assert.equal(runs[key].run.ok, true, "lesson did not compile/run");
  }
  const { b, run } = runs[key];
  const g = newGdb(run, b.source_code);
  await send(g, "-break-insert main");
  await send(g, "-exec-run");
  return { g, run, src: b.source_code.split("\n") };
}
const knap = () => lesson("DP課3_背包填表", "dp3_knapsack.json");
const trigStep = (run, line) => run.steps.findIndex((s) => s.line === line);

test("seek: stop records and variables equal stepping there one by one", async () => {
  const a = await knap(), b = await knap();
  const k = 40;
  let items;
  while (a.g.session.exec.pos < k) items = await send(a.g, "-exec-step");
  const viaSeek = await send(b.g, `-vg-seek-step ${k}`);
  assert.deepEqual(viaSeek.map((x) => x.type + ":" + x.message), ["output:null", "notify:running", "notify:stopped"]);
  assert.equal(stopped(viaSeek).payload.reason, "end-stepping-range");
  assert.deepEqual(stopped(viaSeek), stopped(items));
  assert.equal(b.g.session.exec.pos, k);
  assert.deepEqual(await send(b.g, "-stack-list-variables --all-values"), await send(a.g, "-stack-list-variables --all-values"));
  // normal stepping continues from the new position
  await send(b.g, "-exec-step");
  assert.equal(b.g.session.exec.pos, k + 1);
});

test("seek: out-of-range, malformed, and exited program are MI errors", async () => {
  const { g, run } = await knap();
  const n = run.steps.length;
  for (const bad of [String(n), "-1", "abc", "1.5", "", "1 2"]) {
    const r = await send(g, `-vg-seek-step ${bad}`);
    assert.equal(r[0].message, "error", bad);
    assert.match(r[0].payload.msg, /out of range/);
  }
  await send(g, "-exec-continue"); // ends the program
  const r = await send(g, "-vg-seek-step 3");
  assert.equal(r[0].payload.msg, "The program is not being run.");
});

test("last-write knapsack: same-value write dp[2][1] -> its assignment line; declaration-filled cell -> value-change", async () => {
  const { g, run, src } = await knap();
  const T = trigStep(run, 28);
  const r = await send(g, `-vg-cell-last-write dp 2 1 ${T}`);
  const p = r.find((x) => x.type === "result").payload;
  assert.equal(p.how, "assignment");
  assert.match(src[Number(p.line) - 1], /dp\[i\]\[w\]\s*=\s*std::max\(skip, take\)/);
  assert.ok(Number(p.step) < T);
  // the index expressions really are (2, 1) at that step
  assert.equal(run.steps[Number(p.step)].vars.i, 2);
  assert.equal(run.steps[Number(p.step)].vars.w, 1);
  // position is untouched, default BEFORE = current position gives the same answer when we are at T
  const before = g.session.exec.pos;
  await send(g, `-vg-seek-step ${T}`);
  const d = (await send(g, "-vg-cell-last-write dp 2 1")).find((x) => x.type === "result").payload;
  assert.deepEqual(d, p);
  assert.equal(g.session.exec.pos, T);
  assert.notEqual(before, T);
  // dp[0][0] is only set by the declaration
  const f = (await send(g, "-vg-cell-last-write dp 0 0")).find((x) => x.type === "result").payload;
  assert.equal(f.how, "value-change");
  assert.match(src[Number(f.line) - 1], /dp\(n \+ 1/);
});

test("last-write recursion (memoised, writes inside recursion) lands on the assignment", async () => {
  const { g, run, src } = await lesson("技巧二_記憶化搜尋_UVA10285", "longest_run.json");
  const T = trigStep(run, 57);
  const p = (await send(g, `-vg-cell-last-write dp 1 1 ${T}`)).find((x) => x.type === "result").payload;
  assert.equal(p.how, "assignment");
  assert.equal(p.step, "208"); // C0: same step as value-change, found by assignment
  assert.match(src[Number(p.line) - 1], /dp\[[^\]]+\]\[[^\]]+\]\s*=/);
});

test("last-write errors: not a 2-D container, never written, bad args", async () => {
  const { g, run } = await knap();
  const T = trigStep(run, 28);
  assert.match((await send(g, `-vg-cell-last-write best 0 0 ${T}`))[0].payload.msg, /not a visible 2-D container/);
  assert.match((await send(g, `-vg-cell-last-write dp 9 9 ${T}`))[0].payload.msg, /no step before \d+ wrote dp\[9\]\[9\]/);
  assert.match((await send(g, "-vg-cell-last-write dp 1"))[0].payload.msg, /Usage/);
  assert.match((await send(g, "-vg-cell-last-write dp a b"))[0].payload.msg, /Usage/);
});
