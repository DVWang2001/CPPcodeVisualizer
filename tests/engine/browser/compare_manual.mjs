// 手動批次比對：node tests/engine/browser/compare_manual.mjs [results.jsonl] [gdbTag=mgdbB] [wasmTag=mwasmB]
// 逐份教案：兩個引擎的 mstep 序列（停駐行、for 段、面板文字、data-* 屬性）與終端機輸出；
// GDB 參考不穩（沒暫停過）的教案標為 "GDB 基準無效"，改看 wasm 是否跑完，並與引擎預期輸出檔（tests/engine/expected/e3）比對輸出。
import fs from "node:fs";
const F = process.argv[2] || fs.realpathSync(new URL("./autorun_results.jsonl", import.meta.url));
const GT = (process.argv[3] || "mgdbB,mgdbC,mgdbD").split(","), WT = process.argv[4] || "mwasmD"; // GDB 基準可由多個 tag 組成，每份教案取「最完整」的那一次
const rows = fs.readFileSync(F, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const one = (tag) => { const m = {}; for (const r of rows) if (r.tag === tag && r.idx !== undefined) { const e = (m[r.idx] = m[r.idx] || { steps: [], end: null }); if (r.ev === "mstep") e.steps.push(r); else if (r.ev === "end") e.end = r; } return m; };
// 多個 tag 合成基準：每份教案取「最完整」的一次，但固定亂數種子的重跑（mgdbD）有資料就優先
const by = (tag) => { if (!Array.isArray(tag)) return one(tag); const parts = tag.map((t) => [t, one(t)]); const best = {}; for (const [t, P] of parts) for (const [k, v] of Object.entries(P)) { const sc = (v.end && v.end.exited ? 1000 : 0) + v.steps.filter((x) => x.st === "paused").length; if (v.steps.length && (!best[k] || (t === "mgdbD") || (sc > best[k].sc && best[k].tag !== "mgdbD"))) best[k] = { ...v, sc, tag: t }; } return best; };
const G = by(GT), W = by(WT);
const parse = (s) => Object.fromEntries(String(s || "").split(" | ").filter(Boolean).map((p) => { const k = p.indexOf(":"); return [p.slice(0, k), p.slice(k + 1)]; }));
const names = {};
for (const r of rows) if (r.ev === "start" && r.lesson) names[r.idx] = r.lesson;
const out = [];
for (const idx of [...new Set([...Object.keys(G), ...Object.keys(W)])].map(Number).sort((a, b) => a - b)) {
  const g = G[idx] || { steps: [], end: null }, w = W[idx] || { steps: [], end: null };
  const name = String(names[idx] || (g.end && g.end.lesson) || (w.end && w.end.lesson) || "?").slice(0, 30);
  const gPaused = g.steps.filter((s) => s.st === "paused").length, wPaused = w.steps.filter((s) => s.st === "paused").length;
  const gValid = gPaused >= Math.min(5, w.steps.length) && gPaused > 0;   // GDB 參考至少真的停駐過
  const n = Math.min(g.steps.length, w.steps.length);
  let lineD = 0, subD = 0, panelD = 0, attrD = 0, unin = 0, otherLocals = 0;
  for (let i = 0; i < n; i++) {
    const a = w.steps[i], b = g.steps[i];
    if (a.line !== b.line) lineD++;
    if (a.sub !== b.sub) subD++;
    if (a.panel !== b.panel) panelD++;
    if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) attrD++;
    const pa = parse(a.locals), pb = parse(b.locals);
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[k] !== pb[k]) { if (pa[k] === "0" || pa[k] === undefined || pb[k] === undefined) unin++; else otherLocals++; }
  }
  const termG = g.end ? String(g.end.terminalTail).slice(-120) : "", termW = w.end ? String(w.end.terminalTail).slice(-120) : "";
  out.push({ idx, name, gdbSteps: g.steps.length, wasmSteps: w.steps.length, gdbEnded: !!(g.end && g.end.exited), wasmEnded: !!(w.end && w.end.exited), gValid, n, lineD, subD, panelD, attrD, unin, otherLocals, termSame: termG === termW });
}
for (const r of out) {
  const verdict = !r.wasmEnded ? "WASM-INCOMPLETE" : !r.gValid ? "GDB-BASELINE-INVALID" : (r.lineD || r.subD || r.panelD || r.attrD || r.otherLocals || !r.termSame) ? "DIFFERENT" : "IDENTICAL";
  r.verdict = verdict;
  console.log(verdict.padEnd(22), String(r.idx).padStart(2), r.name.padEnd(32), `steps g${r.gdbSteps}/w${r.wasmSteps} cmp${r.n} line≠${r.lineD} seg≠${r.subD} panel≠${r.panelD} attr≠${r.attrD} locals≠${r.otherLocals} (uninit-like ${r.unin}) out:${r.termSame ? "=" : "≠"} ended g${r.gdbEnded ? 1 : 0}/w${r.wasmEnded ? 1 : 0}`);
}
console.log("summary:", JSON.stringify(out.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {})));
