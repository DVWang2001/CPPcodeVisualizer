// P1 compile cost on lesson-sized programs (the 22 E3 cases), run ONLY on lab-david inside iris-preview:p1-builder
// with the P1 files mounted over /app (run_p1.sh run NAME suite-cost.sh). For each flag variant: the PCH of the
// program's includes is built first (its own 30 s budget, not timed here), then the two stages that share the 8 s
// student budget are timed separately: AST + instrument, and compile + link. Writes JSON to stdout.
//   variants: see VARIANTS (run 2).
import { pathToFileURL } from "node:url";

const REPO = "/app";
const ENGINE = REPO + "/gdbgui/static/engine";
const nd = await import(pathToFileURL(REPO + "/tests/engine/node_driver.mjs").href);
const { Driver } = await import(pathToFileURL(ENGINE + "/driver.js").href);
const { instrument } = await import(pathToFileURL(ENGINE + "/instrument.js").href);
const { LINK_FLAGS, CHECK_FLAGS, pchIncludes } = await import(pathToFileURL(ENGINE + "/pipeline.worker.js").href);
const { e3Cases } = await import(pathToFileURL(REPO + "/tests/engine/e3_cases.mjs").href);

// run 2: which checks cost the time. lean drops the checks that instrument every memory access / pointer step
// (alignment, object-size, pointer-overflow) and the attribute checks; ignAll is a diagnostic: an ignorelist that
// matches every file must make the build as cheap as plain (run 1's src:/include/* changed nothing at all)
const NOSAN = "-fno-sanitize=vptr,function";
const LEAN = "-fno-sanitize=vptr,function,alignment,object-size,pointer-overflow,nonnull-attribute,returns-nonnull-attribute";
const VARIANTS = {
  plain: { flags: [], files: {} },
  checks: { flags: [...CHECK_FLAGS], files: {} },
  lean: { flags: CHECK_FLAGS.map((f) => (f === NOSAN ? LEAN : f)), files: {} },
  leanNoNull: { flags: CHECK_FLAGS.map((f) => (f === NOSAN ? LEAN + ",null" : f)), files: {} },
  ignAll: { flags: [...CHECK_FLAGS, "-fsanitize-ignorelist=/vg-ubsan.ignore"], files: { "vg-ubsan.ignore": "src:*\n" } },
};
if (!CHECK_FLAGS.includes(NOSAN)) throw new Error("CHECK_FLAGS changed: " + CHECK_FLAGS.join(" "));
const PCH_USE = ["-Xclang", "-include-pch", "-Xclang", "/vg.pch", "-fpch-validate-input-files-content", "-Xclang", "-fmodules-validate-system-headers"];
const d = new Driver(await nd.createNodeEnv().loadAssets());
const pchs = new Map();
async function pchFor(name, incs, base) {
  const key = name + "|" + incs.join(",");
  if (pchs.has(key)) return pchs.get(key);
  const src = "#include <vg.h>\n" + incs.map((i) => `#include <${i}>\n`).join("");
  const { cc1 } = await d.commands("pch_src.h", ["-x", "c++-header", ...base, "-Xclang", "-fno-pch-timestamp", "-o", "out.pch"]);
  const t0 = performance.now();
  const r = await d.cc1(cc1, { ...VARIANTS[name].files, "pch_src.h": src }, { keep: "/out.pch" });
  if (r.code !== 0 || !r.kept) throw new Error(name + " PCH failed: " + r.err.slice(0, 600));
  const p = { files: { "vg.pch": r.kept, "pch_src.h": src }, ms: Math.round(performance.now() - t0) };
  pchs.set(key, p);
  return p;
}
const rows = [];
{ // warm-up: the first compile of a fresh driver pays V8's tier-up (run 1: plain E3 01 = 7766 ms, checks 5678 ms)
  const c = e3Cases()[0], base = ["-std=c++17", "-fno-exceptions", "-O1"];
  const ins = await instrument(d, c.source, { flags: [...base, "-include", "vg.h"], files: {} });
  await d.compileLink(ins.text, { flags: [...base, "-include", "vg.h", ...LINK_FLAGS], files: {} });
}
for (const c of e3Cases()) {
  const row = { id: c.id, name: c.name, lines: c.source.split("\n").length };
  for (const [name, v] of Object.entries(VARIANTS)) {
    const base = ["-std=c++17", "-fno-exceptions", "-O1", ...v.flags];
    const incs = pchIncludes(c.source);
    let pch = null;
    if (incs) pch = await pchFor(name, incs, base);
    const files = { ...v.files, ...(pch ? pch.files : {}) };
    const t0 = performance.now();
    const ins = await instrument(d, c.source, { flags: pch ? [...base, ...PCH_USE] : [...base, "-include", "vg.h"], files });
    const tAst = Math.round(performance.now() - t0);
    if (!ins.ok) { row[name] = { fail: "instrument", log: String(ins.log).slice(0, 300) }; continue; }
    const t1 = performance.now();
    const cl = await d.compileLink(ins.text, { flags: [...base, ...(pch ? PCH_USE : ["-include", "vg.h"]), ...LINK_FLAGS], files });
    const tCL = Math.round(performance.now() - t1);
    row[name] = cl.ok ? { pch: !!pch, pchMs: pch ? pch.ms : null, tAst, tCL, total: tAst + tCL, wasm: cl.wasm.length } : { fail: cl.stage, log: String(cl.log).slice(0, 600) };
  }
  rows.push(row);
  console.error(c.id, JSON.stringify(Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, row[k].total ?? row[k].fail]))));
}
console.log(JSON.stringify({ node: process.version, rows }));
