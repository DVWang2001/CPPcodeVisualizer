// `-vg-cell-last-write VAR ROW COL [BEFORE]`: the last step before BEFORE that wrote VAR[ROW][COL] (live-quiz heatmap
// "jump to the step that filled this cell"). Experiment: experiments/quiz-jump-c0/.
//   1. assignment: the last stop whose source line (comments stripped) is `VAR[a][b] <op>= ...` and whose index
//      expressions, evaluated in THAT stop's frame by the engine's own evaluator, are (ROW, COL). Catches writes of an
//      unchanged value (dp[2][1] = max(0, 0)).
//   2. value-change: only when no assignment exists (a cell filled by its declaration): the last stop j with
//      steps[j+1].vars[VAR][ROW][COL] !== steps[j].vars[VAR][ROW][COL].
// Plain ES module, no DOM / Node APIs.

/** @param {string} v */
const assignRe = (v) => new RegExp(`\\b${v}\\s*\\[([^\\]]+)\\]\\s*\\[([^\\]]+)\\]\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)`);

/**
 * @param {import("./session.js").LocalGdbSession} s
 * @param {string} name @param {number} row @param {number} col @param {number} before exclusive upper step index
 * @returns {{ step: number, line: number, how: "assignment" | "value-change" } | null}
 */
export function findCellLastWrite(s, name, row, col, before) {
  const S = s.model.steps, src = String(s.opts.source || "").split("\n");
  const re = assignRe(name);
  const ex = s.exec, keep = { pos: ex.pos, disp: ex.disp, landed: ex.landed, selectedLevel: ex.selectedLevel };
  const evalIn = (e) => {
    const r = s.vars.evaluate(e, null);
    return r.message === "done" ? Number(r.payload.value) : NaN;
  };
  try {
    for (let j = Math.min(before, S.length) - 1; j >= 0; j--) {
      const m = re.exec((src[S[j].line - 1] || "").replace(/\/\/.*$/, ""));
      if (!m) continue;
      ex._stopAt(j, "step"); // evaluate in step j's frame (restored below)
      if (evalIn(m[1]) === row && evalIn(m[2]) === col) return { step: j, line: S[j].line, how: "assignment" };
    }
  } finally { Object.assign(ex, keep); }
  const cell = (k) => { const g = S[k] && S[k].vars[name]; return Array.isArray(g) && Array.isArray(g[row]) ? g[row][col] : undefined; };
  for (let j = Math.min(before, S.length - 1) - 1; j >= 0; j--) {
    if (JSON.stringify(cell(j + 1)) !== JSON.stringify(cell(j))) return { step: j, line: S[j].line, how: "value-change" };
  }
  return null;
}
