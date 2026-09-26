// LocalGdb protocol layer on a tiny hand-made engine result (no compiler needed): handshake, socket surface,
// FIFO/packets/request_id/run_token, token & stream field rules (spec §12 A6), pty_interaction, error payloads,
// exit codes/signals, non-instrumented runs, MI error paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalGdb } from "../../../gdbgui/static/engine/localgdb/index.js";
import { send, payloadOf, stopped, newGdb, smallRun, SMALL_SRC } from "./helpers.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("handshake: `connect` first, then debug_session_connection_event {ok, started_new_gdb_process:true, pid, message}", async () => {
  const gdb = createLocalGdb({ source: SMALL_SRC, runResult: smallRun(), pid: 77 });
  const seen = [];
  assert.equal(gdb.socket.connected, false);
  gdb.socket.on("connect", () => seen.push(["connect", gdb.socket.connected]));
  gdb.socket.on("debug_session_connection_event", (p) => seen.push(["dsce", p]));
  await tick();
  assert.deepEqual(seen, [["connect", true], ["dsce", { ok: true, started_new_gdb_process: true, message: "Started new gdb process, pid 77", pid: 77 }]]);
  assert.equal(gdb.socket.connected, true);
});

test("socket surface: on / once / off / emit / connected / close (the subset the UI uses)", async () => {
  const gdb = createLocalGdb({ source: SMALL_SRC, runResult: smallRun(), recordSubcommands: true });
  await tick();
  assert.equal(gdb.socket.disconnected, false, "Terminals.tsx / GdbApi.tsx test socket.disconnected");
  const got = [];
  const cb = (p) => got.push(p.packet_seq_num);
  gdb.socket.on("gdb_response", cb);
  await send(gdb, "-list-features");
  assert.deepEqual(got, [1]);
  gdb.socket.off("gdb_response", cb);
  await send(gdb, "-list-features");
  assert.deepEqual(got, [1]);
  const once = [];
  gdb.socket.once("gdb_response", (p) => once.push(p.packet_seq_num));
  await send(gdb, "-list-features"); await send(gdb, "-list-features");
  assert.deepEqual(once, [3]);
  gdb.socket.close();
  assert.equal(gdb.socket.connected, false);
  assert.equal(gdb.socket.disconnected, true);
  const n = gdb.session.subcommandLog.length;
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-features"], run_token: null, request_id: 99 });
  await gdb.idle();
  assert.equal(gdb.session.subcommandLog.length, n, "a closed socket does not process commands");
});

test("gdb_response shape: run_token echoed, request_id = session-level last request id, packet_seq_num strictly increasing", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const packets = [];
  gdb.socket.on("gdb_response", (p) => packets.push(p));
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-features"], run_token: null, request_id: 5 });
  gdb.socket.emit("run_gdb_command", { cmd: ["-break-list"], run_token: null, request_id: 6 });
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-target-features"], run_token: null, request_id: 7 });
  await gdb.idle();
  assert.equal(packets.length, 3);
  assert.deepEqual(packets.map((p) => p.packet_seq_num), [1, 2, 3]);
  // processed strictly FIFO (spec §4): the answers come in command order
  assert.ok(packets[0].data[0].payload.features.includes("reverse"));
  assert.equal(packets[1].data[0].payload.BreakpointTable.nr_rows, "0");
  assert.deepEqual(packets[2].data[0].payload, { features: [] });
  for (const p of packets) assert.ok(Number.isInteger(p.request_id) && p.run_token === null);
  assert.equal(packets[2].request_id, 7);
});

test("FIFO: commands sent back to back are answered in order even when an exec command sits between them", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const order = [];
  gdb.socket.on("gdb_response", (p) => order.push(p.data.map((i) => i.message).join(",")));
  gdb.socket.emit("run_gdb_command", { cmd: ["-break-insert -f main"], run_token: null, request_id: 1 });
  gdb.socket.emit("run_gdb_command", { cmd: ["-exec-run"], run_token: null, request_id: 2 });
  gdb.socket.emit("run_gdb_command", { cmd: ["1-thread-info", "1-stack-list-frames"], run_token: null, request_id: 3 });
  await gdb.idle();
  assert.equal(order.length, 3);
  assert.match(order[1], /thread-group-started.*stopped/);
  assert.equal(order[2], "done,done", "thread-info/stack-list-frames see the stop produced by the previous command");
});

