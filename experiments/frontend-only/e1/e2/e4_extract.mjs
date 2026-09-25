// E4：從教案的 //@ 註解抽出所有 {表達式}（@guide、@tts），並統計語法種類。
import fs from "node:fs";
import path from "node:path";

/** 找出一段文字裡所有最外層的 {...}（括號配對），回傳 [{raw, expr, color}]。 */
export function braceTokens(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, j = i;
    for (; j < text.length; j++) { if (text[j] === "{") depth++; else if (text[j] === "}" && --depth === 0) break; }
    if (j >= text.length) break;
    const raw = text.slice(i + 1, j).trim();
    // 高亮色尾巴 {expr:lightblue}；排除 :: 與三元運算子
    const m = raw.match(/^(.*[^:]):([#A-Za-z][\w]*)$/);
    out.push({ raw, expr: m ? m[1].trim() : raw, color: m ? m[2] : null });
    i = j;
  }
  return out;
}

/** 從一份 .cpp 抽出 [{line, field, expr, color}]。 */
export function extractTokens(source) {
  const res = [];
  source.split(/\r?\n/).forEach((lineText, idx) => {
    const k = lineText.indexOf("//@");
    if (k < 0) return;
    const body = lineText.slice(k + 3);
    const parts = body.split(/@(guide|tts|layout)\b/);
    for (let p = 1; p < parts.length; p += 2) {
      const field = parts[p], value = parts[p + 1] || "";
      if (field === "layout") continue;
      for (const t of braceTokens(value)) if (t.expr) res.push({ line: idx + 1, field, expr: t.expr, color: t.color });
    }
  });
  return res;
}

/** 粗略分類，方便看語法涵蓋範圍。 */
export function shape(expr) {
  if (/^[A-Za-z_]\w*$/.test(expr)) return "變數";
  if (/^[A-Za-z_]\w*(\[[^\]]+\])+$/.test(expr)) return "索引";
  if (/^&\(/.test(expr)) return "取址 &(…)";
  if (/\.\s*\w+\s*\(/.test(expr)) return "成員函式呼叫";
  if (/^[A-Za-z_]\w*\s*\(/.test(expr)) return "函式呼叫";
  if (/[-+*/%]/.test(expr) && /^[\w\s\[\]+\-*/%().]+$/.test(expr)) return "算術／索引運算";
  return "其他";
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const LESSONS = "C:/碩士/研究/papper/CPPcodeVisualizer/examples/lessons";
  const all = [];
  for (const d of fs.readdirSync(LESSONS)) {
    const dd = path.join(LESSONS, d);
    if (!fs.statSync(dd).isDirectory()) continue;
    for (const f of fs.readdirSync(dd).filter((x) => x.endsWith(".cpp"))) {
      const toks = extractTokens(fs.readFileSync(path.join(dd, f), "utf8"));
      for (const t of toks) all.push({ ...t, lesson: d.slice(0, 12), file: f });
    }
  }
  const byShape = {};
  for (const t of all) (byShape[shape(t.expr)] ||= new Set()).add(t.expr);
  console.log("全部教案共", all.length, "個 {…} 標記，不同的表達式", new Set(all.map((t) => t.expr)).size, "種");
  for (const [s, set] of Object.entries(byShape)) console.log(" ", s.padEnd(14), String(set.size).padStart(3), "種 例:", [...set].slice(0, 6).join(" ｜ "));
  const other = [...(byShape["其他"] || [])];
  if (other.length) console.log("「其他」全部:", other.join(" ｜ "));
  const tts = all.filter((t) => t.field === "tts");
  console.log("@tts 內的標記", tts.length, "個，例:", [...new Set(tts.map((t) => t.expr))].slice(0, 12).join(" ｜ "));
}
