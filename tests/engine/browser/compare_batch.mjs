// 批次驗收比對：node tests/engine/browser/compare_batch.mjs [results.jsonl] [gdbTag=bgdb] [wasmTag=bwasm]
// 逐份教案比對兩個引擎在真實 UI 自動播放的結果：是否跑完、去重後停駐行序列、for 三段序列、終端機輸出、事件 LCS。
import fs from "node:fs";
const F = process.argv[2] || new URL("./autorun_results.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const GT = process.argv[3] || "bgdb", WT = process.argv[4] || "bwasm";
const rows = fs.readFileSync(F, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ends = (tag) => Object.fromEntries(rows.filter((r) => r.tag === tag && r.ev === "end").map((r) => [r.idx, r]));
const errs = (tag) => rows.filter((r) => r.tag === tag && r.ev === "error").map((r) => r.idx + ":" + r.msg.slice(0, 60));
const G = ends(GT), W = ends(WT);
const comp = (s) => { const o = []; for (const x of String(s || "").split(" ").filter(Boolean)) if (!o.length || o[o.length - 1] !== x) o.push(x); return o; };
const lcs = (a, b) => { const n = a.length, m = b.length; const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1)); for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]); return L[0][0]; };
const out = [];
for (const idx of [...new Set([...Object.keys(G), ...Object.keys(W)])].map(Number).sort((a, b) => a - b)) {
  const g = G[idx], w = W[idx]; const name = (g || w).lesson;
  if (!g || !w) { out.push({ idx, name, verdict: "MISSING " + (g ? "wasm" : "gdb") }); continue; }
  const eg = comp(g.events), ew = comp(w.events);
  const lines = (a) => a.filter((x) => x[0] === "L" || x === "EXIT"); const dd = (a) => { const o = []; for (const x of a) if (!o.length || o[o.length - 1] !== x) o.push(x); return o; };
  const lg = dd(lines(eg)), lw = dd(lines(ew));
  const seg = (a) => a.filter((x) => /^S[ABC]$/.test(x)).join("");
  const termG = String(g.terminalTail).slice(-90), termW = String(w.terminalTail).slice(-90);
  const status = (r) => r.stalled ? "stalled" : r.timedOut ? "timeout" : "exited";
  const row = { idx, name: name.slice(0, 34), gdb: status(g), wasm: status(w), stopsG: lg.length, stopsW: lw.length, lineSeqSame: lg.join(" ") === lw.join(" "), segSame: seg(eg) === seg(ew), termSame: termG === termW, evG: eg.length, evW: ew.length, lcs: lcs(eg, ew), msG: g.t, msW: w.t };
  row.verdict = row.gdb === "exited" && row.wasm === "exited" && row.lineSeqSame && row.segSame && row.termSame ? "IDENTICAL" : (row.gdb !== "exited" || row.wasm !== "exited") ? "INCOMPLETE (" + row.gdb + "/" + row.wasm + ")" : "DIFFERENT";
  out.push(row);
}
for (const r of out) console.log(String(r.verdict).padEnd(22), String(r.idx).padStart(2), (r.name || "").padEnd(36), r.stopsG !== undefined ? `stops ${r.stopsG}/${r.stopsW} seg:${r.segSame ? "=" : "≠"} out:${r.termSame ? "=" : "≠"} ev ${r.evG}/${r.evW} lcs ${r.lcs} ${(r.msG / 1000).toFixed(0)}s/${(r.msW / 1000).toFixed(0)}s` : "");
console.log("errors gdb:", errs(GT).join(" | ") || "none", "| wasm:", errs(WT).join(" | ") || "none");
console.log("summary:", JSON.stringify(out.reduce((a, r) => (a[r.verdict.split(" ")[0]] = (a[r.verdict.split(" ")[0]] || 0) + 1, a), {})));
