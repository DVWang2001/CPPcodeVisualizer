// Check the error lessons: each lesson runs in the engine; every line that stops must carry @tts (auto-play
// rule), every @tts must start with a marker, and every @bug line must be reached.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeEngine } from "../../tests/engine/node_driver.mjs";

// same field rule as gdbgui/src/js/sourceAnnotations.ts (field keyword, value up to the next field)
function simpleAnnotations(code) {
  const out = { guide: {}, tts: {}, layout: {}, bug: {} };
  code.split("\n").forEach((line, i) => {
    const idx = line.indexOf("//@");
    if (idx === -1) return;
    const body = line.slice(idx + 3);
    const re = /@(guide|tts|layout|bug)\b/g;
    const marks = [];
    let m;
    while ((m = re.exec(body)) !== null) marks.push({ key: m[1], start: m.index, end: m.index + m[0].length });
    marks.forEach((mk, j) => {
      const e = j + 1 < marks.length ? marks[j + 1].start : body.length;
      const v = body.slice(mk.end, e).trim();
      if (v) out[mk.key][String(i + 1)] = v;
    });
  });
  return out;
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESSONS = path.join(ROOT, "examples", "lessons");
const eng = await loadNodeEngine();
const report = [];
for (const d of fs.readdirSync(LESSONS).filter((x) => x.startsWith("錯誤_")).sort()) {
  const jsonName = fs.readdirSync(path.join(LESSONS, d)).find((f) => f.endsWith(".json"));
  const bundle = JSON.parse(fs.readFileSync(path.join(LESSONS, d, jsonName), "utf8"));
  const src = bundle.source_code;
  const ann = simpleAnnotations(src);
  const r = await eng.runProgram(src, bundle.program_input || "", {});
  const stopLines = [...new Set(r.steps.map((s) => s.line))];
  const noTts = stopLines.filter((l) => !ann.tts[String(l)]);
  const badMarker = Object.entries(ann.tts).filter(([, t]) => !/^\[(next|step-in|continue)\]/.test(t)).map(([l]) => l);
  const bugLines = Object.keys(ann.bug).map(Number);
  report.push({
    lesson: d, ok: r.ok, exit: r.exit && r.exit.reason, errors: (r.errors || []).map((e) => e.kind),
    stops: r.steps.length, stopLines: stopLines.length, stdout: r.stdout,
    stopLinesWithoutTts: noTts, ttsWithoutMarker: badMarker,
    bugLines, bugReached: bugLines.filter((l) => stopLines.includes(l)), bugMissed: bugLines.filter((l) => !stopLines.includes(l)),
  });
}
console.log(JSON.stringify(report, null, 2));
eng.dispose();