test("token rules: result items carry the numeric prefix (or null); output/console/log have no token key; notify has token null; stream on every item", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const it = await send(gdb, ["-break-insert -f main", "7-break-list", "-interpreter-exec console \"unset substitute-path\"", "-enable-pretty-printing", "-exec-run", "5-foo"]);
  const by = (pred) => it.filter(pred);
  for (const x of it) assert.equal(x.stream, "stdout");
  for (const x of by((x) => x.type === "output" || x.type === "console" || x.type === "log")) assert.equal("token" in x, false, `${x.type} must not have a token key`);
  for (const x of by((x) => x.type === "notify")) assert.equal(x.token, null);
  const results = by((x) => x.type === "result");
  assert.deepEqual(results.map((r) => [r.message, r.token]), [["done", null], ["done", 7], ["error", 5]]);
  assert.equal(results[2].payload.code, "undefined-command");
});

test("bare ^done / ^running reach the UI as raw output items (golden), a token stays in the raw text", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  assert.deepEqual((await send(gdb, "-enable-pretty-printing")).map((x) => [x.type, x.payload]), [["output", "^done\r"]]);
  assert.deepEqual((await send(gdb, "4-gdb-set pagination off")).map((x) => [x.type, x.payload]), [["output", "4^done\r"]]);
  const run = await send(gdb, "-exec-run");
  assert.deepEqual(run.slice(2, 4).map((x) => [x.type, x.payload]), [["output", "^running\r"], ["notify", { "thread-id": "all" }]]);
});

test("stale run_token is dropped silently; null or matching tokens are processed", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  gdb.setRunToken("tok-A");
  const got = [];
  gdb.socket.on("gdb_response", (p) => got.push(p.run_token));
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-features"], run_token: "tok-OLD", request_id: 1 });
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-features"], run_token: "tok-A", request_id: 2 });
  gdb.socket.emit("run_gdb_command", { cmd: ["-list-features"], run_token: null, request_id: 3 });
  await gdb.idle();
  assert.deepEqual(got, ["tok-A", null]);
});

test("malformed run_gdb_command / pty_interaction payloads -> error_running_gdb_command {message}", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const errs = [];
  gdb.socket.on("error_running_gdb_command", (p) => errs.push(p));
  gdb.socket.emit("run_gdb_command", null);
  gdb.socket.emit("run_gdb_command", { cmd: 5, run_token: null, request_id: 1 });
  gdb.socket.emit("run_gdb_command", { cmd: ["ok", 3], run_token: null, request_id: 1 });
  gdb.socket.emit("pty_interaction", {});
  await gdb.idle();
  assert.equal(errs.length, 4);
  for (const e of errs) assert.equal(typeof e.message, "string");
  // a bare string `cmd` is accepted like a one-element array
  const it = await send(gdb, "-list-target-features");
  assert.deepEqual(payloadOf(it), { features: [] });
});

test("pty_interaction: flush and write are acknowledged (stdin already given), set_winsize ignored, user_pty write refused", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC, { stdin: "1 2\n" });
  const user = [];
  gdb.socket.on("user_pty_response", (p) => user.push(p));
  gdb.socket.emit("pty_interaction", { data: { pty_name: "program_pty", action: "flush" } });
  gdb.socket.emit("pty_interaction", { data: { pty_name: "program_pty", key: "1 2\n\u0004", action: "write" } });
  gdb.socket.emit("pty_interaction", { data: { pty_name: "program_pty", action: "set_winsize", rows: 1, cols: 2 } });
  assert.equal(gdb.stdinReceived, "1 2\n\u0004");
  assert.equal(gdb.session.stdinFlushes, 1);
  gdb.socket.emit("pty_interaction", { data: { pty_name: "user_pty", key: "bt\n", action: "write" } });
  assert.equal(user.length, 1);
  assert.match(user[0], /not supported by the browser engine/);
});

test("path mapping (spec §12 N1): fullname = display path, file = pseudo real path; the same in bkpt, frame, stack", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const ins = await send(gdb, "-break-insert -f \"/srv/x/main_real.cpp:3\"");
  const b = payloadOf(ins).bkpt;
  assert.equal(b.fullname, "/workspace/main.cpp");
  assert.equal(b.file, "/srv/x/main_real.cpp");
  assert.equal(b["original-location"], "/srv/x/main_real.cpp:3");
  const run = await send(gdb, "-exec-run");
  const f = stopped(run).payload.frame;
  assert.deepEqual([f.fullname, f.file, f.func, f.line], ["/workspace/main.cpp", "/srv/x/main_real.cpp", "main", "3"]);
  const st = payloadOf(await send(gdb, "1-stack-list-frames")).stack;
  assert.equal(st[0].fullname, "/workspace/main.cpp");
  assert.equal(st[0].file, "/srv/x/main_real.cpp");
});

