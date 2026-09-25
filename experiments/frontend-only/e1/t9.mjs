import fs from "node:fs";
import zlib from "node:zlib";
import { compile, run } from "./driver.mjs";
import { pbdsFiles } from "./pbds.mjs";
const D = "node_modules/browsercc/dist/";
const mb = (n) => (n / 1e6).toFixed(1);
console.log("== 傳輸大小（未壓縮 → gzip-9 → brotli-11）");
let tRaw = 0, tGz = 0, tBr = 0;
for (const f of ["clang.wasm", "lld.wasm", "sysroot.tar", "clang.js", "lld.js"]) {
  const b = fs.readFileSync(D + f);
  const gz = zlib.gzipSync(b, { level: 9 }).length;
  const br = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
  tRaw += b.length; tGz += gz; tBr += br;
  console.log(f.padEnd(12), mb(b.length).padStart(6), "MB →", mb(gz).padStart(6), "→", mb(br).padStart(6));
}
// 我們額外要放進 sysroot 的東西：pb_ds、GCC 相容標頭、自備 stdc++.h/extc++.h
const extra = Buffer.from(Object.values(pbdsFiles()).join("\n") + fs.readFileSync("mine/stdc++.h", "utf8") + fs.readFileSync("mine/extc++.h", "utf8"));
const eb = zlib.brotliCompressSync(extra).length;
console.log("pb_ds + 自備標頭".padEnd(12), mb(extra.length).padStart(6), "MB →", "        ", mb(eb).padStart(6));
console.log("合計".padEnd(12), mb(tRaw + extra.length).padStart(6), "MB →", mb(tGz + eb).padStart(6), "→", mb(tBr + eb).padStart(6), "(gzip / brotli)");

console.log("\n== 記憶體（Node 行程 RSS）");
const before = process.memoryUsage().rss;
const r = await compile({ source: fs.readFileSync("lessons/tsp.cpp", "utf8"), flags: ["-std=c++20", "-fno-exceptions"] });
const peak = process.memoryUsage().rss;
console.log("編譯前", mb(before), "MB → 編譯後", mb(peak), "MB（增量", mb(peak - before), "MB）");

console.log("\n== 例外處理限制");
for (const [name, flags, src] of [
  ["try/catch，加 -fno-exceptions", ["-std=c++17", "-fno-exceptions"], "#include <iostream>\nint main(){ try { throw 1; } catch(int){ std::cout<<1; } }"],
  ["throw/catch，不加旗標", ["-std=c++17"], "#include <iostream>\nint main(){ try { throw 1; } catch(int){ std::cout<<1; } }"],
  ["vector::at 越界，加 -fno-exceptions", ["-std=c++17", "-fno-exceptions"], "#include <vector>\n#include <iostream>\nint main(){ std::vector<int> v(2); std::cout<<v.at(5); }"],
]) {
  const rr = await compile({ source: src, flags });
  if (!rr.ok) { console.log("編譯失敗 |", name, "|", rr.log.split("\n").find(l => /error/.test(l))?.replace(/^.*error: /, "")); continue; }
  const x = await run(rr.module, ""); console.log("可執行   |", name, "| exit:", String(x.exit).slice(0, 60), "| 輸出:", JSON.stringify(x.out).slice(0, 80));
}
