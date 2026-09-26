// The 22 E3 benchmark cases (experiments/frontend-only/e1/e2/e3_bench.mjs), rebuilt with the same
// deterministic generator (LCG seed 12345, same call order) so inputs are identical to E3's.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./node_driver.mjs";

const LESSONS = path.join(ROOT, "examples", "lessons");

export function e3Cases() {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const grid = (h, w) => { const r = []; for (let i = 0; i < h; i++) { let row = ""; for (let j = 0; j < w; j++) row += rnd() < 0.15 && !(i === 0 && j === 0) && !(i === h - 1 && j === w - 1) ? "#" : "."; r.push(row); } return `${h} ${w}\n${r.join("\n")}\n`; };
  const matrix = (h, w, lo, hi) => `${h} ${w}\n` + Array.from({ length: h }, () => Array.from({ length: w }, () => lo + Math.floor(rnd() * (hi - lo + 1))).join(" ")).join("\n") + "\n";
  const perm = (h, w) => { const n = h * w, a = Array.from({ length: n }, (_, i) => i + 1); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return `${h} ${w}\n` + Array.from({ length: h }, (_, i) => a.slice(i * w, (i + 1) * w).join(" ")).join("\n") + "\n"; };
  const dir = (prefix) => fs.readdirSync(LESSONS).find((d) => d.startsWith(prefix));
  const cppPath = (d, name) => { const dd = path.join(LESSONS, d); return path.join(dd, name || fs.readdirSync(dd).find((x) => x.endsWith(".cpp"))); };
  const jsonInput = (d) => { const dd = path.join(LESSONS, d); const j = fs.readdirSync(dd).find((x) => x.endsWith(".json")); try { return JSON.parse(fs.readFileSync(path.join(dd, j), "utf8")).program_input || ""; } catch { return ""; } };
  const cases = [];
  const T1 = dir("技巧一"), T2 = dir("技巧二"), G1 = dir("走方格_AtCoder");
  for (const [h, w] of [[5, 4], [10, 10], [20, 20]]) cases.push({ name: `技巧一 ${h}x${w}`, file: cppPath(T1), stdin: matrix(h, w, 1, 9) });
  for (const [h, w] of [[3, 3], [8, 8], [12, 12]]) cases.push({ name: `技巧二 ${h}x${w}`, file: cppPath(T2), stdin: perm(h, w) });
  for (const [h, w] of [[3, 4], [8, 8]]) cases.push({ name: `走方格AtCoder ${h}x${w}`, file: cppPath(G1), stdin: grid(h, w) });
  for (const p of ["DP課1", "DP課2", "DP課3", "DP課4", "DP課5", "圖論", "stack", "deque", "string", "vector經典_排序", "vector經典_矩陣", "vector經典_", "list", "函式"]) {
    const d = dir(p); if (!d) continue;
    const dd = path.join(LESSONS, d);
    const c = fs.readdirSync(dd).filter((x) => x.endsWith(".cpp"))[0];
    const inp = jsonInput(d) || (fs.existsSync(path.join(dd, "input.txt")) ? fs.readFileSync(path.join(dd, "input.txt"), "utf8") : "");
    cases.push({ name: d.slice(0, 18), file: path.join(dd, c), stdin: inp });
  }
  return cases.map((c, i) => ({ ...c, id: String(i + 1).padStart(2, "0"), source: fs.readFileSync(c.file, "utf8") }));
}
