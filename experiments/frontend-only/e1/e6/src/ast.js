// 瀏覽器版 astOf：跟 e2/ast.mjs 相同，但用瀏覽器驅動（sysroot 與已編譯模組由 driver.js 快取）。
import { setUpSysroot } from "/node_modules/browsercc/dist/index.js";
import { state, makeClang } from "./driver.js";

export async function astOf(source, { std = "c++17", filter = null, extraFiles = {}, flags: extraFlags = [] } = {}) {
  let err = "";
  const drv = await makeClang({ printErr: (d) => { err += d + "\n"; } });
  drv.FS.writeFile("main.cpp", source);
  drv.FS.mkdirTree("/lib/wasm32-wasi"); drv.FS.mkdirTree("/include/c++/v1");
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
  const flags = [`-std=${std}`, "-fno-exceptions", "-fsyntax-only", "-Xclang", "-ast-dump=json", ...extraFlags, ...(filter ? ["-Xclang", `-ast-dump-filter=${filter}`] : [])];
  drv.callMain(["main.cpp", ...flags, "-###"]);
  const cc1 = err.split("\n").find((l) => l.includes("-cc1"));
  const args = cc1.match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).slice(1);
  let out = "", err2 = "";
  const c = await makeClang({ print: (d) => { out += d + "\n"; }, printErr: (d) => { err2 += d + "\n"; } });
  c.FS.writeFile("main.cpp", source);
  setUpSysroot(c, state.sysroot, extraFiles);
  const code = c.callMain(args);
  return { code, out, err: err2 };
}
