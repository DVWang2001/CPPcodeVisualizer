// buildPrerunSnapshots (S7 ghost pre-run) on a real engine run: mirrors what the real GDB backend's
// rbreak-every-function batch pre-run records (gdbgui/server/prerun.py's `snaps` — one stack
// snapshot, innermost first, per function call), derived directly from the trace instead of a
// second gdb subprocess. See gdbgui/static/engine/localgdb/ghostSnapshots.js for the correspondence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "../node_driver.mjs";
import { TraceModel } from "../../../gdbgui/static/engine/localgdb/model.js";
import { buildPrerunSnapshots } from "../../../gdbgui/static/engine/localgdb/ghostSnapshots.js";
import { send, payloadOf, stopped, newGdb } from "./helpers.mjs";

// The exact sig formula from gdbgui/src/js/callTree.ts (duplicated here on purpose: that file is
// TypeScript, not reachable from this plain-Node test; see the note on the regression test below for
// why duplicating just this formula, rather than the addr values, is what actually catches the bug
// class this guards against).
function normalizeAddr(addr) {
  if (!addr) return undefined;
  const a = String(addr).toLowerCase();
  return a.startsWith("0x") ? "0x" + (a.slice(2).replace(/^0+/, "") || "0") : a;
}
/** @param {Array<{func: string, addr?: string, line?: string|number}>} stack innermost first; returns the innermost frame's sig */
function sigOf(stack) {
  const L = stack.length;
  const sigs = new Array(L);
  for (let i = L - 1; i >= 0; i--) {
    if (i === L - 1) sigs[i] = String(stack[i].func);
    else {
      const parent = stack[i + 1];
      const callSite = normalizeAddr(parent.addr) ?? parent.line ?? "";
      sigs[i] = `${sigs[i + 1]}|${callSite}:${stack[i].func}`;
    }
  }
  return sigs[0];
}

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

async function snapshotsFor(src) {
  const run = await eng.runProgram(src, "");
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const model = new TraceModel({ ...run, source: src });
  return buildPrerunSnapshots(model);
}

const FIB = `int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}
int main() {
    int r = fib(3);
    return 0;
}
`;

test("one snapshot per call (main + every fib activation), not per line", async () => {
  const snaps = await snapshotsFor(FIB);
  // fib(3) -> fib(2)+fib(1); fib(2) -> fib(1)+fib(0). Calls: main, fib(3), fib(2), fib(1), fib(0), fib(1) = 6.
  assert.equal(snaps.length, 6);
  assert.deepEqual(snaps.map((s) => s[0].func), ["main", "fib", "fib", "fib", "fib", "fib"]);
});

test("first snapshot is just [main]; each fib snapshot's chain is innermost-first ending at main", async () => {
  const snaps = await snapshotsFor(FIB);
  assert.deepEqual(snaps[0].map((f) => f.func), ["main"]);
  for (const s of snaps.slice(1)) {
    assert.equal(s[0].func, "fib");
    assert.equal(s[s.length - 1].func, "main");
  }
});

test("args carry GDB print-format values (n=3,2,1,0,1 at each fib entry)", async () => {
  const snaps = await snapshotsFor(FIB);
  const fibArgN = snaps.slice(1).map((s) => s[0].args.find((a) => a.name === "n").value);
  assert.deepEqual(fibArgN, ["3", "2", "1", "0", "1"]);
});

test("sibling calls on the same source line get distinct parent addr (fib(n-1) vs fib(n-2) don't collapse into one ghost node)", async () => {
  const snaps = await snapshotsFor(FIB);
  // fib(2)'s two children: fib(1) (snaps[3]) and fib(0) (snaps[4]) are both called from fib(2), same
  // line — their immediate parent frame (index 1 in each chain: fib(2)) must carry a DIFFERENT addr
  // per call, or callTree.ts's ingestStack would give both children the same identity.
  const parentAddrOf = (snap) => snap[1].addr; // snap[0] is the fib child itself, snap[1] is its caller
  const fib1AsChildOf2 = snaps[3]; // fib(1), first call inside fib(2)
  const fib0AsChildOf2 = snaps[4]; // fib(0), second call inside fib(2)
  assert.equal(fib1AsChildOf2[1].func, "fib"); // sanity: caller is indeed fib(2)
  assert.notEqual(parentAddrOf(fib1AsChildOf2), parentAddrOf(fib0AsChildOf2));
  // Likewise fib(3)'s own two children (fib(2) at snaps[2], fib(1) at snaps[5]) via their parent (main
  // is NOT the immediate parent here — fib(3) is; but fib(3) itself has no separate snapshot showing
  // it as a parent distinctly from its own entry, so check its addr as recorded on each child's chain).
  const fib3AddrWhenParentOfFib2 = snaps[2][1].addr; // fib(2)'s chain: [fib(2), fib(3), main]
  const fib3AddrWhenParentOfSecondFib1 = snaps[5][1].addr; // fib(1)'s chain: [fib(1), fib(3), main]
  assert.notEqual(fib3AddrWhenParentOfFib2, fib3AddrWhenParentOfSecondFib1);
});

