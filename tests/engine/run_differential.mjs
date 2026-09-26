// Prints the 3-state differential report (identical / different / not tested) for the 5 programs.
// Usage: node tests/engine/run_differential.mjs
import { loadNodeEngine } from "./node_driver.mjs";
import { PROGRAMS, loadProgram, compareTraces } from "./differential.mjs";

export async function runDifferential(engine) {
  const rows = [];
  for (const p of PROGRAMS) {
    let row;
    try {
      const { source, stdin, ref } = loadProgram(p);
      const r = await engine.runProgram(source, stdin);
      if (!r.ok) row = { name: p.name, state: "not tested", reason: JSON.stringify(r.errors).slice(0, 300) };
      else row = { name: p.name, stdout: r.stdout, ...compareTraces(r.steps, ref, { mode: p.mode, functions: r.functions }) };
    } catch (e) {
      row = { name: p.name, state: "not tested", reason: String(e.message) };
    }
    rows.push(row);
  }
  return rows;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("run_differential.mjs")) {
  const eng = await loadNodeEngine();
  const rows = await runDifferential(eng);
  eng.dispose();
  console.log("program    state        ours/GDB stops  value cells  capacity cells  allowed(a,b,c,d,e)  diffs");
  for (const r of rows) {
    if (r.state === "not tested") { console.log(r.name.padEnd(10), "not tested  ", r.reason); continue; }
    const a = r.allowed;
    console.log(r.name.padEnd(10), r.state.padEnd(12), `${r.oursStops}/${r.gdbStops}`.padStart(14), String(r.cells).padStart(12), String(r.capCells).padStart(15),
      `${a.a_noiseStops},${a.b_stdlibStepIn},${a.c_uninitValues},${a.d_addresses},${a.e_tokens}`.padStart(19), String(r.diffs.length).padStart(6));
    for (const d of r.diffs.slice(0, 8)) console.log("    ", JSON.stringify(d));
  }
}
