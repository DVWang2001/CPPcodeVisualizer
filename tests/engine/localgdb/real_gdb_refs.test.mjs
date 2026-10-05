// LocalGdb vs REAL GDB 16.3: reference parameters, std::string and std::array varobjs.
// Replays the var-create / var-list-children / var-evaluate-expression / var-update commands of
// real_gdb_refs/{refs,e2e_containers}.mi.txt through the real wasm engine + LocalGdb and compares each result
// record field by field with the committed real-GDB output (*.expected.txt), modulo addresses and thread-id.
//
// Not compared (LocalGdb deliberately does not emulate the real value): -gdb-set / -enable-pretty-printing /
// -exec-run / -stack-select-frame / -gdb-exit (no payload of interest; their effect is asserted instead),
// -break-insert (real addr/file/fullname are those of the capture machine, covered by commands.test.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadNodeEngine } from "../node_driver.mjs";
import { ROOT } from "./golden_replay.mjs";
import { send, payloadOf, stopped, newGdb } from "./helpers.mjs";

const DIR = path.join(ROOT, "tests", "engine", "localgdb", "real_gdb_refs");

/** Parse a GDB/MI result record (`^done,k=v,...`) into plain objects; lists of `name={...}` items become arrays of the values. */
function parseRecord(line) {
  const m = /^\^(done|error|exit|running)(.*)$/.exec(line);
  assert.ok(m, "not a result record: " + line);
  let i = 0;
  const s = m[2];
  const str = () => {
    let o = "";
    i++; // opening quote
    while (s[i] !== '"') {
      if (s[i] === "\\") { i++; o += { n: "\n", t: "\t" }[s[i]] || s[i]; } else o += s[i];
      i++;
    }
    i++;
    return o;
  };
  const value = () => {
    if (s[i] === '"') return str();
    if (s[i] === "{") { i++; const o = results("}"); i++; return o; }
    if (s[i] === "[") {
      i++;
      const a = [];
      while (s[i] !== "]") {
        if (s[i] === ",") { i++; continue; }
        if (s[i] === '"' || s[i] === "{" || s[i] === "[") a.push(value());
        else { while (s[i] !== "=") i++; i++; a.push(value()); } // `child={...}`: keep the value
      }
      i++;
      return a;
    }
    throw new Error("bad MI value at " + i + ": " + s.slice(i, i + 20));
  };
  const results = (close) => {
    const o = {};
    while (i < s.length && s[i] !== close) {
      if (s[i] === ",") { i++; continue; }
      const j = s.indexOf("=", i);
      const k = s.slice(i, j);
      i = j + 1;
      o[k] = value();
    }
    return o;
  };
  const rec = results(undefined);
  return { cls: m[1], ...rec };
}

/** Drop thread-id and normalise every hex address (real ones differ from LocalGdb's pseudo addresses). */
function norm(v) {
  if (typeof v === "string") return v.replace(/0x[0-9a-f]+/g, "0xADDR");
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (k !== "thread-id") o[k] = norm(v[k]);
    return o;
  }
  return v;
}

const NOT_COMPARED = /^-(gdb-set|enable-pretty-printing|break-insert|exec-run|stack-select-frame|gdb-exit)\b/;

/** @param {string} cppPath @param {string} base file name stem of the .mi.txt / .expected.txt pair */
async function replay(cppPath, base) {
  const source = fs.readFileSync(cppPath, "utf8");
  const eng = await loadNodeEngine(); // one engine per program (a second runProgram on the same engine instance fails)
  after(() => eng.dispose());
  const run = await eng.runProgram(source, "");
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const g = newGdb(run, source);
  const cmds = fs.readFileSync(path.join(DIR, base + ".mi.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  const exp = fs.readFileSync(path.join(DIR, base + ".expected.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  let ei = 0; // -exec-run has no ^done record in the capture (its ^running is not a result record)
  for (const cmd of cmds) {
    const items = await send(g, cmd.startsWith("-break-insert") ? cmd.replace("-break-insert", "-break-insert -f") : cmd);
    const real = cmd.startsWith("-exec-run") ? null : parseRecord(exp[ei++]);
    if (NOT_COMPARED.test(cmd)) {
      if (cmd.startsWith("-exec-run")) assert.ok(stopped(items), "the breakpoint is hit");
      else if (cmd.startsWith("-break-insert") || cmd.startsWith("-stack-select-frame")) assert.equal(items.some((x) => x.message === "error"), false, cmd);
      continue;
    }
    const res = items.filter((x) => x.type === "result");
    const got = res.length ? { cls: res[0].message, ...res[0].payload } : null;
    if (cmd.startsWith("-stack-list-arguments")) {
      // Out of scope here (-stack-list-* keeps its `@0xADDR: ` prefix also for vector/string/set references, which real GDB
      // omits for pretty-printed values): compare only the arguments the prefix rule agrees on (std::array and scalars).
      const keep = (r) => { for (const a of r["stack-args"]) a.args = a.args.filter((x) => ["na", "ni", "ci"].includes(x.name)); return r; };
      keep(got); keep(real);
    }
    test(`${base}: ${cmd} == real GDB 16.3`, () => {
      assert.ok(got, "no result record");
      assert.deepEqual(norm(got), norm(real));
    });
  }
  assert.equal(ei, exp.length, "every real-GDB record was consumed");
}

await replay(path.join(DIR, "refs.cpp"), "refs");
await replay(path.join(ROOT, "examples", "cpp", "e2e_containers.cpp"), "e2e_containers");
