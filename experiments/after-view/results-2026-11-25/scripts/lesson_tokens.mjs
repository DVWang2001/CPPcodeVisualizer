// Lesson narration check for display "after" (docs/superpowers/plans/2026-11-25-after-view-plan.md, slice S5).
// For every lesson bundle, every annotated line (@guide / @tts; v2 inline `//@`, v1 `line_data`) that the run stops on:
// the view kind of its stops (after / call / end), what the line changed (S4 line result), and for each {token} the value
// display "before" (the state before the line ran, as live today) and "after" (the state after it ran) show. A token whose
// value differs, or narration worded as "about to" on a line that changes state, is where the text may describe the
// wrong moment.
// Runs in the builder image on lab-david (REPO=/app):
//   node lesson_tokens.mjs OUT.json [BUNDLE.json ...]    default bundles: every examples/lessons/*/*.json with source_code
//   a bundle file may also be {title, bundle} (GET /api/lessons/<id>); the title is then taken from it
import fs from "node:fs";
import path from "node:path";

const REPO = process.env.REPO || "/app";
const { loadNodeEngine } = await import(path.join(REPO, "tests/engine/node_driver.mjs"));
const { createLocalGdb } = await import(path.join(REPO, "gdbgui/static/engine/localgdb/index.js"));

const [out, ...given] = process.argv.slice(2);
const MAX_VISITS = 40; // per line: enough to see loops and recursion, bounded run time

function bundlesFrom(dir) {
  const r = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p).sort()) if (f.endsWith(".json")) r.push(path.join(p, f));
  }
  return r;
}

const unescape = (v) => v.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c));
/** `//@` fields of one line (same rules as gdbgui/src/js/sourceAnnotations.ts parseLineBody, unescaping included). */
function annotation(line) {
  const i = line.indexOf("//@");
  if (i < 0) return null;
  const body = line.slice(i + 3);
  const marks = [...body.matchAll(/@(guide|tts|layout|bug)\b/g)];
  const o = {};
  marks.forEach((m, j) => {
    const end = j + 1 < marks.length ? marks[j + 1].index : body.length;
    o[m[1]] = unescape(body.slice(m.index + m[0].length, end).trim());
  });
  return o;
}

/** Balanced {…} tokens of a text. */
function tokens(text) {
  const r = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 1, j = i + 1;
    while (j < text.length && depth > 0) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
    if (depth === 0) { r.push(text.slice(i + 1, j - 1).trim()); i = j - 1; }
  }
  return r;
}

