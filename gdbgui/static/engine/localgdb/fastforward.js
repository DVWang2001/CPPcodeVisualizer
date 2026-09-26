// `[fast @N]` fast-forward: parsing of the `python exec("...")` command that
// gdbgui/src/js/fastForwardJump.ts (buildJumpCommand) sends, and Python-compatible JSON output of the
// `@@FF@@{stacks,counts,landed,steps}@@/FF@@` block (decision D11: parse the command text, zero UI change).
//
// The parser reads the three numbers the template substitutes (__LIMIT__, __LINE__, __NEED__) out of the
// script TEXT with tolerant regexes. tests/engine/localgdb/fastforward_template.test.mjs reads
// fastForwardJump.ts and fails loudly when the template stops matching these patterns.
// Plain ES module, no DOM / Node APIs.

export const DEFAULT_BEGIN = "@@FF@@";
export const DEFAULT_END = "@@/FF@@";

const RE_LIMIT = /while\s+_i\s*<\s*(\d+)\s*:/;
const RE_TARGET = /_ln\s*==\s*(\d+)\s+and\s+_C\.get\(\s*str\(\s*(\d+)\s*\)\s*,\s*0\s*\)\s*>=\s*(\d+)/;
const RE_MARKERS = /print\(\s*'([^']*)'\s*\+\s*json\.dumps\([\s\S]*?\)\s*\+\s*'([^']*)'\s*\)/;

/**
 * @param {string} cmd  the CLI command text
 * @returns {{ limit: number, line: number, need: number, begin: string, end: string } | null} null when it is not a fast-forward jump
 */
export function parseFastForward(cmd) {
  if (!/^\s*python\s+exec\(/.test(cmd) || !cmd.includes("@@FF@@")) return null;
  const lim = RE_LIMIT.exec(cmd);
  const tgt = RE_TARGET.exec(cmd);
  if (!lim || !tgt || tgt[1] !== tgt[2]) return null;
  const mk = RE_MARKERS.exec(cmd);
  return { limit: Number(lim[1]), line: Number(tgt[1]), need: Number(tgt[3]), begin: mk ? mk[1] : DEFAULT_BEGIN, end: mk ? mk[2] : DEFAULT_END };
}

/** @param {string} s */
function pyStr(s) {
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if (ch === '"') o += '\\"';
    else if (ch === "\\") o += "\\\\";
    else if (ch === "\n") o += "\\n";
    else if (ch === "\r") o += "\\r";
    else if (ch === "\t") o += "\\t";
    else if (c < 0x20 || c > 0x7e) {
      if (c > 0xffff) { const v = c - 0x10000; o += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0"); } else o += "\\u" + c.toString(16).padStart(4, "0");
    } else o += ch;
  }
  return o + '"';
}

/**
 * Python `json.dumps(obj)` with default separators. Objects are given as `Map` (insertion order kept:
 * JS plain objects would reorder integer-like keys such as "33") or plain objects with string keys.
 * @param {any} v @returns {string}
 */
export function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return "{" + entries.map(([k, x]) => pyStr(String(k)) + ": " + pyJson(x)).join(", ") + "}";
}
