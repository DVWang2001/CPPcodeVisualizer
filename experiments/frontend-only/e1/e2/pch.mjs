// E3 實驗：用 wasm 版 clang 自己建預編譯標頭（PCH），再拿來加速 AST 分析與編譯。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Clang, setUpSysroot } from "../node_modules/browsercc/dist/index.js";
const D = fileURLToPath(new URL("../node_modules/browsercc/dist/", import.meta.url));
const sb = fs.readFileSync(D + "sysroot.tar");
const sysroot = sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.byteLength);

export async function buildPch(headerText, { std = "c++17", extraFiles = {} } = {}) {
  let err = "";
  const drv = await Clang({ thisProgram: "clang++", printErr: (d) => err += d + "\n", locateFile: (p) => D + p });
  drv.FS.writeFile("pch_src.h", headerText);
  drv.FS.mkdirTree("/lib/wasm32-wasi"); drv.FS.mkdirTree("/include/c++/v1");
  drv.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0)); drv.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
  drv.callMain(["-x", "c++-header", "pch_src.h", `-std=${std}`, "-fno-exceptions", "-o", "out.pch", "-###"]);
  const cc1 = err.split("\n").find((l) => l.includes("-cc1"));
  const args = cc1.match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).slice(1);
  let e2 = "";
  const c = await Clang({ thisProgram: "clang++", printErr: (d) => e2 += d + "\n", locateFile: (p) => D + p });
  c.FS.writeFile("pch_src.h", headerText); setUpSysroot(c, sysroot, extraFiles);
  const t = performance.now();
  const code = c.callMain(args);
  const ms = performance.now() - t;
  if (code !== 0) throw new Error("PCH 建置失敗: " + e2.slice(0, 400));
  const outName = args[args.findIndex((a) => a === "-o") + 1];
  return { pch: c.FS.readFile(outName, { encoding: "binary" }), ms, args };
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vg = fs.readFileSync(new URL("./vg.h", import.meta.url), "utf8");
  const stdcpp = fs.readFileSync(new URL("../mine/stdc++.h", import.meta.url), "utf8");
  for (const [name, text] of [["常用 6 個標頭", "#include <iostream>\n#include <vector>\n#include <algorithm>\n#include <string>\n#include <map>\n#include <set>\n#include \"vg.h\"\n"], ["完整 bits/stdc++.h", "#include <bits/stdc++.h>\n#include \"vg.h\"\n"]]) {
    const r = await buildPch(text, { extraFiles: { "include/vg.h": vg, "include/bits/stdc++.h": stdcpp } });
    fs.writeFileSync(`pch_${name.includes("完整") ? "full" : "common"}.pch`, r.pch);
    console.log(name, "建置", Math.round(r.ms), "ms，PCH 大小", (r.pch.length / 1e6).toFixed(1), "MB");
  }
}
