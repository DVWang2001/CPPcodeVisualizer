// E1 實驗驅動：照 browsercc 的 compile() 改成讀本機檔案，在 Node 裡編譯並用 WASI 執行。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Clang, LLD, setUpSysroot, getCompilerInvocation } from "./node_modules/browsercc/dist/index.js";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

const D = fileURLToPath(new URL("./node_modules/browsercc/dist/", import.meta.url));
const sysrootBuf = fs.readFileSync(D + "sysroot.tar");
const sysroot = sysrootBuf.buffer.slice(sysrootBuf.byteOffset, sysrootBuf.byteOffset + sysrootBuf.byteLength);

export async function compile({ source, fileName = "main.cpp", flags, extraFiles }) {
  const t0 = performance.now();
  let stderr = "";
  const opts = (n) => ({ thisProgram: n, printErr: (d) => { stderr += d + "\n"; },
    locateFile: (p) => D + p });
  const clangP = Clang(opts("clang++")); const lldP = LLD(opts("wasm-ld"));
  const inv = await getCompilerInvocation(fileName, source, flags);
  const clang = await clangP;
  const t1 = performance.now();
  clang.FS.writeFile(fileName, source);
  setUpSysroot(clang, sysroot, extraFiles);
  let code = clang.callMain(inv.compilerArgs);
  const t2 = performance.now();
  if (code !== 0) return { ok: false, stage: "compile", log: stderr, t: { load: t1 - t0, compile: t2 - t1 } };
  const bin = clang.FS.readFile(inv.compilerArtifact, { encoding: "binary" });
  const lld = await lldP;
  lld.FS.writeFile(inv.compilerArtifact, bin);
  setUpSysroot(lld, sysroot, extraFiles);
  code = lld.callMain(inv.linkerArgs);
  const t3 = performance.now();
  if (code !== 0) return { ok: false, stage: "link", log: stderr, t: { load: t1 - t0, compile: t2 - t1, link: t3 - t2 } };
  const out = lld.FS.readFile(inv.linerArtifact, { encoding: "binary" });
  const module = await WebAssembly.compile(out);
  return { ok: true, module, size: out.length, log: stderr, t: { load: t1 - t0, compile: t2 - t1, link: t3 - t2 } };
}

export async function run(module, stdinText = "", maxMs = 10000) {
  let out = "";
  const fds = [new OpenFile(new File(new TextEncoder().encode(stdinText))),
    new ConsoleStdout((d) => { out += new TextDecoder().decode(d); }),
    new ConsoleStdout((d) => { out += new TextDecoder().decode(d); })];
  const wasi = new WASI([], [], fds);
  const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const t = performance.now();
  let exit;
  try { exit = wasi.start(inst); } catch (e) { exit = "trap: " + e.message; }
  return { out, exit, ms: performance.now() - t };
}