/** Expressions a token makes the UI evaluate: the token without its :color, and the index expressions of a[i] / a[i][j]. */
function exprsOf(tok) {
  const t = tok.replace(/:[A-Za-z#][\w#-]*$/, "").trim();
  const e = [t];
  const m2 = /^([^[\]]+)\[([^[\]]+)\]\[([^[\]]+)\]$/.exec(t);
  const m1 = !m2 && /^([^[\]]+)\[([^[\]]+)\]$/.exec(t);
  if (m2) e.push(m2[2].trim(), m2[3].trim());
  if (m1) e.push(m1[2].trim());
  return [...new Set(e.filter((x) => x && !/^-?\d+$/.test(x)))];
}

function newSession(run, src, display, callEntryLines) {
  const g = createLocalGdb({ source: src, runResult: run, sourcePath: "/workspace/main.cpp", gdbFilePath: "/srv/x/main.cpp", autoConnect: false, display, callEntryLines });
  return g.session;
}
const result = (items) => items.find((x) => x && x.type === "result");
const evalIn = (s, e) => { const r = result(s.dispatch(`-data-evaluate-expression ${e}`)); return r && r.message === "done" ? String(r.payload.value) : `ERR ${r ? r.payload.msg : "?"}`; };

const eng = await loadNodeEngine();
const report = [];
const files = given.length ? given : bundlesFrom(path.join(REPO, "examples", "lessons"));
for (const file of files) {
  const t0 = Date.now();
  let b, title = path.basename(path.dirname(file));
  try { b = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { report.push({ file, error: "bad json" }); continue; }
  if (b && b.bundle && typeof b.bundle === "object") { title = b.title || title; b = b.bundle; }
  if (!b || typeof b.source_code !== "string" || !b.source_code.trim()) { report.push({ file, title, skipped: "no source_code" }); continue; }
  const src = b.source_code;
  const lines = src.split("\n");
  const ann = new Map();
  lines.forEach((l, i) => { const a = annotation(l); if (a && (a.guide || a.tts)) ann.set(i + 1, a); });
  if (b.line_data && typeof b.line_data === "object") {
    for (const [n, a] of Object.entries(b.line_data)) {
      if (!a || !(a.guide || a.tts)) continue;
      const k = Number(n), cur = ann.get(k) || {};
      ann.set(k, { ...cur, guide: cur.guide || String(a.guide || ""), tts: cur.tts || String(a.tts || "") });
    }
  }
  const callEntry = [...ann].filter(([, a]) => /\[step-in\]/.test(a.tts || "")).map(([n]) => n);
  const meta = new Map();
  for (const [n, a] of ann) {
    const toks = [...new Set([...tokens(a.guide || ""), ...tokens(a.tts || "")])];
    meta.set(n, { toks, exprs: [...new Set(toks.flatMap(exprsOf))] });
  }
  const pi = String(b.program_input || "");
  const stdin = pi ? (pi.endsWith("\n") ? pi : pi + "\n") : "";
  let run;
  for (let i = 0; i < 2 && !(run && run.ok); i++) run = await eng.runProgram(src, stdin, {});
  if (!run.ok) { report.push({ file, title, error: "run failed: " + JSON.stringify(run.errors).slice(0, 300) }); continue; }
  const bps = (b.breakpoints || []).filter((x) => x.is_normal_breakpoint !== false).map((x) => Number(x.line)).filter((x) => x > 0);
  const sess = {};
  for (const mode of ["before", "after"]) {
    const s = newSession(run, src, mode, callEntry);
    for (const c of ["-break-insert -f main", ...[...new Set(bps)].map((l) => `-break-insert -f "/srv/x/main.cpp:${l}"`), "-exec-run"]) s.dispatch(c);
    sess[mode] = s;
  }
  const visits = new Map();
  const rows = new Map();
  run.steps.forEach((st, k) => {
    const w = meta.get(st.line);
    if (!w) return;
    const v = (visits.get(st.line) || 0) + 1;
    visits.set(st.line, v);
    if (v > MAX_VISITS) return;
    let row = rows.get(st.line);
    if (!row) {
      const a = ann.get(st.line);
      row = { line: st.line, code: lines[st.line - 1].split("//@")[0].trim(), guide: a.guide || "", tts: a.tts || "", exprs: w.exprs, visits: 0, changedVisits: 0, view: {}, lineChanged: {}, output: 0, examples: [] };
      rows.set(st.line, row);
    }
    row.visits++;
    const kind = sess.after.exec.viewOf(k).kind;
    row.view[kind] = (row.view[kind] || 0) + 1;
    const la = sess.after.lineAfterOf(k);
    if (la && la.after && Array.isArray(la.after.changed)) for (const c of la.after.changed) row.lineChanged[c.name] = (row.lineChanged[c.name] || 0) + 1;
    if (la && la.stdout) row.output++;
    if (!w.exprs.length) return;
    const vals = {};
    for (const mode of ["before", "after"]) {
      const s = sess[mode];
      s.dispatch(`-vg-seek-step ${k}`);
      vals[mode] = Object.fromEntries(w.exprs.map((e) => [e, evalIn(s, e)]));
    }
    const diff = w.exprs.filter((e) => vals.before[e] !== vals.after[e]);
    if (diff.length) {
      row.changedVisits++;
      if (row.examples.length < 3) row.examples.push({ k, visit: v, view: kind, diff: diff.map((e) => ({ expr: e, before: vals.before[e].slice(0, 160), after: vals.after[e].slice(0, 160) })) });
    }
  });
  const annotatedNotStopped = [...ann.keys()].filter((n) => !rows.has(n)).sort((x, y) => x - y);
  report.push({ file: path.relative(REPO, file), title, version: b.version, steps: run.steps.length, callEntry, annotatedNotStopped, ms: Date.now() - t0, lines: [...rows.values()].sort((x, y) => x.line - y.line) });
  console.log(`${title}: ${run.steps.length} steps, ${rows.size} annotated stop lines, ${[...rows.values()].filter((r) => r.changedVisits).length} with token changes, ${Date.now() - t0} ms`);
}
eng.dispose();
fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`wrote ${out}: ${report.length} bundles`);