test("stopped/frame shape matches the golden sample (keys and value types)", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  await send(gdb, "-break-insert -f 3");
  const s = stopped(await send(gdb, "-exec-run")).payload;
  assert.deepEqual(Object.keys(s), ["reason", "disp", "bkptno", "frame", "thread-id", "stopped-threads", "core"]);
  assert.deepEqual(Object.keys(s.frame), ["addr", "func", "args", "file", "fullname", "line", "arch"]);
  assert.match(s.frame.addr, /^0x[0-9a-f]{16}$/);
  assert.deepEqual([s.reason, s.disp, s.bkptno, s["thread-id"], s["stopped-threads"], s.core, s.frame.arch], ["breakpoint-hit", "keep", "1", "1", "all", "0", "i386:x86-64"]);
  const n = stopped(await send(gdb, "-exec-next")).payload;
  assert.deepEqual(Object.keys(n), ["reason", "frame", "thread-id", "stopped-threads", "core"]);
  assert.equal(n.reason, "end-stepping-range");
});

test("not running: exec/stack/varobj commands answer with the GDB errors, thread-info with no threads", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  for (const c of ["-exec-continue", "-exec-next", "-exec-step", "-exec-finish", "-exec-next --reverse"]) {
    assert.deepEqual(payloadOf(await send(gdb, c)), { msg: "The program is not being run." }, c);
  }
  assert.deepEqual(payloadOf(await send(gdb, "1-thread-info")), { threads: [] });
  assert.deepEqual(payloadOf(await send(gdb, "1-stack-list-frames")), { msg: "No stack." });
  assert.deepEqual(payloadOf(await send(gdb, "1-stack-list-variables --simple-values")), { msg: "No frame selected." });
  assert.deepEqual(payloadOf(await send(gdb, "1-stack-list-arguments 1")), { msg: "No stack." });
  assert.deepEqual(payloadOf(await send(gdb, "-var-update --all-values *")), { changelist: [] });
  assert.deepEqual(payloadOf(await send(gdb, "3-var-create - * \"x\"")), { msg: "No frame selected." });
  assert.deepEqual(payloadOf(await send(gdb, "-exec-interrupt")), { msg: "Current thread is not running." });
});

test("program output: nothing before the program ends; then once, after the exit packet, LF -> CRLF (stderr appended)", async () => {
  const gdb = newGdb(smallRun({ stdout: "a\nb\n", stderr: "e\n" }), SMALL_SRC);
  const log = [];
  gdb.socket.on("program_pty_response", (p) => log.push(["pty", p]));
  gdb.socket.on("gdb_response", (p) => log.push(["resp", p.data.some((i) => i.message === "stopped" && i.payload.reason === "exited-normally")]));
  await send(gdb, "-exec-run");
  assert.deepEqual(log, [["resp", true], ["pty", "a\r\nb\r\ne\r\n"]]);
});

test("exit paths: exit code != 0, signal from a trap, and running again", async () => {
  const gdb = newGdb(smallRun({ exit: { reason: "exit", code: 3 } }), SMALL_SRC);
  const it = await send(gdb, "-exec-run");
  assert.match(it.find((x) => x.type === "console" && x.payload.includes("exited")).payload, /exited with code 03/);
  assert.deepEqual(stopped(it).payload, { reason: "exited", "exit-code": "03" });
  const g2 = newGdb(smallRun({ exit: { reason: "trap", trap: "memory", message: "oops" } }), SMALL_SRC);
  const s1 = await send(g2, "-exec-run");
  assert.equal(stopped(s1).payload.reason, "signal-received");
  assert.deepEqual([stopped(s1).payload["signal-name"], stopped(s1).payload["signal-meaning"]], ["SIGSEGV", "Segmentation fault"]);
  assert.equal(stopped(s1).payload.frame.line, "5", "the signal stop is at the last recorded step");
  const s2 = await send(g2, "-exec-continue");
  assert.equal(stopped(s2).payload.reason, "exited-signalled");
  assert.deepEqual(payloadOf(await send(g2, "-exec-continue")), { msg: "The program is not being run." });
  // -exec-run after exit starts again
  const s3 = await send(g2, "-exec-run");
  assert.equal(stopped(s3).payload.reason, "signal-received");
});

