// E3：大型教案／放大輸入的效能量測（Node）。
import fs from "node:fs";
import path from "node:path";
import { runTrace } from "./trace.mjs";
import { dedupeSameLine } from "./dedupe.mjs";

const LESSONS = "C:/碩士/研究/papper/CPPcodeVisualizer/examples/lessons";
const rnd = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const grid = (h, w) => { const r = []; for (let i = 0; i < h; i++) { let row = ""; for (let j = 0; j < w; j++) row += rnd() < 0.15 && !(i === 0 && j === 0) && !(i === h - 1 && j === w - 1) ? "#" : "."; r.push(row); } return `${h} ${w}\n${r.join("\n")}\n`; };
const matrix = (h, w, lo, hi) => `${h} ${w}\n` + Array.from({ length: h }, () => Array.from({ length: w }, () => lo + Math.floor(rnd() * (hi - lo + 1))).join(" ")).join("\n") + "\n";
const perm = (h, w) => { const n = h * w, a = Array.from({ length: n }, (_, i) => i + 1); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return `${h} ${w}\n` + Array.from({ length: h }, (_, i) => a.slice(i * w, (i + 1) * w).join(" ")).join("\n") + "\n"; };

const dir = (prefix) => fs.readdirSync(LESSONS).find((d) => d.startsWith(prefix));
const cpp = (d, name) => { const dd = path.join(LESSONS, d); const f = name ? name : fs.readdirSync(dd).find((x) => x.endsWith(".cpp")); return fs.readFileSync(path.join(dd, f), "utf8"); };
const jsonInput = (d) => { const dd = path.join(LESSONS, d); const j = fs.readdirSync(dd).find((x) => x.endsWith(".json")); try { return JSON.parse(fs.readFileSync(path.join(dd, j), "utf8")).program_input || ""; } catch { return ""; } };

const cases = [];
const T1 = dir("技巧一"), T2 = dir("技巧二"), G1 = dir("走方格_AtCoder");
for (const [h, w] of [[5, 4], [10, 10], [20, 20]]) cases.push([`技巧一 ${h}×${w}`, cpp(T1), matrix(h, w, 1, 9)]);
for (const [h, w] of [[3, 3], [8, 8], [12, 12]]) cases.push([`技巧二 ${h}×${w}`, cpp(T2), perm(h, w)]);
for (const [h, w] of [[3, 4], [8, 8]]) cases.push([`走方格 AtCoder ${h}×${w}`, cpp(G1), grid(h, w)]);
for (const p of ["DP課1", "DP課2", "DP課3", "DP課4", "DP課5", "圖論", "stack", "deque", "string", "vector經典_排序", "vector經典_矩陣", "vector經典_", "list", "函式"]) {
  const d = dir(p); if (!d) continue;
  const dd = path.join(LESSONS, d); const cs = fs.readdirSync(dd).filter((x) => x.endsWith(".cpp"));
  for (const c of cs.slice(0, 1)) { const inp = jsonInput(d) || (fs.existsSync(path.join(dd, "input.txt")) ? fs.readFileSync(path.join(dd, "input.txt"), "utf8") : ""); cases.push([d.slice(0, 18), cpp(d, c), inp]); }
}
const only = process.argv[2];
console.log("案例".padEnd(22), "行數 步數(原/合併)  trace KB  ms: AST+插樁  編譯  執行   總計  | 備註");
for (const [name, src, inp] of cases) {
  if (only && !name.includes(only)) continue;
  const t = performance.now();
  try {
    const r = await runTrace(src, inp, { std: "c++17" });
    const total = performance.now() - t;
    if (!r.ok) { console.log(name.padEnd(22), "✗", r.stage, (r.log || "").split("\n").filter((l) => /error/.test(l)).slice(0, 1).join("").slice(0, 100)); continue; }
    const dd = dedupeSameLine(r.steps).length;
    console.log(name.padEnd(22), String(src.split("\n").length).padStart(4), (r.steps.length + "/" + dd).padStart(14), (r.traceBytes / 1024).toFixed(0).padStart(9), " ", String(Math.round(r.ms.instrument)).padStart(9), String(Math.round(r.ms.compile)).padStart(6), String(Math.round(r.ms.run)).padStart(6), String(Math.round(total)).padStart(6), "|", r.exit === 0 ? "" : "exit=" + String(r.exit).slice(0, 30));
  } catch (e) { console.log(name.padEnd(22), "✗ 例外:", String(e.message).slice(0, 110)); }
}
