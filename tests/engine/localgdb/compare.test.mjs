// Unit tests of the replay comparator itself (contract §4-A: "a deliberately altered golden must fail"):
// what the allow list lets through, what it must not, and the golden segmentation rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Report, compareSub, segmentGolden, ALLOW_RULES } from "./golden_replay.mjs";

const ctx = (uninit = []) => ({ uninit: new Set(uninit), expr: null, step: { vars: {}, uninit: [] }, line: 1, declLater: new Set() });
const res = (payload, token = null, message = "done") => ({ type: "result", message, payload, token, stream: "stdout" });
const cmp = (g, m, c = ctx()) => { const r = new Report(); compareSub("t", g, m, r, c); return r; };

test("identical item lists: no differences, no allowances used", () => {
  const items = [res({ a: 1 }, 3), { type: "console", message: null, payload: "x\n", stream: "stdout" }];
  const r = cmp(items, JSON.parse(JSON.stringify(items)));
  assert.deepEqual([r.diffs, [...r.allowed]], [[], []]);
});

test("allowed: addr, file, pid/thread, process N text, gdb noise, extra `reverse` feature; each is counted", () => {
  const g = [
    { type: "notify", message: "library-loaded", payload: { id: "/lib/x" }, token: null, stream: "stdout" },
    { type: "log", message: null, payload: "warning: Error disabling address space randomization: Operation not permitted\n", stream: "stdout" },
    res({ threads: [{ id: "1", "target-id": "Thread 0x7 (LWP 57)", name: "abc", frame: { level: "0", addr: "0x0000000000401222", file: "/real/a.cpp", line: "3" }, state: "stopped", core: "0" }], "current-thread-id": "1" }, 1),
    { type: "notify", message: "thread-group-started", payload: { id: "i1", pid: "57" }, token: null, stream: "stdout" },
    { type: "console", message: null, payload: "[Inferior 1 (process 57) exited normally]\n", stream: "stdout" },
    res({ features: ["a", "b"] }),
  ];
  const m = [
    res({ threads: [{ id: "1", "target-id": "Thread 0x9 (LWP 4242)", name: "main", frame: { level: "0", addr: "0x0000000000409000", file: "/other/b.cpp", line: "3" }, state: "stopped", core: "0" }], "current-thread-id": "1" }, 1),
    { type: "notify", message: "thread-group-started", payload: { id: "i1", pid: "4242" }, token: null, stream: "stdout" },
    { type: "console", message: null, payload: "[Inferior 1 (process 4242) exited normally]\n", stream: "stdout" },
    res({ features: ["a", "b", "reverse"] }),
  ];
  const r = cmp(g, m);
  assert.deepEqual(r.diffs, []);
  assert.deepEqual(Object.fromEntries(r.allowed), { "gdb-noise": 2, "pid-thread": 4, addr: 1, file: 1, "reverse-feature": 1 });
  for (const k of r.allowed.keys()) assert.ok(k in ALLOW_RULES);
});

test("allowed: value of an uninitialised variable (ours is the zero of its type) - but only for variables flagged uninitialised", () => {
  const g = [res({ variables: [{ name: "h", type: "int", value: "198127616" }, { name: "w", type: "int", value: "5" }] }, 1)];
  const m = [res({ variables: [{ name: "h", type: "int", value: "0" }, { name: "w", type: "int", value: "5" }] }, 1)];
  assert.deepEqual(cmp(g, m, ctx(["h"])).diffs, []);
  assert.equal(cmp(g, m, ctx(["h"])).allowed.get("uninit-value"), 1);
  assert.equal(cmp(g, m, ctx([])).diffs.length, 1, "h is not flagged uninitialised: the difference counts");
  const nonzero = [res({ variables: [{ name: "h", type: "int", value: "7" }, { name: "w", type: "int", value: "5" }] }, 1)];
  assert.equal(cmp(g, nonzero, ctx(["h"])).diffs.length, 1, "a non-zero value of ours is never excused");
  const w = [res({ variables: [{ name: "h", type: "int", value: "0" }, { name: "w", type: "int", value: "0" }] }, 1)];
  assert.equal(cmp(g, w, ctx(["h"])).diffs.length, 1, "w is initialised: 5 != 0");
});

