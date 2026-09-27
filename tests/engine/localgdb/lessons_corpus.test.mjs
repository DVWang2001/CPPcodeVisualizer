// Corpus regression over the real lesson bundles (examples/lessons/*/*.json), Node only.
//
// Evidence: tests/engine/browser/evidence/m1_lessons_manual_lines.json = the recorded REAL UI behaviour per lesson, on the server GDB
// ("gdb") and on the wasm engine ("wasm"): the line after an initial `continue` (only when the bundle has breakpoints) and after each
// of 30 `next` clicks. The UI inserts virtual steps on `for` headers (sub.seg "B", no GDB command): those steps are dropped and
// consecutive identical lines collapsed on BOTH sides before comparing.
//
// This test drives LocalGdb over the real engine result (bundle source + program_input) with the same protocol as the UI:
// bundle breakpoints (-break-insert file:line) + `main`, -exec-run (stops at main), `continue` iff the bundle has breakpoints, then
// `next` presses, and requires the same collapsed line sequence as the recorded GDB sequence.
//
// Skipped (documented): 0, 1 (recorded run exited at once), 2, 7, 12, 15, 16 (GDB baseline invalid: not all steps 'paused', or the
// recording ended in running/null steps), 8 (maze: input randomised per page load) and 19 (grid_paths: randomised input).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, stopped, newGdb } from "./helpers.mjs";

const EVIDENCE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "engine", "browser", "evidence", "m1_lessons_manual_lines.json"), "utf8"));
const SKIP = new Map([
  ["0", "recorded run exited immediately"], ["1", "recorded run exited immediately"], ["2", "GDB baseline invalid (running/null steps)"],
  ["7", "GDB baseline invalid (stuck running)"], ["12", "GDB baseline invalid (exited at once)"], ["15", "GDB baseline invalid (running/null steps)"],
  ["16", "GDB baseline invalid (running/null steps)"], ["8", "input randomised per page load"], ["19", "input randomised per page load"],
]);
const collapse = (a) => a.filter((x, i) => i === 0 || x !== a[i - 1]);
const recorded = (t) => collapse(t.steps.filter((s) => !/"seg":"B"/.test(String(s.sub))).map((s) => s.line));
const validBaseline = (t) => t.steps.length > 0 && t.steps.every((s) => s.st === "paused") && (t.ended || t.steps.length >= 25);
/** sequences known to differ, with the reason (recorded before a fixed LocalGdb defect) */
const WASM_PRE_FIX = new Map([["10", "recorded before the same-line fix: wasm stopped twice on line 23 (`if (isPalindrome(s)) cout ...` after the callee)"]]);

let eng;
const table = [];
before(async () => { eng = await loadNodeEngine(); });
after(() => {
  console.log("# lesson corpus (LocalGdb vs recorded GDB / wasm, collapsed line sequences):");
  for (const r of table) console.log(`#   ${r}`);
  eng && eng.dispose();
});

/** UI-level drive: returns the collapsed sequence of stop lines (>= `n` real stops, or until the program ends). */
async function drive(bundle, run, n = 90) {
  const g = newGdb(run, bundle.source_code, { gdbFilePath: "/srv/x/main.cpp" });
  const bps = bundle.breakpoints.filter((b) => b.is_normal_breakpoint !== false);
  await send(g, ["-break-insert -f main", ...bps.map((b) => `-break-insert -f "/srv/x/main.cpp:${b.line}"`)]);
  let it = await send(g, "-exec-run");
  if (bps.length) it = await send(g, "-exec-continue");
  const lines = [];
  let ended = false;
  for (let i = 0; i < n; i++) {
    const st = stopped(it);
    if (!st) break;
    if (/^exited/.test(st.payload.reason)) { ended = true; break; }
    lines.push(Number(st.payload.frame.line));
    it = await send(g, "-exec-next");
  }
  return { seq: collapse(lines), ended, g };
}

const firstDiff = (mine, rec) => { for (let i = 0; i < rec.length; i++) if (mine[i] !== rec[i]) return i; return -1; };

