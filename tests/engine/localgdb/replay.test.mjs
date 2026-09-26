// Contract §4-A: protocol replay of the golden sample (production GDB 16.3 driven by the real UI on
// lesson 技巧一) through LocalGdb, comparing every sub-command's response items to the golden ones
// under the closed allow list (golden_replay.mjs ALLOW_RULES). Also proves the comparator is not vacuous:
// deliberately altered goldens must fail.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { createLocalGdb } from "../../../gdbgui/static/engine/localgdb/index.js";
import { ROOT, ALLOW_RULES, loadGolden, replayGolden } from "./golden_replay.mjs";

const LESSON = path.join(ROOT, "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp");
const STDIN = path.join(ROOT, "experiments", "frontend-only", "e1", "e2", "ref", "tsp.in");
const source = fs.readFileSync(LESSON, "utf8");
let eng, run, events, gdbFilePath, userFns, main;

/** @param {any[]} evs */
function newGdb(evs) {
  return createLocalGdb({ source, stdin: fs.readFileSync(STDIN, "utf8"), runResult: run, sourcePath: "/workspace/main.cpp", gdbFilePath, recordSubcommands: true });
}

before(async () => {
  events = loadGolden();
  const loadCmd = events.find((e) => e.name === "run_gdb_command" && e.data.cmd.length > 5);
  gdbFilePath = /"?(\/srv\/gdbgui-scratch\/[^\s"]*\.cpp):\d+"?$/.exec(loadCmd.data.cmd.find((c) => c.startsWith("-break-insert") && c.includes(":31")))[1];
  eng = await loadNodeEngine();
  run = await eng.runProgram(source, fs.readFileSync(STDIN, "utf8"));
  userFns = new Set(Object.keys(run.functions));
  main = await replayGolden({ gdb: newGdb(events), events, userFns, steps: run.steps });
});
after(() => eng && eng.dispose());

test("engine run of the golden program succeeds and its stdout equals the pty output", () => {
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const golden = events.filter((e) => e.name === "program_pty_response").map((e) => e.data).join("");
  assert.equal(run.stdout, golden.replace(/\r\n/g, "\n"));
});

test("replay: zero differences outside the allow list", () => {
  const { rep, rows } = main;
  // per-command table (grouped) for the report
  const groups = new Map();
  for (const r of rows) {
    const key = r.where.replace(/^event \d+ sub#\d+ /, "").replace(/var\d+/g, "varN").replace(/"[^"]*"/g, '"..."').slice(0, 52) + "  ->  " + r.verdict;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  console.log("# replay result per command kind (count):");
  for (const [k, v] of [...groups].sort()) console.log(`#   ${String(v).padStart(4)}  ${k}`);
  console.log("# allowed differences by rule:", JSON.stringify(Object.fromEntries(rep.allowed)));
  console.log("# uninit-value (line:variable) pairs:", rep.uninitPairs.size);
  const nt = new Map();
  for (const n of rep.notTested) nt.set(n.reason.replace(/variable object var\S+/, "variable object varN").replace(/expression `[^`]*`/, "expression `X`"), (nt.get(n.reason.replace(/variable object var\S+/, "variable object varN").replace(/expression `[^`]*`/, "expression `X`")) || 0) + 1);
  console.log("# not tested:");
  for (const [k, v] of nt) console.log(`#   ${String(v).padStart(4)}  ${k}`);
  console.log(`# tested sub-commands: ${rep.tested}, not tested: ${rep.notTested.length}`);
  assert.deepEqual(rep.diffs, [], "differences outside the allow list:\n" + rep.diffs.join("\n"));
  for (const k of rep.allowed.keys()) assert.ok(k in ALLOW_RULES, "unknown allow rule " + k);
});

test("replay coverage: the replay compared the core commands, and every not-tested item has one of the documented reasons", () => {
  const { rep, rows } = main;
  assert.ok(rep.tested >= 400, "tested " + rep.tested);
  const tested = (re) => rows.filter((r) => re.test(r.where) && r.verdict === "match").length;
  assert.equal(tested(/-exec-run/), 1);
  assert.equal(tested(/-exec-continue/), 4);
  assert.equal(tested(/-exec-next/), 21);
  assert.equal(tested(/-exec-step/), 1);
  assert.equal(tested(/python exec/), 1);
  assert.equal(tested(/-var-create/), 75, "every golden -var-create is compared now (plain names, &(x), integer expressions, x.capacity())");
  assert.equal(tested(/-var-list-children/), 112);
  assert.equal(tested(/-var-delete/), 48);
  assert.ok(tested(/-var-update/) >= 30 && tested(/-stack-list-frames/) >= 30 && tested(/-break-list/) >= 30);
  const allowedReasons = [/step into libstdc\+\+/, /inside a libstdc\+\+ frame/];
  for (const n of rep.notTested) assert.ok(allowedReasons.some((re) => re.test(n.reason)), "undocumented not-tested reason: " + n.reason);
  assert.equal(rep.notTested.filter((n) => /step into libstdc/.test(n.reason)).length, 1, "exactly one std-library step-in (golden README: step x2, one enters vector::operator[])");
});

test("replay: program output arrives once, after the exit packet, CRLF like the pty", () => {
  const outs = main.otherEvents.filter(([n]) => n === "program_pty_response").map(([, p]) => p);
  assert.deepEqual(outs, ["3 2 2 1\r\n6\r\n"]);
  const last = main.gdbResponses[main.gdbResponses.length - 1];
  assert.ok(last.data.some((it) => it.type === "notify" && it.message === "stopped" && it.payload.reason === "exited-normally"));
});

