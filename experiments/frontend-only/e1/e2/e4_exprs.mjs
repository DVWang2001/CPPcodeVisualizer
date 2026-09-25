// 對四份教案，抽出「行號 → 表達式清單」寫成 JSON，給 gdbref.py 的 REF_EXPRS 用。
import fs from "node:fs";
import path from "node:path";
import { extractTokens } from "./e4_extract.mjs";
const LESSONS = "C:/碩士/研究/papper/CPPcodeVisualizer/examples/lessons";
const map = { tsp: "技巧一", run: "技巧二", grid1: "走方格_AtCoder", deriv: "走方格_DP推導" };
for (const [n, prefix] of Object.entries(map)) {
  const d = fs.readdirSync(LESSONS).find((x) => x.startsWith(prefix));
  const f = fs.readdirSync(path.join(LESSONS, d)).find((x) => x.endsWith(".cpp"));
  const toks = extractTokens(fs.readFileSync(path.join(LESSONS, d, f), "utf8"));
  const byLine = {};
  for (const t of toks) (byLine[t.line] ||= new Set()).add(t.expr);
  const out = Object.fromEntries(Object.entries(byLine).map(([k, v]) => [k, [...v]]));
  fs.writeFileSync(`exprs_${n}.json`, JSON.stringify(out));
  console.log(n, "行數", Object.keys(out).length, "表達式（不重複）", new Set(toks.map((t) => t.expr)).size, "標記", toks.length);
}
