import fs from "node:fs";
import { dedupeSameLine } from "./dedupe.mjs";
const ours = dedupeSameLine(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
const ref = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const uninit = JSON.parse(process.argv[4] || "[]"); // [{name,line}] 沒有初值的宣告：宣告後第一站的值是垃圾，不比
const focus = new Set((process.argv[5] || "").split(",").filter(Boolean).map(Number));
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
let cells = 0, bad = [], ignored = 0, focusSteps = 0, focusBad = 0;
const seenFirst = new Set();
ours.forEach((s, i) => {
  const r = ref[i];
  if (!r || r.line !== s.line || (r.fn !== undefined && r.fn !== s.fn)) { bad.push({ i, why: "行不同" }); return; }
  const isFocus = focus.has(s.line); if (isFocus) focusSteps++;
  for (const [name, val] of Object.entries(s.vars)) {
    const u = uninit.find((x) => x.name === name);
    if (u && (u.all || (s.line > u.line && !seenFirst.has(name)))) { seenFirst.add(name); ignored++; continue; }
    cells++;
    if (!(name in r.vars)) { bad.push({ i, line: s.line, name, why: "GDB 沒有這個變數" }); if (isFocus) focusBad++; continue; }
    if (!eq(val, r.vars[name])) { bad.push({ i, line: s.line, name, ours: JSON.stringify(val).slice(0, 60), gdb: JSON.stringify(r.vars[name]).slice(0, 60) }); if (isFocus) focusBad++; }
  }
});
console.log(`比對 ${ours.length} 站、${cells} 個(站×變數)，忽略未初始化 ${ignored} 個 → 不一致 ${bad.length}`);
if (focus.size) console.log(`重點行 ${[...focus].join(",")}：${focusSteps} 站，其中不一致 ${focusBad}`);
for (const b of bad.slice(0, 10)) console.log("  ", JSON.stringify(b));