test("addr is stable across repeated snapshots of the very same call (not used here — one snapshot per call — but the value must still be deterministic given the same trace)", async () => {
  const a = await snapshotsFor(FIB);
  const b = await snapshotsFor(FIB);
  assert.deepEqual(a, b);
});

test("non-recursive program: exactly one snapshot per call, args match the call site's values", async () => {
  const SRC = `int add(int a, int b) { return a + b; }
int main() {
    int x = add(1, 2);
    int y = add(3, 4);
    return 0;
}
`;
  const snaps = await snapshotsFor(SRC);
  assert.deepEqual(snaps.map((s) => s[0].func), ["main", "add", "add"]);
  assert.deepEqual(snaps[1][0].args.map((a) => [a.name, a.value]), [["a", "1"], ["b", "2"]]);
  assert.deepEqual(snaps[2][0].args.map((a) => [a.name, a.value]), [["a", "3"], ["b", "4"]]);
  // Two independent (non-nested) calls: distinct addr on their shared parent (main) too.
  assert.notEqual(snaps[1][1].addr, snaps[2][1].addr);
});

test("a program that never calls a user function beyond main: a single [main] snapshot", async () => {
  const snaps = await snapshotsFor("int main() { int x = 1; return 0; }\n");
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].map((f) => f.func), ["main"]);
});

// Regression: an earlier version of buildPrerunSnapshots used each child's raw activation id as its
// parent's `addr`. Every test above still passed — the snapshots were internally well-formed and
// self-consistent — but that addr never matches what a LIVE debugging session's -stack-list-frames
// reports for the same call site (session.js's frameAddr is model.retAddr, not an activation id), so
// the ghost tree's node signatures never matched the live tree's beyond `main`, and CallGraph.tsx
// (which requires most live nodes to already be present in the ghost before it trusts the ghost's
// layout) silently discarded the ghost after the very first step. Found only by an independent
// verifier driving a real session end-to-end and comparing signatures — not by any unit test, because
// every existing test compared ghost addrs only against OTHER ghost addrs, never against what live
// stepping actually produces. This test drives a real LocalGdb session (the same MI protocol the UI
// uses) through every stop and asserts every live signature was already present in the ghost.
test("every signature a live session actually visits was already present in the ghost (the property CallGraph.tsx relies on to keep showing it)", async () => {
  const run = await eng.runProgram(FIB, "");
  const model = new TraceModel({ ...run, source: FIB });
  const ghostSigs = new Set(buildPrerunSnapshots(model).map((snap) => sigOf(snap)));

  const gdb = newGdb(run, FIB);
  await send(gdb, `-break-insert -f ${run.steps[0].line}`);
  let items = await send(gdb, "-exec-run");
  const liveSigsVisited = [];
  // GDB/MI sends *stopped,reason="exited-normally" too — stopped(items) alone doesn't mean the
  // program is still running, so -stack-list-frames past that point would error ("No stack.").
  for (let guard = 0; guard < 1000; guard++) {
    const st = stopped(items);
    if (!st || /^exited/.test(st.payload.reason || "")) break;
    const stack = payloadOf(await send(gdb, "-stack-list-frames")).stack; // level 0 = innermost, matches sigOf's expected order
    liveSigsVisited.push(sigOf(stack));
    items = await send(gdb, "-exec-step");
  }
  assert.ok(liveSigsVisited.length >= 6, "sanity: the session should have visited at least as many stops as fib(3) has calls");
  for (const sig of liveSigsVisited) {
    assert.ok(ghostSigs.has(sig), `live signature not covered by the ghost: ${sig}\nghost has: ${[...ghostSigs].join(", ")}`);
  }
});

test("a loop calling the same function from the same call site: one ghost node, not one per iteration (matches a real compiled call instruction's fixed address)", async () => {
  const SRC = `int sq(int x) { return x * x; }
int main() {
    int s = 0;
    for (int i = 0; i < 4; i++) s += sq(i);
    return 0;
}
`;
  const snaps = await snapshotsFor(SRC);
  const sqSnaps = snaps.filter((s) => s[0].func === "sq");
  assert.equal(sqSnaps.length, 4, "sanity: the loop really did call sq 4 times");
  // Each call's caller (main) must report the SAME addr for this one call site across iterations —
  // that's what lets ingestStack fold all 4 activations into a single persistent ghost node, the way
  // a real compiled loop body (one `call` instruction, same address every iteration) would.
  const callerAddrs = new Set(sqSnaps.map((s) => s[1].addr));
  assert.equal(callerAddrs.size, 1, `expected one call-site addr across loop iterations, got: ${[...callerAddrs].join(", ")}`);
  const sigs = new Set(sqSnaps.map((s) => sigOf(s)));
  assert.equal(sigs.size, 1, "all 4 iterations must collapse to one ghost node signature");
});
