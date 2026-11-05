// @ts-check
// S3: what a stop's line DID — the variables it changed and the output it printed.
//
// A stop records the state BEFORE its line runs (GDB semantics). The state after the line is the next
// stop in the same activation (same frame, depth not deeper): any deeper stops in between are callees
// of that line. Output printed by the line is the stdout between this stop's stamp and the next stop's
// stamp (S1 stepOffsets; S2 makes that attribution per line). Pure functions, no UI, no I/O.
//
// Known limit (documented, test-pinned in s2_flush): output a caller prints AFTER a call returns is
// stamped before the caller's next stop, so it lands in the callee's last stop's segment.

/**
 * @typedef {{ line: number, fn: string, depth: number, frame: number, vars: Record<string, any>, uninit?: string[] }} Step
 * @typedef {{ out: number | null, err: number | null }} Offset
 * @typedef {{ name: string, from: any, to: any, existed: boolean }} VarChange
 * @typedef {{ kind: "stop", line: number, changed: VarChange[] }
 *   | { kind: "frame-exit", changed: VarChange[] }
 *   | { kind: "program-end", changed: VarChange[] }
 *   | { kind: "unfinished", reason: string, changed: VarChange[] }} AfterState
 * @typedef {{ k: number, line: number, fn: string, depth: number, frame: number, after: AfterState, stdout: string | null, stderr: string | null }} LineResult
 */

/** @param {Step[]} steps @param {number} k @returns {number} index of the next stop in the same activation, or -1 */
export function nextInFrame(steps, k) {
  const frame = steps[k].frame, depth = steps[k].depth;
  for (let j = k + 1; j < steps.length; j++) {
    if (steps[j].frame === frame && steps[j].depth <= depth) return j;
  }
  return -1;
}

/**
 * @param {Record<string, any>} before @param {Record<string, any>} after
 * @returns {VarChange[]}
 */
export function diffVars(before, after) {
  /** @type {VarChange[]} */
  const out = [];
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const name of names) {
    const had = Object.prototype.hasOwnProperty.call(before || {}, name);
    const has = Object.prototype.hasOwnProperty.call(after || {}, name);
    if (had && has && JSON.stringify(before[name]) === JSON.stringify(after[name])) continue;
    if (!had && !has) continue;
    out.push({ name, from: had ? before[name] : undefined, to: has ? after[name] : undefined, existed: had });
  }
  return out;
}

/**
 * @param {Uint8Array | null} bytes @param {number | null | undefined} from @param {number | null | undefined} to
 * @returns {string | null}
 */
function slice(bytes, from, to) {
  if (!bytes || typeof from !== "number" || typeof to !== "number") return null;
  return new TextDecoder().decode(bytes.subarray(from, to));
}

/**
 * Per stop: what its line changed and printed.
 * @param {{ steps: Step[], stepOffsets: Offset[], stdout: Uint8Array, stderr: Uint8Array, exit: { reason: string } | null }} run
 * @returns {LineResult[]}
 */
export function afterStates(run) {
  const { steps, stepOffsets, stdout, stderr, exit } = run;
  const n = steps.length;
  /** @type {LineResult[]} */
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = steps[k];
    const j = nextInFrame(steps, k);
    /** @type {AfterState} */
    let after;
    if (j !== -1) {
      after = { kind: "stop", line: steps[j].line, changed: diffVars(s.vars, steps[j].vars) };
    } else if (exit && exit.reason !== "exit") {
      after = { kind: "unfinished", reason: exit.reason, changed: [] };
    } else if (s.depth === 1) {
      after = { kind: "program-end", changed: [] };
    } else {
      after = { kind: "frame-exit", changed: [] };
    }
    const here = stepOffsets[k];
    const next = k + 1 < n ? stepOffsets[k + 1] : null;
    const outBytes = stdout ? slice(stdout, here && here.out, next ? next.out : stdout.length) : null;
    const errBytes = stderr ? slice(stderr, here && here.err, next ? next.err : stderr.length) : null;
    out.push({ k, line: s.line, fn: s.fn, depth: s.depth, frame: s.frame, after, stdout: outBytes, stderr: errBytes });
  }
  return out;
}
