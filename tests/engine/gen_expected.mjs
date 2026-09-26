// Regenerates tests/engine/expected/e3/*.txt: stdout of each E3 case compiled NATIVELY with the local
// g++ (original, uninstrumented source). These files are the fallback reference for machines
// without g++; e3.test.mjs prefers a live g++ run when g++ is installed.
// Usage: node tests/engine/gen_expected.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { e3Cases } from "./e3_cases.mjs";
import { gxxRun, gxxVersion } from "./gxx.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "expected", "e3");
const ver = gxxVersion();
if (!ver) { console.error("g++ not found"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const index = { generator: "g++ -std=c++17 -O0 (native, uninstrumented)", compiler: ver, cases: [] };
for (const c of e3Cases()) {
  const r = gxxRun(c.source, c.stdin);
  if (!r.ok) { console.log("FAIL", c.id, c.name, r.log.slice(0, 300)); continue; }
  fs.writeFileSync(path.join(OUT, c.id + ".txt"), r.stdout);
  index.cases.push({ id: c.id, name: c.name, file: path.relative(path.join(OUT, "..", "..", "..", ".."), c.file).split(path.sep).join("/"), exit: r.status, stdoutBytes: Buffer.byteLength(r.stdout) });
  console.log("ok", c.id, c.name, JSON.stringify(r.stdout.slice(0, 60)));
}
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
