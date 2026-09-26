// Differential comparison of the engine's trace against the GDB reference traces recorded on the
// production machine (experiments/frontend-only/e1/e2/ref/ref_*.json, gdbref.py: GDB 16.3 + g++ 14.2,
// -g -O0 -no-pie; tsp/grid1/deriv/rangefor2 in `next` mode, run (技巧二) in `step` mode with
// `skip -gfi /usr/include/c++/*`).
//
// This is a port of experiments/e1/e2/compare.mjs + compare_values.mjs + the capacity part of
// e4_compare.mjs as an importable library (those are CLI scripts that read process.argv at import
// time, so they cannot be imported); dedupe.mjs is imported unchanged.
//
// Closed allowed-difference list (plan §1.3, contract §5):
//   (a) GDB/g++ temporary-object noise stops  — an extra GDB stop on a function's closing `}` line
//   (b) standard-library-internal step-in     — GDB stops in a function that is not a user function
//   (c) values of uninitialised variables     — our step flags the variable (D6), GDB shows garbage
//   (d) addresses                              — pointer values
//   (e) tokens / timestamps                    — not present in these references (always 0)
// Anything else is a difference.
import fs from "node:fs";
import path from "node:path";
import { dedupeSameLine } from "../../experiments/frontend-only/e1/e2/dedupe.mjs";
import { ROOT } from "./node_driver.mjs";

const E2 = path.join(ROOT, "experiments", "frontend-only", "e1", "e2");
const LESSONS = path.join(ROOT, "examples", "lessons");
const lesson = (dir, file) => path.join(LESSONS, dir, file);

export const PROGRAMS = [
  { name: "tsp", source: lesson("技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp"), input: path.join(E2, "ref", "tsp.in"), ref: path.join(E2, "ref", "ref_tsp.json"), mode: "next" },
  { name: "grid1", source: lesson("走方格_AtCoder_Grid1", "grid_paths.cpp"), input: path.join(E2, "ref", "grid1.in"), ref: path.join(E2, "ref", "ref_grid1.json"), mode: "next" },
  { name: "deriv", source: lesson("走方格_DP推導", "grid_derivation.cpp"), input: path.join(E2, "ref", "deriv.in"), ref: path.join(E2, "ref", "ref_deriv.json"), mode: "next" },
  { name: "run", source: lesson("技巧二_記憶化搜尋_UVA10285", "longest_run.cpp"), input: path.join(E2, "ref", "run.in"), ref: path.join(E2, "ref", "ref_run.json"), mode: "step" },
  { name: "rangefor2", source: path.join(E2, "cases", "rangefor2.cpp"), input: null, ref: path.join(E2, "ref", "ref_rangefor2.json"), mode: "next" },
];

export const loadProgram = (p) => ({
  source: fs.readFileSync(p.source, "utf8"),
  stdin: p.input ? fs.readFileSync(p.input, "utf8") : "",
  ref: JSON.parse(fs.readFileSync(p.ref, "utf8")),
});

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Project our full trace onto what GDB would show for the reference's stepping mode.
 * `next` mode (gdbref.py stops when the frame is not main): only main's frame.
 * `step` mode: every user-function stop (std-library internals never appear in our trace).
 */
export function project(steps, mode) {
  const s = mode === "next" ? steps.filter((x) => x.fn === "main" && x.depth === 1) : steps;
  return dedupeSameLine(s);
}

/**
 * @param {Array<any>} ours  steps from runProgram (already merged per stop)
 * @param {Array<any>} ref   GDB reference steps
 * @param {{ mode: string, functions: Record<string, { closeLine: number }> }} ctx
 */
export function compareTraces(ours, ref, ctx) {
  const mine = project(ours, ctx.mode);
  const allowed = { a_noiseStops: 0, b_stdlibStepIn: 0, c_uninitValues: 0, d_addresses: 0, e_tokens: 0 };
  const diffs = [];
  const userFns = new Set(Object.keys(ctx.functions));
  let i = 0, j = 0, cells = 0, capCells = 0;
  while (i < mine.length || j < ref.length) {
    const s = mine[i], r = ref[j];
    if (r && r.fn !== undefined && !userFns.has(r.fn)) { allowed.b_stdlibStepIn++; j++; continue; }       // (b)
    if (s && r && s.line === r.line && (r.fn === undefined || r.fn === s.fn)) {
      for (const [name, val] of Object.entries(s.vars)) {
        if (name.endsWith(".capacity()")) continue;
        if (s.uninit && s.uninit.includes(name)) { allowed.c_uninitValues++; continue; }                 // (c)
        if (val === "<ptr>") { allowed.d_addresses++; continue; }                                          // (d)
        cells++;
        if (!Object.prototype.hasOwnProperty.call(r.vars, name)) { diffs.push({ i, line: s.line, name, why: "variable missing in GDB" }); continue; }
        if (!eq(val, r.vars[name])) diffs.push({ i, line: s.line, name, ours: JSON.stringify(val).slice(0, 80), gdb: JSON.stringify(r.vars[name]).slice(0, 80) });
      }
      if (r.caps) {
        for (const [name, gcap] of Object.entries(r.caps)) {
          if (!Object.prototype.hasOwnProperty.call(s.vars, name)) continue; // not declared yet: GDB read stale memory (e4_compare rule)
          capCells++;
          const ocap = s.vars[name + ".capacity()"];
          if (ocap !== gcap) diffs.push({ i, line: s.line, name: name + ".capacity()", ours: ocap, gdb: gcap });
        }
      }
      i++; j++;
      continue;
    }
    // (a) extra GDB stop on a closing brace of a user function
    if (r && ctx.functions[r.fn || "main"] && ctx.functions[r.fn || "main"].closeLine === r.line && !(s && s.line === r.line)) { allowed.a_noiseStops++; j++; continue; }
    diffs.push({ i, j, why: "stop sequence differs", ours: s ? `${s.fn}:${s.line}` : "(end)", gdb: r ? `${r.fn || ""}:${r.line}` : "(end)" });
    break; // after a sequence divergence the value comparison is meaningless
  }
  return {
    state: diffs.length === 0 ? "identical" : "different",
    oursStops: mine.length, gdbStops: ref.length, cells, capCells, allowed, diffs,
  };
}
