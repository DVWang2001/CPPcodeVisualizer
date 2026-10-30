// Probe: run the engine's own clang (-std=c++17 -fno-exceptions -O0, as the in-browser pipeline does)
// on every corpus file under tests/compile-diag/family*/ and print the raw stderr. Pins the real
// clang wording used by compileDiag / compileFamily (Task 0). Run: node tests/compile-diag/probe.mjs [name]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS, readVerified } from "../engine/node_driver.mjs";
import { Driver } from "../../gdbgui/static/engine/driver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [];
for (const fam of fs.readdirSync(here).filter((n) => n.startsWith("family")).sort())
  for (const f of fs.readdirSync(path.join(here, fam)).filter((n) => n.endsWith(".cpp")).sort())
    files.push(path.join(here, fam, f));

const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8"));
const d = new Driver({
  clangModule: await WebAssembly.compile(readVerified("clang.wasm", manifest)),
  lldModule: await WebAssembly.compile(readVerified("lld.wasm", manifest)),
  sysroot: readVerified("sysroot.tar", manifest),
  headers: readVerified("headers.tar", manifest),
});

const only = process.argv[2];
const flags = ["-std=c++17", "-fno-exceptions", "-O0"];
for (const file of files) {
  const name = path.relative(here, file);
  if (only && !name.includes(only)) continue;
  const r = await d.syntaxCheck(fs.readFileSync(file, "utf8"), { flags });
  console.log(`=== ${name} (exit ${r.code})\n${(r.err || "").trim()}\n`);
}
