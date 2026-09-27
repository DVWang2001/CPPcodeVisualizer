// 逐份教案分診：node tests/engine/browser/triage_manual.mjs <idx...>
// 對每份列出各維度第一個差異：停駐行序列、面板文字、非「未初始化」的區域變數差異、data-* 屬性差異名稱。
import fs from "node:fs";
const rows = fs.readFileSync(new URL("./autorun_results.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const pick = (tags, idx) => { let best = null; for (const t of tags) { const steps = rows.filter((r) => r.tag === t && r.idx === idx && r.ev === "mstep").sort((a, b) => a.i - b.i); const end = rows.find((r) => r.tag === t && r.idx === idx && r.ev === "end"); const sc = (end && end.exited ? 1000 : 0) + steps.filter((s) => s.st === "paused").length; if (steps.length && (!best || t === "mgdbD" || sc > best.sc) && !(best && best.tag === "mgdbD")) best = { steps, end, sc, tag: t }; } return best; }; // mgdbD（固定亂數種子的重跑）優先
const parse = (s) => Object.fromEntries(String(s || "").split(" | ").filter(Boolean).map((p) => { const k = p.indexOf(":"); return [p.slice(0, k), p.slice(k + 1)]; }));
for (const idx of process.argv.slice(2).map(Number)) {
  const g = pick(["mgdbB", "mgdbC", "mgdbD"], idx), w = pick(["mwasmD"], idx);
  console.log("=== idx", idx, "gdb", g.tag, g.steps.length, "steps ended:", g.end && g.end.exited, "| wasm", w.steps.length, "steps ended:", w.end && w.end.exited);
  console.log(" gdb lines :", g.steps.map((s) => s.line + (s.st === "paused" ? "" : "/" + s.st[0])).join(" ").slice(0, 200));
  console.log(" wasm lines:", w.steps.map((s) => s.line + (s.st === "paused" ? "" : "/" + s.st[0])).join(" ").slice(0, 200));
  const n = Math.min(g.steps.length, w.steps.length);
  let done = { panel: 0, locals: 0, attr: 0 };
  for (let i = 0; i < n; i++) {
    const a = w.steps[i], b = g.steps[i];
    if (!done.panel && a.panel !== b.panel) { done.panel = 1; let p = 0; while (p < a.panel.length && a.panel[p] === b.panel[p]) p++; console.log(" first panel diff step", i, "line", a.line, "\n   wasm:", a.panel.slice(Math.max(0, p - 25), p + 70), "\n   gdb :", b.panel.slice(Math.max(0, p - 25), p + 70)); }
    const pa = parse(a.locals), pb = parse(b.locals);
    if (!done.locals) for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[k] !== pb[k] && pa[k] !== "0" && pb[k] !== undefined && pa[k] !== undefined) { done.locals = 1; console.log(" first non-uninit locals diff step", i, "line", a.line, k, "gdb=", pb[k], "wasm=", pa[k]); break; }
    if (!done.attr && JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) { done.attr = 1; const d = []; for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) if (a.attrs[k] !== b.attrs[k]) d.push(k + ":" + b.attrs[k] + "->" + a.attrs[k]); console.log(" first attr diff step", i, d.slice(0, 6).join(", ")); }
  }
  console.log(" terminal gdb :", String(g.end && g.end.terminalTail).slice(-100)); console.log(" terminal wasm:", String(w.end && w.end.terminalTail).slice(-100));
}
