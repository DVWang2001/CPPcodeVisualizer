// 用 wasm 版 clang 取得 main.cpp 的 AST（JSON）。只取主檔案的頂層宣告。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Clang, setUpSysroot, tarContents } from "../node_modules/browsercc/dist/index.js";
const D = fileURLToPath(new URL("../node_modules/browsercc/dist/", import.meta.url));
const sb = fs.readFileSync(D + "sysroot.tar");
const sysroot = sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.byteLength);

export async function astOf(source, { std = "c++17", filter = null, extraFiles = {} } = {}) {
  let err = "";
  const drv = await Clang({ thisProgram: "clang++", printErr: (d) => err += d + "\n", locateFile: (p) => D + p });
  drv.FS.writeFile("main.cpp", source);
  drv.FS.mkdirTree("/lib/wasm32-wasi"); drv.FS.mkdirTree("/include/c++/v1");
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
  const flags = [`-std=${std}`, "-fno-exceptions", "-fsyntax-only", "-Xclang", "-ast-dump=json", ...(filter ? ["-Xclang", `-ast-dump-filter=${filter}`] : [])];
  drv.callMain(["main.cpp", ...flags, "-###"]);
  const cc1 = err.split("\n").find((l) => l.includes("-cc1"));
  const args = cc1.match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).slice(1);
  let out = "", err2 = "";
  const c = await Clang({ thisProgram: "clang++", print: (d) => out += d + "\n", printErr: (d) => err2 += d + "\n", locateFile: (p) => D + p });
  c.FS.writeFile("main.cpp", source);
  setUpSysroot(c, sysroot, extraFiles);
  const code = c.callMain(args);
  return { code, out, err: err2 };
}
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const src = fs.readFileSync(process.argv[2], "utf8");
  const t = performance.now();
  const r = await astOf(src, { filter: process.argv[3] || null });
  console.log("exit", r.code, "輸出", (r.out.length / 1e6).toFixed(2), "MB", "耗時", (performance.now() - t).toFixed(0), "ms", r.err.slice(0, 200));
  fs.writeFileSync("ast_out.json", r.out);
}
