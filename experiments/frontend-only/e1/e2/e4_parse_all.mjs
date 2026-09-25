// E4：全部教案的 {表達式} 我們的求值器都能「解析」嗎？（沒有 GDB 標準答案，只檢查語法涵蓋）
import fs from "node:fs";
import path from "node:path";
import { extractTokens } from "./e4_extract.mjs";
import { evalExpr, EvalError } from "./evalexpr.mjs";
const LESSONS = "C:/碩士/研究/papper/CPPcodeVisualizer/examples/lessons";
const exprs = new Set();
for (const d of fs.readdirSync(LESSONS)) {
  const dd = path.join(LESSONS, d); if (!fs.statSync(dd).isDirectory()) continue;
  for (const f of fs.readdirSync(dd).filter((x) => x.endsWith(".cpp"))) for (const t of extractTokens(fs.readFileSync(path.join(dd, f), "utf8"))) exprs.add(t.expr);
}
// 任何變數名都回傳同一個 3×3 的二維陣列：語法錯誤（syntax）或不支援（unsupported）才算「解析失敗」；型別／範圍錯誤是資料問題，不算。
const grid = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
const vars = new Proxy({}, { has: () => true, get: () => grid });
const kinds = {};
for (const e of exprs) { try { evalExpr(e, vars); kinds.ok = (kinds.ok || 0) + 1; } catch (err) { const k = err instanceof EvalError ? err.kind : "crash"; (kinds[k] ||= []).push(e); } }
console.log("不同的表達式", exprs.size, "種");
for (const [k, v] of Object.entries(kinds)) console.log(" ", k.padEnd(12), Array.isArray(v) ? v.length + " 種  例: " + v.slice(0, 4).join(" ｜ ") : v);
const bad = [...(kinds.syntax || []), ...(kinds.unsupported || []), ...(kinds.crash || [])];
console.log(bad.length ? "解析失敗 " + bad.length + " 種: " + bad.join(" ｜ ") : "→ 全部 " + exprs.size + " 種都能解析（語法涵蓋完整）");