test("replay: packet_seq_num strictly increases and request_id is the session-level last request id", () => {
  const seqs = main.gdbResponses.map((p) => p.packet_seq_num);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  const goldenCmds = events.filter((e) => e.name === "run_gdb_command");
  assert.equal(main.gdbResponses.length, goldenCmds.length, "one packet per run_gdb_command");
  main.gdbResponses.forEach((p, i) => assert.equal(p.request_id, goldenCmds[i].data.request_id));
});

// ---- the comparator must fail on altered goldens ------------------------------------------------

const clone = (x) => JSON.parse(JSON.stringify(x));
const respItems = (evs) => evs.filter((e) => e.name === "gdb_response").flatMap((e) => e.data.data);
const MUTATIONS = {
  "stop line of a next": (evs) => { const it = respItems(evs).find((x) => x.type === "notify" && x.message === "stopped" && x.payload.frame && x.payload.frame.line === "32"); it.payload.frame.line = "99"; },
  "stop reason": (evs) => { const it = respItems(evs).find((x) => x.type === "notify" && x.message === "stopped" && x.payload.reason === "breakpoint-hit"); it.payload.reason = "end-stepping-range"; },
  "child value of a vector varobj": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.children && x.payload.children[0].type === "int"); it.payload.children[0].value = "12345"; },
  "token of a result": (evs) => { const it = respItems(evs).find((x) => x.type === "result" && x.token === 1); it.token = 2; },
  "missing token key on a result": (evs) => { const it = respItems(evs).find((x) => x.type === "result" && x.token === 1); delete it.token; },
  "extra token key on a console item": (evs) => { const it = respItems(evs).find((x) => x.type === "console"); it.token = null; },
  "fast-forward blob counts": (evs) => { const it = respItems(evs).find((x) => x.type === "console" && x.payload.startsWith("@@FF@@")); it.payload = it.payload.replace('"33": 2', '"33": 3'); },
  "fast-forward landed flag": (evs) => { const it = respItems(evs).find((x) => x.type === "console" && x.payload.startsWith("@@FF@@")); it.payload = it.payload.replace('"landed": true', '"landed": false'); },
  "variable type string": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.variables); it.payload.variables[0].type = "long"; },
  "vector value string": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.type && x.payload.value && x.payload.value.startsWith("std::vector")); it.payload.value = "std::vector of length 6, capacity 6"; },
  "breakpoint line": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.bkpt); it.payload.bkpt.line = "24"; },
  "message done -> error": (evs) => { const it = respItems(evs).find((x) => x.type === "result" && x.token === 1); it.message = "error"; },
  "error text of the inlined-method error": (evs) => { const it = respItems(evs).find((x) => x.message === "error"); it.payload.msg = "something else"; },
  "extra item in a response": (evs) => { const e = evs.find((x) => x.name === "gdb_response" && x.data.data.some((y) => y.message === "stopped")); e.data.data.splice(1, 0, { type: "console", message: null, payload: "x\n", stream: "stdout" }); },
  "program output": (evs) => { const e = evs.find((x) => x.name === "program_pty_response"); e.data = "3 2 2 2\r\n6\r\n"; },
  "changelist value": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.changelist && x.payload.changelist.some((c) => c.value !== undefined && c.name.startsWith("var4."))); it.payload.changelist.find((c) => c.value !== undefined).value = "-7"; },
  "packet run_token": (evs) => { const e = evs.filter((x) => x.name === "gdb_response" && x.data.run_token === "<redacted>")[5]; e.data.run_token = "<other>"; },
  "packet run_token null vs set": (evs) => { const e = evs.find((x) => x.name === "gdb_response" && x.data.run_token === null); e.data.run_token = "<redacted>"; },
  "uninitialised variable: garbage replaced by a non-number": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.variables); it.payload.variables[0].value = "abc"; },
  "uninitialised variable: type differs": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.variables); it.payload.variables[0].type = "long"; },
  "pointer value that is not an address": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.type && / \*$/.test(x.payload.type) && x.payload.value); it.payload.value = "0x7ffe zz"; },
  "pointer varobj type": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.type && / \*$/.test(x.payload.type) && x.payload.value); it.payload.type = "long *"; },
  "pointer child value": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.children && /^\*&/.test(x.payload.children[0].exp)); it.payload.children[0].value = "424242"; },
  "integer expression value (w - 1)": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.type === "int" && x.payload.name && x.payload.value === "3"); it.payload.value = "4"; },
  "initialised inner r shadowing an uninitialised outer r (A1)": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.variables && x.payload.variables[0].name === "r" && x.payload.variables[0].value === "0" && x.payload.variables.filter((v) => v.name === "r").length === 2); it.payload.variables[0].value = "7"; },
  "null pointer vs address (A2)": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.type && / \*$/.test(x.payload.type) && x.payload.value); it.payload.value = "0x0"; },
  "features list": (evs) => { const it = respItems(evs).find((x) => x.payload && x.payload.features && x.payload.features.length); it.payload.features.push("bogus-feature"); },
};

for (const [name, mut] of Object.entries(MUTATIONS)) {
  test(`comparator fails on an altered golden: ${name}`, async () => {
    const evs = clone(events);
    mut(evs);
    const res = await replayGolden({ gdb: newGdb(evs), events: evs, userFns, steps: run.steps });
    assert.ok(res.rep.diffs.length > 0, `mutation "${name}" was not detected`);
    // the diff is readable: it names the event and the field
    assert.match(res.rep.diffs.join("\n"), /event \d+ sub#\d+|program_pty_response|packet/);
  });
}
