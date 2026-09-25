// E3：記憶體峰值（RSS）與 PCH 壓縮後大小。
import fs from "node:fs";
import zlib from "node:zlib";
import { runTrace } from "./trace.mjs";

const mb = (n) => (n / 1e6).toFixed(0);
const NL = String.fromCharCode(10);
const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const matrix = (h, w) => h + " " + w + NL + Array.from({ length: h }, () => Array.from({ length: w }, () => 1 + Math.floor(rnd() * 9)).join(" ")).join(NL) + NL;

let peak = process.memoryUsage().rss;
const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
const before = process.memoryUsage().rss;
console.log("起始 RSS", mb(before), "MB");
const src = fs.readFileSync("../lessons/tsp.cpp", "utf8");
for (const [h, w] of [[5, 4], [20, 20]]) {
  peak = 0;
  const t = performance.now();
  const r = await runTrace(src, matrix(h, w), {});
  console.log("技巧一 " + h + "×" + w, "步數", r.steps.length, "耗時", Math.round(performance.now() - t), "ms  RSS 峰值", mb(peak), "MB");
}
clearInterval(iv);

console.log(NL + "== PCH 大小（未壓縮 → gzip → brotli）");
for (const f of ["pch_common.pch", "pch_full.pch"]) {
  const b = fs.readFileSync(f);
  const gz = zlib.gzipSync(b, { level: 9 }).length;
  const br = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
  console.log(f.padEnd(16), (b.length / 1e6).toFixed(1), "MB →", (gz / 1e6).toFixed(1), "→", (br / 1e6).toFixed(1));
}
process.exit(0);
