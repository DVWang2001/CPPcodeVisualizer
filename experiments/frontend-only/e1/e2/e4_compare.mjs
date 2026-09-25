// E4：在紀錄快照上求值 vs GDB 自己求值（標準答案）。
import fs from "node:fs";
import { dedupeSameLine } from "./dedupe.mjs";
import { evalExpr, EvalError } from "./evalexpr.mjs";

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 快照裡 char 與 std::string 都是字串；GDB 對 char 給整數（字元碼）。長度 1 的字串當作字元碼比。
const norm = (v) => (typeof v === "string" && v.length === 1 ? v.charCodeAt(0) : v);
const same = (ours, gdb) => eq(ours, gdb) || eq(norm(ours), gdb);

const cases = process.argv.slice(2).map((s) => { const [n, uninit] = s.split(":"); return { n, uninit: (uninit || "").split(",").filter(Boolean) }; });
const total = { match: 0, mismatch: 0, oursErr: 0, gdbErr: 0, bothErr: 0, charNorm: 0 };
const failures = [];
let capTotal = 0, capMatch = 0, capNotDeclared = 0; const capBad = [];
for (const { n } of cases) {
  const ours = dedupeSameLine(JSON.parse(fs.readFileSync(`trace_${n}.json`, "utf8")));
  const ref = JSON.parse(fs.readFileSync(`ref_${n}.json`, "utf8"));
  const c = { match: 0, mismatch: 0, oursErr: 0, gdbErr: 0, bothErr: 0 };
  // vector 容量：我們的偽變數 "x.capacity()" vs GDB 的 x.capacity()
  ours.forEach((s, i) => {
    const r = ref[i]; if (!r || !r.caps) return;
    for (const [nm, gv] of Object.entries(r.caps)) {
      if (!(nm in s.vars)) { capNotDeclared++; continue; }   // 變數還沒宣告：GDB 讀到的是殘留記憶體，不比
      const ov = s.vars[nm + ".capacity()"];
      capTotal++; if (ov === gv) capMatch++; else capBad.push({ n, i, line: s.line, nm, ours: ov, gdb: gv });
    }
  });
  ours.forEach((s, i) => {
    const r = ref[i]; if (!r || !r.exprs || r.line !== s.line) return;
    for (const [expr, g] of Object.entries(r.exprs)) {
      let o, oerr = null;
      try { o = evalExpr(expr, s.vars); } catch (e) { oerr = e instanceof EvalError ? e : new EvalError("crash", String(e.message)); }
      if ("err" in g) { if (oerr) c.bothErr++; else c.gdbErr++; continue; }
      if (oerr) { c.oursErr++; failures.push({ n, i, line: s.line, expr, kind: oerr.kind, why: oerr.message, gdb: JSON.stringify(g.ok).slice(0, 40) }); continue; }
      if (eq(o, g.ok)) c.match++;
      else if (same(o, g.ok)) { c.match++; total.charNorm++; }
      else { c.mismatch++; failures.push({ n, i, line: s.line, expr, kind: "mismatch", ours: JSON.stringify(o).slice(0, 40), gdb: JSON.stringify(g.ok).slice(0, 40) }); }
    }
  });
  for (const k of Object.keys(c)) total[k] += c[k];
  const sum = c.match + c.mismatch + c.oursErr;
  console.log(n.padEnd(6), "求值", String(sum).padStart(4), "次：一致", String(c.match).padStart(4), "不一致", c.mismatch, "我們求不出來", c.oursErr, "| GDB 求不出來", c.gdbErr, "兩邊都求不出來", c.bothErr, "| 成功率", ((c.match / sum) * 100).toFixed(1) + "%");
}
const sum = total.match + total.mismatch + total.oursErr;
console.log("合計 ".padEnd(6), "求值", sum, "次：一致", total.match, "（其中字元碼對照", total.charNorm, "）不一致", total.mismatch, "求不出來", total.oursErr, "| 成功率", ((total.match / sum) * 100).toFixed(2) + "%");
console.log("vector 容量（.capacity()）：比對", capTotal, "次，一致", capMatch, "，不一致", capTotal - capMatch, "（另有", capNotDeclared, "次變數尚未宣告，不比）", capBad.slice(0, 4).map((b) => JSON.stringify(b)).join(" "));
const byKind = {};
for (const f of failures) (byKind[f.kind] ||= []).push(f);
for (const [k, list] of Object.entries(byKind)) {
  console.log("\n失敗類型：" + k + "（" + list.length + " 次）");
  for (const f of list.slice(0, 5)) console.log("  ", JSON.stringify(f));
}
