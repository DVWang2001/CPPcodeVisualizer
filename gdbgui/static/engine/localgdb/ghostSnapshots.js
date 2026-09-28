// Ghost pre-run call-tree snapshots (S7): the browser-engine equivalent of the real GDB backend's
// rbreak-every-function batch pre-run (gdbgui/server/prerun.py, served at /api/prerun_calltree).
// Real GDB sets a breakpoint on every function in the user's source, runs to completion, and records
// one stack snapshot (innermost first, func/addr/line/args) per breakpoint hit — one snapshot per
// function CALL. LocalGdb already has the complete trace, so it derives the identical shape directly:
// a snapshot at the trace step where each frame activation FIRST appears, which is exactly where a
// real entry breakpoint would have stopped (vg.h's `Frame` ctor — and so the activation's frame id —
// is constructed first in every instrumented function body, before its own first probe).
//
// `addr` on an OLDER frame stands in for "which of the parent's calls created the next frame down":
// its GDB `value` string of `model.retAddr(callerStepIdx, calleeFrameId)` — the exact same pseudo
// return address `-stack-list-frames`/live stepping reports for that call site (session.js's
// `frameAddr`). This is load-bearing, not cosmetic: the ghost tree and the live call tree it overlays
// are folded into the SAME callTree.ts store by signature (`sig(child) = sig(parent) + "|" +
// parent.addr + ":" + child.func`, see callTree.ts), and CallGraph.tsx only keeps showing the ghost
// once enough live signatures match it (else the overlay would flash and vanish on the very first
// step — an earlier version of this file used the child's raw activation id here, which never
// matches any live `addr` and silently made the feature inert end-to-end despite every unit test
// passing, caught only by an independent verifier driving a live session and comparing signatures).
// `retAddr` is keyed by (source line, ordinal call from that exact caller step): stable across loop
// iterations of the same call site (same address every time, matching a real compiled call
// instruction), and distinct for two different calls made from the very same step — e.g.
// `return fib(n-1) + fib(n-2);` — via the ordinal, which is exactly what tells those two children
// apart without needing any address trick specific to this file.
//
// One deliberate divergence: real GDB's stack walk isn't confined to the user's source file, so a
// snapshot can include frames above main (__libc_start_main, _start, ...) if the unwinder reaches
// them. LocalGdb's trace only ever contains user-code frames, so those never appear here — a strict
// improvement (no noise to filter), not a gap; nothing downstream expects or filters libc frames.
import { printEntry } from "./model.js";

// Matches DEFAULT_MAX_SNAPSHOTS in gdbgui/server/prerun.py — keeps the two engines' behavior
// consistent on the same rare edge case (pathologically deep/wide recursion), even though the
// reason for the cap differs (there: an unattended gdb subprocess must not run forever; here: just
// bounding response size — LocalGdb's trace itself is already capped by VG_MAX_STEPS).
const MAX_SNAPSHOTS = 300;

/**
 * @param {import("./model.js").TraceModel} model
 * @returns {Array<Array<{func: string, addr: string, line: string, args: Array<{name: string, value: string}>}>>}
 */
export function buildPrerunSnapshots(model) {
  const snaps = [];
  const seenFrame = new Set();
  for (let i = 0; i < model.steps.length && snaps.length < MAX_SNAPSHOTS; i++) {
    const fid = model.steps[i].frame;
    if (seenFrame.has(fid)) continue;
    seenFrame.add(fid);
    const chain = model.chain(i); // innermost first
    snaps.push(chain.map((f, idx) => ({
      func: f.fn,
      addr: "0x" + (idx > 0 ? model.retAddr(f.stepIdx, chain[idx - 1].frameId) : 0).toString(16),
      line: String(f.line),
      args: model.visibleVars(f.stepIdx).filter((e) => e.isArg).map((e) => ({ name: e.name, value: printEntry(model, e) })),
    })));
  }
  return snaps;
}