for (const [idx, v] of Object.entries(EVIDENCE)) {
  test(`lesson ${idx} ${v.lesson}`, async (t) => {
    if (SKIP.has(idx)) { table.push(`${idx.padStart(2)} ${v.lesson.padEnd(44)} skipped: ${SKIP.get(idx)}`); return t.skip(SKIP.get(idx)); }
    assert.ok(validBaseline(v.gdb), `lesson ${idx}: the recorded GDB baseline is not valid but the lesson is not in the skip list`);
    const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "examples", "lessons", v.lesson), "utf8"));
    const run = await eng.runProgram(bundle.source_code, bundle.program_input || "");
    assert.equal(run.ok, true, JSON.stringify(run.errors));
    const { seq, ended } = await drive(bundle, run);
    const rec = recorded(v.gdb);
    const d = firstDiff(seq, rec);
    const ctx = () => `recorded GDB ${rec.slice(Math.max(0, d - 3), d + 4).join(",")} vs LocalGdb ${seq.slice(Math.max(0, d - 3), d + 4).join(",")}`;
    assert.equal(d, -1, `lesson ${idx}: first divergence at #${d}: ${ctx()}`);
    assert.ok(seq.length >= rec.length, `lesson ${idx}: LocalGdb stops before the recorded sequence ends`);
    if (v.gdb.ended) assert.ok(ended || seq.length > rec.length || rec.length === seq.length, "recorded run ended");
    // Node replay must equal what the real UI showed on the wasm engine
    let wasmNote = "n/a";
    if (v.wasm && v.wasm.steps.every((s) => s.st === "paused")) {
      const wrec = recorded(v.wasm);
      const wd = firstDiff(seq, wrec);
      if (WASM_PRE_FIX.has(idx)) {
        assert.notEqual(wd, -1, "the known pre-fix wasm divergence is gone from the recording?");
        wasmNote = "differs (pre-fix recording: " + WASM_PRE_FIX.get(idx) + ")";
      } else {
        assert.equal(wd, -1, `lesson ${idx}: Node replay differs from the recorded wasm run at #${wd}: wasm ${wrec.slice(Math.max(0, wd - 3), wd + 4).join(",")} vs Node ${seq.slice(Math.max(0, wd - 3), wd + 4).join(",")}`);
        wasmNote = `same(${wrec.length})`;
      }
    }
    table.push(`${idx.padStart(2)} ${v.lesson.padEnd(44)} vs GDB: identical(${rec.length} lines${v.gdb.ended ? ", ended" : ""}) | vs wasm: ${wasmNote}`);
  });
}

test("Task 3: rails (idx 9) and maze (idx 8) do exit under repeated `continue`; loops with breakpoints simply need many presses", async () => {
  const run1 = async (rel) => {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, "examples", "lessons", rel), "utf8"));
    const run = await eng.runProgram(b.source_code, b.program_input || "");
    assert.equal(run.ok, true);
    const { g } = await drive(b, run, 31); // main stop, `continue` to the first bundle breakpoint, then the `next` phase
    let presses = 0, last;
    for (; presses < 200; presses++) {
      const it = await send(g, "-exec-continue");
      last = stopped(it);
      if (!last || /^exited/.test(last.payload.reason)) break;
    }
    return { presses: presses + 1, reason: last && last.payload.reason, bpLines: new Set(b.breakpoints.map((x) => Number(x.line))) };
  };
  const rails = await run1("stack經典_Rails/stack_rails.json");
  assert.equal(rails.reason, "exited-normally");
  assert.ok(rails.presses <= 40, `rails needs ${rails.presses} continues (UI script allows 40; GDB's loop-entry-only breakpoint hits give this count)`);
  const maze = await run1("queue經典_老鼠走迷宮/maze_bfs_lesson.json");
  assert.equal(maze.reason, "exited-normally");
  assert.ok(maze.presses > 40, `maze has a breakpoint on a loop BODY line hit ${maze.presses - 1} times: more than the UI script's 40 presses`);
});
