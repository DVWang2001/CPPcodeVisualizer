// S4: the vg_line_after side event carries the S3 after-state of the stop just reached.
// It is a side event (not part of gdb_response), so the golden protocol is unchanged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "../node_driver.mjs";
import { newGdb, send, frameLine } from "./helpers.mjs";

const SRC = [
  "#include <iostream>",
  "int main() {",
  "  int a = 1;",
  '  std::cout << "one" << std::endl;',
  "  int b = 2;",
  '  std::cout << "two\\n";',
  "  return a + b - 3;",
  "}",
  "",
].join("\n");

let eng, run;
before(async () => {
  eng = await loadNodeEngine();
  run = await eng.runProgram(SRC, "", {});
  assert.equal(run.ok, true, JSON.stringify(run.errors));
});
after(() => eng && eng.dispose());

test("s4: each stop reached emits vg_line_after with the line's changed variables and printed output", async () => {
  const g = newGdb(run, SRC);
  const events = [];
  g.socket.on("vg_line_after", (p) => events.push(p));
  await send(g, "-break-insert -f main");
  const r1 = await send(g, "-exec-run");
  const line1 = frameLine(r1);
  const r2 = await send(g, "-exec-next");
  const line2 = frameLine(r2);

  assert.equal(events.length, 2);
  assert.equal(events[0].line, line1);
  assert.equal(events[1].line, line2);
  // the stop at line 3 declares `a`: its line changes a from undefined to 1
  assert.equal(line1, 3);
  assert.deepEqual(events[0].after.changed, [{ name: "a", from: undefined, to: 1, existed: false }]);
  // the stop at line 4 prints "one\n" (flushed at that stop)
  assert.equal(line2, 4);
  assert.equal(events[1].stdout, "one\n");
  assert.equal(events[1].after.kind, "stop");
  assert.equal(events[1].after.line, 5);
});

test("s4: the gdb_response packets are unchanged by the side event (no vg_* key leaks into them)", async () => {
  const g = newGdb(run, SRC);
  const packets = [];
  g.socket.on("gdb_response", (p) => packets.push(p));
  await send(g, "-break-insert -f main");
  await send(g, "-exec-run");
  for (const p of packets) for (const it of p.data) assert.ok(!JSON.stringify(it).includes("vg_line_after"));
  assert.ok(packets.length >= 2);
});
