// 瀏覽器版驅動：載入 clang / lld / sysroot，編譯並連結成 WebAssembly.Module。
// 可以選擇「重用已編譯的 WebAssembly.Module」建立實例（省下每個實例約 100 ms 的重新編譯）。
import { Clang, LLD, setUpSysroot } from "/node_modules/browsercc/dist/index.js";

const DIST = "/node_modules/browsercc/dist/";
export const state = { sysroot: null, clangMod: null, lldMod: null, reuse: true };

/** 冷啟動：下載並編譯編譯器。回傳各項耗時（ms）。 */
export async function loadAll() {
  const t = {};
  let t0 = performance.now();
  state.sysroot = await (await fetch(DIST + "sysroot.tar")).arrayBuffer();
  t.sysroot = performance.now() - t0;
  t0 = performance.now();
  const cr = await fetch(DIST + "clang.wasm");
  state.clangSize = cr.headers.get("content-length");
  state.clangMod = await WebAssembly.compileStreaming(cr);
  t.clangWasm = performance.now() - t0;
  t0 = performance.now();
  state.lldMod = await WebAssembly.compileStreaming(fetch(DIST + "lld.wasm"));
  t.lldWasm = performance.now() - t0;
  t.total = t.sysroot + t.clangWasm + t.lldWasm;
  return t;
}

const inst = (mod) => (imports, cb) => { WebAssembly.instantiate(mod, imports).then((i) => cb(i, mod)); return {}; };

export function makeClang(opts = {}) {
  const o = { thisProgram: "clang++", locateFile: (p) => DIST + p, ...opts };
  if (state.reuse && state.clangMod) o.instantiateWasm = inst(state.clangMod);
  return Clang(o);
}
export function makeLld(opts = {}) {
  const o = { thisProgram: "wasm-ld", locateFile: (p) => DIST + p, ...opts };
  if (state.reuse && state.lldMod) o.instantiateWasm = inst(state.lldMod);
  return LLD(o);
}

/** 用 `-###` 取得 cc1 與連結器的實際參數（跟 browsercc 的 getCompilerInvocation 一樣，但用我們的實例）。 */
async function invocation(fileName, source, flags) {
  let stderr = "";
  const clang = await makeClang({ printErr: (d) => { stderr += d + "\n"; } });
  clang.FS.writeFile(fileName, source);
  clang.FS.mkdirTree("/lib/wasm32-wasi"); clang.FS.mkdirTree("/include/c++/v1");
  clang.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
  clang.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
  const ret = clang.callMain([fileName, ...flags, "-###"]);
  if (ret !== 0) throw new Error("clang driver 失敗：" + stderr.slice(0, 300));
  const lines = stderr.split("\n");
  const getArgs = (key) => {
    const line = lines.find((l) => l.includes(key)) ?? "";
    const args = line.match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).slice(1);
    return { args, out: args[args.findIndex((a) => a === "-o") + 1] };
  };
  const cc1 = getArgs("-cc1"), ld = getArgs("wasm-ld");
  return { compilerArgs: cc1.args, compilerArtifact: cc1.out, linkerArgs: ld.args, linkerArtifact: ld.out };
}

/** 用同一個 wasm clang 建預編譯標頭。回傳 { bytes, ms }。 */
export async function buildPch(headerText, { std = "c++17", extraFiles = {} } = {}) {
  let err = "";
  const t0 = performance.now();
  const drv = await makeClang({ printErr: (d) => { err += d + "\n"; } });
  drv.FS.writeFile("pch_src.h", headerText);
  drv.FS.mkdirTree("/lib/wasm32-wasi"); drv.FS.mkdirTree("/include/c++/v1");
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
  drv.callMain(["-x", "c++-header", "pch_src.h", `-std=${std}`, "-fno-exceptions", "-o", "out.pch", "-###"]);
  const args = err.split("\n").find((l) => l.includes("-cc1")).match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).slice(1);
  let e2 = "";
  const c = await makeClang({ printErr: (d) => { e2 += d + "\n"; } });
  c.FS.writeFile("pch_src.h", headerText); setUpSysroot(c, state.sysroot, extraFiles);
  if (c.callMain(args) !== 0) throw new Error("PCH 建置失敗：" + e2.slice(0, 300));
  return { bytes: c.FS.readFile(args[args.indexOf("-o") + 1], { encoding: "binary" }), ms: performance.now() - t0 };
}

/** 編譯＋連結。回傳 { ok, module, log, t: {invocation, clangLoad, compile, lldLoad, link} }。 */
export async function compile({ source, fileName = "main.cpp", flags, extraFiles }) {
  const t = {};
  let stderr = "";
  let t0 = performance.now();
  const inv = await invocation(fileName, source, flags);
  t.invocation = performance.now() - t0;
  t0 = performance.now();
  const clang = await makeClang({ printErr: (d) => { stderr += d + "\n"; } });
  t.clangLoad = performance.now() - t0;
  clang.FS.writeFile(fileName, source);
  setUpSysroot(clang, state.sysroot, extraFiles);
  t0 = performance.now();
  let code = clang.callMain(inv.compilerArgs);
  t.compile = performance.now() - t0;
  if (code !== 0) return { ok: false, stage: "compile", log: stderr, t };
  const bin = clang.FS.readFile(inv.compilerArtifact, { encoding: "binary" });
  t0 = performance.now();
  const lld = await makeLld({ printErr: (d) => { stderr += d + "\n"; } });
  t.lldLoad = performance.now() - t0;
  lld.FS.writeFile(inv.compilerArtifact, bin);
  setUpSysroot(lld, state.sysroot, extraFiles);
  t0 = performance.now();
  code = lld.callMain(inv.linkerArgs);
  t.link = performance.now() - t0;
  if (code !== 0) return { ok: false, stage: "link", log: stderr, t };
  const out = lld.FS.readFile(inv.linkerArtifact, { encoding: "binary" });
  return { ok: true, module: await WebAssembly.compile(out), log: stderr, t, wasmBytes: out.length };
}
