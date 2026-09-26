// Contract §5 differential acceptance: the 5 programs must match the production GDB references
// with ZERO differences outside the closed allowed list (see differential.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";
import { runDifferential } from "./run_differential.mjs";

let eng, rows;
before(async () => { eng = await loadNodeEngine(); rows = await runDifferential(eng); });
after(() => eng && eng.dispose());

const EXPECTED_STDOUT = { tsp: "3 2 2 1\n6\n", grid1: "3\n", deriv: "3\n", run: "7\n", rangefor2: "81\n" };

for (const name of ["tsp", "grid1", "deriv", "run", "rangefor2"]) {
  test(`differential: ${name} is identical to the GDB reference outside the allowed list`, () => {
    const r = rows.find((x) => x.name === name);
    const a = r.allowed || {};
    console.log(`# ${name}: ${r.state}; stops ours/GDB ${r.oursStops}/${r.gdbStops}; value cells ${r.cells}; capacity cells ${r.capCells}; allowed a=${a.a_noiseStops} b=${a.b_stdlibStepIn} c=${a.c_uninitValues} d=${a.d_addresses} e=${a.e_tokens}`);
    assert.equal(r.state, "identical", JSON.stringify(r.diffs || r.reason).slice(0, 2000));
    assert.equal(r.oursStops, r.gdbStops);
    assert.ok(r.cells > 0);
    assert.equal(r.stdout, EXPECTED_STDOUT[name]);
  });
}