test("fast-forward blob: compared as JSON with addr allowed; counts/landed/lines differences fail", () => {
  const blob = (o) => ({ type: "console", message: null, payload: "@@FF@@" + JSON.stringify(o) + "@@/FF@@\n", stream: "stdout" });
  const base = { stacks: [[{ func: "main", addr: "0x4014ec", line: 33, fullname: "/w/main.cpp", args: [] }]], counts: { 33: 1 }, landed: true, steps: 1 };
  const other = { ...base, stacks: [[{ ...base.stacks[0][0], addr: "0x999" }]] };
  const a = cmp([blob(base)], [blob(other)]);
  assert.deepEqual([a.diffs, a.allowed.get("addr")], [[], 1]);
  assert.equal(cmp([blob(base)], [blob({ ...base, landed: false })]).diffs.length, 1);
  assert.equal(cmp([blob(base)], [blob({ ...base, counts: { 33: 2 } })]).diffs.length, 1);
  assert.equal(cmp([blob(base)], [blob({ ...base, steps: 2 })]).diffs.length, 1);
  assert.equal(cmp([blob(base)], [blob({ ...base, stacks: [[{ ...base.stacks[0][0], line: 34 }]] })]).diffs.length, 1);
});

test("NOT allowed: token value/presence, type, message, payload keys, array lengths, stream, item count, order", () => {
  const base = () => [res({ x: 1, list: [1, 2] }, 3), { type: "console", message: null, payload: "c\n", stream: "stdout" }];
  const bad = {
    "token value": (m) => { m[0].token = 4; },
    "token null vs number": (m) => { m[0].token = null; },
    "missing token key": (m) => { delete m[0].token; },
    "extra token key": (m) => { m[1].token = null; },
    "message": (m) => { m[0].message = "error"; },
    "type": (m) => { m[1].type = "log"; },
    "stream": (m) => { m[0].stream = "stderr"; },
    "payload value": (m) => { m[0].payload.x = 2; },
    "extra payload key": (m) => { m[0].payload.y = 1; },
    "missing payload key": (m) => { delete m[0].payload.x; },
    "array length": (m) => { m[0].payload.list.push(3); },
    "array element": (m) => { m[0].payload.list[1] = 9; },
    "text": (m) => { m[1].payload = "d\n"; },
    "item count": (m) => { m.pop(); },
    "item order": (m) => { m.reverse(); },
    "addr-like key not named addr": (m) => { m[0].payload.x = "0x1"; },
  };
  for (const [name, mut] of Object.entries(bad)) {
    const m = base(); mut(m);
    assert.ok(cmp(base(), m).diffs.length > 0, `not detected: ${name}`);
  }
  // readable output: names the sub-command, the item and the path
  const m = base(); m[0].payload.x = 2;
  assert.match(cmp(base(), m).diffs[0], /^t item\[0\] result\/done#3\.payload\.x: golden 1 != ours 2$/);
});

test("golden segmentation attributes items by command kind and fails loudly when the stream does not fit", () => {
  const S = (name, data, dir = "S>C") => ({ t: 0, dir, name, sid: "x", data });
  const C = (cmd, id) => S("run_gdb_command", { cmd, run_token: null, request_id: id }, "C>S");
  const R = (...data) => S("gdb_response", { run_token: null, request_id: 1, packet_seq_num: 1, data });
  const done = { type: "output", message: null, payload: "^done\r", stream: "stdout" };
  const result = (n) => ({ type: "result", message: "done", payload: { n }, token: null, stream: "stdout" });
  const running = { type: "output", message: null, payload: "^running\r", stream: "stdout" };
  const stop = { type: "notify", message: "stopped", payload: { reason: "end-stepping-range" }, token: null, stream: "stdout" };
  const ff = { type: "console", message: null, payload: "@@FF@@{}@@/FF@@\n", stream: "stdout" };
  const echo = { type: "log", message: null, payload: "python exec(@@FF@@ ...)\n", stream: "stdout" };
  const evs = [
    C(["-enable-pretty-printing", "3-var-create - * \"x\"", "-exec-next", "python exec(\"@@FF@@\")", "-break-list"], 1),
    R(done, result(1)), R(running, { type: "notify", message: "running", payload: {}, token: null, stream: "stdout" }), R(stop),
    R(echo, running, stop, ff), R(result(2)),
  ];
  const seg = segmentGolden(evs);
  assert.deepEqual(seg.commands[0].subs.map((s) => [s.kind, s.items.length]), [["plain", 1], ["plain", 1], ["exec", 3], ["ff", 4], ["plain", 1]]);
  // fewer golden items than sub-commands: loud failure
  assert.throws(() => segmentGolden([C(["-list-features", "-list-target-features"], 1), R(result(1))]), /ran out of items/);
  // unattributed items: loud failure
  assert.throws(() => segmentGolden([C(["-list-features"], 1), R(result(1), result(2))]), /not attributed/);
});

test("address rules are strict: whole hex address on both sides, or `@0xADDR: rest` with the rest equal; pid only digits", () => {
  const v = (value) => [res({ name: "v", value, type: "T *" }, 3)];
  const ok = (g, m) => cmp(v(g), v(m)).diffs.length === 0;
  assert.equal(ok("0x7ffe050cba90", "0x7ffc00001230"), true);
  assert.equal(ok("0x7ffe050cba90", "0x7ffe zz"), false, "the same prefix is not enough");
  assert.equal(ok("0x7ffe050cba90", "0x7ffe050cba90 extra"), false);
  assert.equal(ok("0x7ffe050cba90", "12"), false);
  assert.equal(ok("@0x7ffe1: std::vector of length 3, capacity 4", "@0x7ffc9: std::vector of length 3, capacity 4"), true);
  assert.equal(ok("@0x7ffe1: std::vector of length 3, capacity 4", "@0x7ffc9: std::vector of length 4, capacity 4"), false, "the rest after the address is compared exactly");
  const addrKey = (a, b) => cmp([res({ bkpt: { addr: a } })], [res({ bkpt: { addr: b } })]).diffs.length === 0;
  assert.equal(addrKey("0x0000000000401222", "0x0000000000409000"), true);
  assert.equal(addrKey("0x0000000000401222", "<PENDING>"), false);
  const pid = (a, b) => cmp([res({ id: "i1", pid: a })], [res({ id: "i1", pid: b })]).diffs.length === 0;
  assert.equal(pid("57", "4242"), true);
  assert.equal(pid("57", "abc"), false);
});

test("uninit-value rule: zero on our side, integer garbage on the golden side, variable uninitialised per the ENGINE trace too; pairs are recorded", () => {
  const g = [res({ variables: [{ name: "h", type: "int", value: "198127616" }] }, 1)];
  const m = [res({ variables: [{ name: "h", type: "int", value: "0" }] }, 1)];
  const c = (extra) => ({ uninit: new Set(["h"]), expr: null, step: { vars: { h: 0 }, uninit: ["h"] }, line: 23, declLater: new Set(), ...extra });
  const run = (gg, cc) => { const r = new Report(); compareSub("t", gg, m, r, cc); return r; };
  const r1 = run(g, c());
  assert.deepEqual([r1.diffs, [...r1.uninitPairs]], [[], ["23:h"]]);
  assert.equal(run(g, c({ step: { vars: { h: 0 }, uninit: [] } })).diffs.length, 1, "LocalGdb's flag alone is not trusted: the engine trace must agree");
  assert.equal(run(g, c({ step: { vars: { h: 0 }, uninit: [] }, declLater: new Set(["h"]) })).diffs.length, 0, "shadowed outer variable declared later");
  assert.equal(run(g, c({ uninit: new Set() })).diffs.length, 1);
  const gtext = [res({ variables: [{ name: "h", type: "int", value: "abc" }] }, 1)];
  assert.equal(run(gtext, c()).diffs.length, 1, "golden garbage must be a plain integer");
  const gtype = [res({ variables: [{ name: "h", type: "long", value: "198127616" }] }, 1)];
  assert.equal(run(gtype, c()).diffs.length, 1, "only the value may differ, never the type");
});