test("non-instrumented run (no steps): -exec-run just runs to the end and delivers the output", async () => {
  const gdb = newGdb(smallRun({ steps: [], instrumented: false, functions: {}, decls: {}, stdout: "plain\n" }), SMALL_SRC);
  const out = [];
  gdb.socket.on("program_pty_response", (p) => out.push(p));
  await send(gdb, "-break-insert -f 3");
  const it = await send(gdb, "-exec-run");
  assert.equal(stopped(it).payload.reason, "exited-normally");
  assert.deepEqual(out, ["plain\r\n"]);
});

test("createLocalGdb refuses a failed run and a missing result", () => {
  assert.throws(() => createLocalGdb({ source: "", runResult: smallRun({ ok: false }) }), /ok is false/);
  assert.throws(() => createLocalGdb({ source: "" }), /runResult/);
});

test("MI error paths: undefined command, known-but-unsupported command, CLI, python other than [fast], -interpreter-exec forms", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  assert.deepEqual(payloadOf(await send(gdb, "-nonsense-cmd")), { msg: "Undefined MI command: nonsense-cmd", code: "undefined-command" });
  for (const c of ["-exec-next-instruction", "-data-list-register-names", "-data-read-memory-bytes 0x0 4", "-data-disassemble -s 0 -e 1 -- 0", "-target-select remote x", "-break-watch x"]) {
    assert.match(payloadOf(await send(gdb, c)).msg, /is not supported by the browser engine$/, c);
  }
  assert.match(payloadOf(await send(gdb, "backtrace")).msg, /CLI command 'backtrace' is not supported by the browser engine/);
  assert.match(payloadOf(await send(gdb, "python print(1)")).msg, /python .* not supported by the browser engine|not supported by the browser engine/);
  assert.match(payloadOf(await send(gdb, "-interpreter-exec mi \"-list-features\"")).msg, /not supported by the browser engine/);
  assert.match(payloadOf(await send(gdb, "-interpreter-exec console \"kill\"")).msg, /not supported by the browser engine/);
});

test("initial sequence: features, target features, load commands, break-list (golden shapes)", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  const f = await send(gdb, ["-list-features", "-list-target-features"]);
  assert.deepEqual(f.map((x) => x.payload.features.length > 0), [true, false]);
  for (const need of ["reverse", "python", "pending-breakpoints", "thread-info", "frozen-varobjs", "simple-values-ref-types", "undefined-command-error-code"]) assert.ok(f[0].payload.features.includes(need), need);
  const load = await send(gdb, ["-interpreter-exec console \"delete\"", "-gdb-set exec-wrapper \"\"", "-file-exec-and-symbols \"/x/a.out\"", "-interpreter-exec console \"unset substitute-path\"", "-interpreter-exec console \"set substitute-path /a /b\"", "-break-insert -f main", "-break-list"]);
  assert.deepEqual(load.map((x) => x.type + (x.payload === "^done\r" ? "^done" : "")), ["output^done", "output^done", "output^done", "console", "output^done", "output^done", "result", "result"]);
  assert.match(load[3].payload, /^Delete all source path substitution rules\?/);
  const bl = load[7].payload.BreakpointTable;
  assert.equal(bl.nr_rows, "1");
  assert.deepEqual(bl.hdr.map((h) => h.col_name), ["number", "type", "disp", "enabled", "addr", "what"]);
  assert.equal(bl.body[0].func, "main()");
});

test("small commands: -exec-arguments, -environment-cd, -stack-info-depth, `-interpreter-exec console \"delete\"` clears the table (numbers keep counting)", async () => {
  const gdb = newGdb(smallRun(), SMALL_SRC);
  assert.deepEqual((await send(gdb, "-exec-arguments 1 2")).map((x) => x.payload), ["^done\r"]);
  assert.deepEqual((await send(gdb, "-environment-cd /tmp")).map((x) => x.payload), ["^done\r"]);
  assert.deepEqual(payloadOf(await send(gdb, "-stack-info-depth")), { msg: "No stack." });
  await send(gdb, ["-break-insert -f 2", "-break-insert -f 3"]);
  await send(gdb, "-interpreter-exec console \"delete\"");
  assert.equal(payloadOf(await send(gdb, "-break-list")).BreakpointTable.body.length, 0);
  assert.equal(payloadOf(await send(gdb, "-break-insert -f 2")).bkpt.number, "3");
  await send(gdb, "-exec-run");
  assert.deepEqual(payloadOf(await send(gdb, "-stack-info-depth")), { depth: "1" });
});
