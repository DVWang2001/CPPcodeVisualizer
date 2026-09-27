// 22 份教案的最終分類表：node tests/engine/browser/report_lessons.mjs
// 每份教案（GDB 基準 vs wasm，各 30 步手動單步＋continue 到結束）依「原因」分類，而不是只看是否逐字相同：
//   行序列、程式輸出（真正的行為）、區域變數（排除未初始化）、幽靈呼叫樹（data-ghost）、容器種類是否都畫得出來、其餘視為時序差異。
import fs from "node:fs";
const rows = fs.readFileSync(new URL("./autorun_results.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const one = (tag) => { const m = {}; for (const r of rows) if (r.tag === tag && r.idx !== undefined) { const e = (m[r.idx] = m[r.idx] || { steps: [], end: null }); if (r.ev === "mstep") e.steps.push(r); else if (r.ev === "end") e.end = r; } return m; };
const GT = ["mgdbB", "mgdbC", "mgdbD"];
const gbest = (idx) => { let best = null; for (const t of GT) { const v = one(t)[idx]; if (!v || !v.steps.length) continue; const sc = (v.end && v.end.exited ? 1000 : 0) + v.steps.filter((x) => x.st === "paused").length; if (!best || t === "mgdbD" || (sc > best.sc && best.tag !== "mgdbD")) best = { ...v, sc, tag: t }; } return best; };
const W = one("mwasmD");
const names = {}; for (const r of rows) if (r.ev === "start" && r.lesson) names[r.idx] = r.lesson;
const parse = (s) => Object.fromEntries(String(s || "").split(" | ").filter(Boolean).map((p) => { const k = p.indexOf(":"); return [p.slice(0, k), p.slice(k + 1)]; }));
const KINDS = /\b(vector|queue|stack|list|deque|map|set|priority_queue)\b/g;
const collapse = (steps) => { const o = []; for (const s of steps) { if (s.st !== "paused" || s.line == null) continue; if (s.sub && s.sub.includes('"seg":"B"')) continue; if (o.length && o[o.length - 1] === s.line) continue; o.push(s.line); } return o; };
const out = [];
for (const idx of Object.keys(W).map(Number).sort((a, b) => a - b)) {
  if (!names[idx]) continue;
  const w = W[idx], g = gbest(idx);
  const row = { idx, name: names[idx].split("/")[0].slice(0, 22) };
  row.wasmEnds = !!(w.end && w.end.exited);
  const gValid = g && g.steps.length >= 3 && g.steps.filter((s) => s.st === "paused").length >= Math.min(w.steps.length, 8);
  if (!gValid) { row.verdict = row.wasmEnds ? "GDB 基準無效（wasm 正常跑完）" : "GDB 基準無效，wasm 未跑完"; out.push(row); continue; }
  const cw = collapse(w.steps), cg = collapse(g.steps);
  const n = Math.min(cw.length, cg.length);
  let k = 0; while (k < n && cw[k] === cg[k]) k++;
  row.lines = k === n ? "相同" : `第${k + 1}停不同`;
  row.output = g.end && w.end && String(g.end.terminalTail).slice(-90) === String(w.end.terminalTail).slice(-90) ? "相同" : g.end && g.end.exited ? "不同" : "GDB 未結束";
  let realLocals = 0; const nn = Math.min(g.steps.length, w.steps.length);
  for (let i = 0; i < nn; i++) { const pa = parse(w.steps[i].locals), pb = parse(g.steps[i].locals); for (const kk of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[kk] !== pb[kk] && pa[kk] !== undefined && pb[kk] !== undefined && pa[kk] !== "0" && !/^<error|^0x|^@0x/.test(pb[kk]) && !/^\d{5,}$/.test(pb[kk]) && !/^-?\d{5,}$/.test(pb[kk])) realLocals++; }
  row.locals = realLocals ? realLocals + " 處非垃圾值差異" : "無（僅未初始化）";
  const ghost = g.steps.some((s) => s.attrs && s.attrs["data-ghost"]) && !w.steps.some((s) => s.attrs && s.attrs["data-ghost"]);
  const kindSet = (steps) => new Set(steps.flatMap((s) => (String(s.panel).match(KINDS) || [])));
  const kg = kindSet(g.steps), kw = kindSet(w.steps); const missing = [...kg].filter((x) => !kw.has(x));
  row.ghost = ghost ? "GDB 有、wasm 無" : "-"; row.containers = missing.length ? "wasm 缺：" + missing.join("、") : "齊全";
  row.verdict = (row.lines === "相同" && row.output !== "不同" && row.locals.startsWith("無")) ? (missing.length || ghost ? "行為相同；有功能缺口" : "相同") : "有行為差異，需查";
  out.push(row);
}
const pad = (s, n) => String(s).padEnd(n);
for (const r of out) console.log(pad(r.idx, 3), pad(r.name, 24), pad(r.verdict, 26), r.lines ? `行:${r.lines} 輸出:${r.output} 區域變數:${r.locals} 幽靈樹:${r.ghost} 容器:${r.containers}` : "");
const c = {}; for (const r of out) c[r.verdict] = (c[r.verdict] || 0) + 1; console.log(JSON.stringify(c));
