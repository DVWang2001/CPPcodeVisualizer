// Reads the fast-forward script template out of gdbgui/src/js/fastForwardJump.ts (TEXT, not imported: it is
// TypeScript) and rebuilds the command exactly like buildJumpCommand does. Used to lock decision D11:
// LocalGdb parses the `python exec(...)` command text, so the parser and the UI template must stay in sync.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./golden_replay.mjs";

export const TS_FILE = path.join(ROOT, "gdbgui", "src", "js", "fastForwardJump.ts");

/** @returns {{ lines: string[], begin: string, end: string, defaultLimit: number }} */
export function readTemplate(file = TS_FILE) {
  const ts = fs.readFileSync(file, "utf8");
  const m = /const JUMP_SCRIPT = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(ts);
  if (!m) throw new Error("fastForwardJump.ts: `const JUMP_SCRIPT = [...].join(\"\\n\")` not found — the template changed shape; update LocalGdb's parser and this helper");
  const lines = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse('"' + x[1] + '"'));
  const b = /export const FF_BEGIN = "([^"]*)"/.exec(ts), e = /export const FF_END = "([^"]*)"/.exec(ts), l = /export const JUMP_STEP_LIMIT = (\d+)/.exec(ts);
  if (!b || !e || !l) throw new Error("fastForwardJump.ts: FF_BEGIN / FF_END / JUMP_STEP_LIMIT constants not found");
  return { lines, begin: b[1], end: e[1], defaultLimit: Number(l[1]) };
}

/** Same substitution and escaping as buildJumpCommand(targetLine, remaining, limit). */
export function buildJumpCommand(targetLine, remaining, limit = readTemplate().defaultLimit, tpl = readTemplate()) {
  const script = tpl.lines.join("\n")
    .replace(/__LIMIT__/g, String(limit)).replace(/__LINE__/g, String(targetLine)).replace(/__NEED__/g, String(remaining))
    .replace(/__BEGIN__/g, tpl.begin).replace(/__END__/g, tpl.end);
  return `python exec("${script.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}")`;
}
