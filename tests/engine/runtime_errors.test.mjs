// P1 runtime errors (docs/superpowers/plans/2026-11-23-runtime-error-viz-plan.md §3): every program of the S0 corpus
// (tests/engine/runtime_errors/cases.mjs + examples/cpp/errors/*.cpp) must end the way runtime_errors/expected.json says,
// with exactly the runtime errors listed there. The expected kinds, lines and values were measured on lab-david
// (experiments/runtime-error-s0, 2026-11-23); the fatal/recoverable split is decision 2 of the plan.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeEngine } from "./node_driver.mjs";
import { CASES } from "./runtime_errors/cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXP = JSON.parse(fs.readFileSync(path.join(HERE, "runtime_errors", "expected.json"), "utf8"));
const EX_DIR = path.join(HERE, "..", "..", "examples", "cpp", "errors");
const EXAMPLES = fs.readdirSync(EX_DIR).filter((f) => f.endsWith(".cpp")).sort()
  .map((f) => ({ id: "ex_" + f.replace(/\.cpp$/, ""), label: "examples/cpp/errors/" + f, stdin: "", src: fs.readFileSync(path.join(EX_DIR, f), "utf8") }));
const ALL = [...CASES, ...EXAMPLES];

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

/** exit:<code> | trap:<category> | stack-overflow | step-limit | ... */
const exitTag = (x) => (!x ? "none" : x.reason === "exit" ? `exit:${x.code}` : x.reason === "trap" ? `trap:${x.trap}` : x.reason);

/** every key of `want` must be present in `got` with the same value (objects compared the same way, recursively) */
function contains(got, want, where) {
  for (const [k, v] of Object.entries(want)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      assert.ok(got && typeof got[k] === "object" && got[k] !== null, `${where}.${k} missing in ${JSON.stringify(got)}`);
      contains(got[k], v, `${where}.${k}`);
    } else {
      assert.deepEqual(got && got[k], v, `${where}.${k}: ${JSON.stringify(got)}`);
    }
  }
}

test("the corpus and expected.json list the same 48 programs", () => {
  assert.equal(ALL.length, 48);
  assert.deepEqual(ALL.map((c) => c.id).sort(), Object.keys(EXP).filter((k) => k !== "_note").sort());
});

test("without the runtime checks, x % 0 and INT_MIN / -1 still end as division traps (V8's wording differs from x / 0)", async () => {
  const src = "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n  int a, b;\n  cin >> a >> b;\n  cout << a % b << \" \" << a / b << endl;\n  return 0;\n}";
  for (const stdin of ["10 0\n", "-2147483648 -1\n"]) {
    const r = await eng.runProgram(src, stdin, { checks: false });
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 600));
    assert.deepEqual(r.runtimeErrors, []);
    assert.equal(exitTag(r.exit), "trap:div-zero", stdin + JSON.stringify(r.exit));
  }
});

for (const c of ALL) {
  test(`runtime errors ${c.id} (${c.label})`, async () => {
    const want = EXP[c.id];
    const r = await eng.runProgram(c.src, c.stdin ? c.stdin + "\n" : "");
    if (want.exit.startsWith("fail:")) {
      assert.equal(r.ok, false);
      assert.equal(r.errors[0].kind, want.exit.slice(5), JSON.stringify(r.errors).slice(0, 600));
      return;
    }
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 1500));
    assert.equal(exitTag(r.exit), want.exit, JSON.stringify(r.exit));
    if ("stdout" in want) assert.equal(r.stdout, want.stdout);
    assert.ok(r.steps.length > 0, "the run can be replayed");
    const got = r.runtimeErrors;
    assert.ok(Array.isArray(got), "runtimeErrors is an array");
    assert.equal(got.length, want.errors.length, JSON.stringify(got));
    want.errors.forEach((w, i) => contains(got[i], w, `runtimeErrors[${i}]`));
    for (const g of got) {
      assert.ok(Number.isInteger(g.step) && g.step >= 0 && g.step < r.steps.length, `step ${g.step}`);
      assert.equal(typeof g.message, "string");
      // an error outside the student's file (inside the library) is shown on the line of the stop that called into it
      if (!g.inUser) { assert.equal(g.line, r.steps[g.step].line); assert.equal(g.col, null); }
    }
    const last = got[got.length - 1];
    if (last && last.fatal) {
      // a fatal error ends the run: it sits on the last stop, and the exit points at it
      assert.equal(last.step, r.steps.length - 1);
      assert.equal(r.exit.runtimeError, got.length - 1);
      assert.equal(r.exit.code, null);
    }
    for (const g of got.slice(0, -1)) assert.equal(g.fatal, false, "only the last error can be fatal");
    console.log(`# ${c.id}: ${exitTag(r.exit)} steps=${r.steps.length} errors=${JSON.stringify(got.map((g) => [g.kind, g.line, g.col, g.step]))}`);
  });
}
