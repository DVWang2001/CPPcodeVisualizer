// E3：clang.wasm 每次建立實例的成本——重新編譯位元組碼 vs 重用已編譯的 WebAssembly.Module。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Clang, LLD } from "../node_modules/browsercc/dist/index.js";
const D = fileURLToPath(new URL("../node_modules/browsercc/dist/", import.meta.url));
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const clangBytes = fs.readFileSync(D + "clang.wasm");
const t0 = performance.now();
const clangMod = await WebAssembly.compile(clangBytes);
console.log("WebAssembly.compile(clang.wasm 42.6MB):", Math.round(performance.now() - t0), "ms（一次性；瀏覽器可快取，之後不用再編譯）");

const locateFile = (p) => D + p;
const N = 5;
const normal = [], reuse = [];
for (let i = 0; i < N; i++) {
  let t = performance.now();
  await Clang({ thisProgram: "clang++", locateFile });
  normal.push(performance.now() - t);
  t = performance.now();
  await Clang({ thisProgram: "clang++", locateFile, instantiateWasm(imports, cb) { WebAssembly.instantiate(clangMod, imports).then((inst) => cb(inst, clangMod)); return {}; } });
  reuse.push(performance.now() - t);
}
console.log("建立 Clang 實例（每次重新編譯位元組碼）中位數", Math.round(med(normal)), "ms 每次:", normal.map(Math.round).join(", "));
console.log("建立 Clang 實例（重用已編譯的 Module） 中位數", Math.round(med(reuse)), "ms 每次:", reuse.map(Math.round).join(", "));
