// Diagnostic: does the probe-level fflush reach stdout before the trace record is stamped?
// Runs only e2_noflush and e4_loop (original source) and prints per-record stdout attribution,
// plus whether the built headers.tar actually contains the patched vg.h.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../../gdbgui/static/engine/index.js";
import { createWasi } from "../../gdbgui/static/engine/exec.worker.js";
import { createNodeEnv } from "../../tests/engine/node_driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dec = new TextDecoder();

function tarHas(file, needle) {
  const buf = fs.readFileSync(file);
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = dec.decode(buf.subarray(off, off + 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(dec.decode(buf.subarray(off + 124, off + 136)).replace(/\0.*$/s, "").trim(), 8) || 0;
    const body = dec.decode(buf.subarray(off + 512, off + 512 + size));
    if (name.endsWith("vg.h") && body.includes(needle)) return { name, found: true };
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { found: false };
}

const assetsDir = path.join(HERE, "..", "..", "gdbgui", "static", "engine", "assets");
console.log("headers.tar contains patched vg.h:", JSON.stringify(tarHas(path.join(assetsDir, "headers.tar"), "std::fflush(stdout);")));
console.log("vg.h in engine dir patched:", fs.readFileSync(path.join(HERE, "..", "..", "gdbgui", "static", "engine", "vg.h"), "utf8").includes("std::fflush(stdout);"));

const engine = await loadEngine({ env: createNodeEnv() });
for (const f of ["e2_noflush.cpp", "e4_loop.cpp"]) {
  const src = fs.readFileSync(path.join(HERE, "programs", f), "utf8");
  const r = await engine.runProgram(src, "", { returnWasm: true });
  const module = await WebAssembly.compile(r.wasm);
  const wasi = createWasi({ stdin: new Uint8Array(0) });
  const fns = { ...wasi.imports.wasi_snapshot_preview1 };
  const stamps = [];
  const orig = fns.fd_write;
  let fd1Writes = [];
  fns.fd_write = (fd, iovs, n, p) => {
    if (fd === 3) stamps.push(wasi.sinks[1].bytes().length);
    if (fd === 1) fd1Writes.push(wasi.sinks[1].bytes().length);
    return orig(fd, iovs, n, p);
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: fns });
  wasi.bindMemory(instance.exports.memory);
  try { instance.exports._start(); } catch (e) { /* exit */ }
  const out = wasi.sinks[1].bytes();
  const trace = dec.decode(wasi.sinks[3].bytes()).split("\n").filter((l) => l.length && l.includes('"p"')).map((l) => JSON.parse(l));
  console.log(`\n## ${f}  stdout=${JSON.stringify(dec.decode(out))}  fd1 writes at stdout lengths=${JSON.stringify(fd1Writes)}`);
  trace.forEach((x, k) => {
    const a = stamps[k], b = k + 1 < stamps.length ? stamps[k + 1] : out.length;
    console.log(`  k=${k} L${x.line} stamp=${a} outAfter=${JSON.stringify(dec.decode(out.subarray(a, b)))}`);
  });
}
process.exit(0);
