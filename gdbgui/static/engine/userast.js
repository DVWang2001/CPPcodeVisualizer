// @ts-check
// Get the AST of everything the student declared, in ONE clang run: the source is wrapped in
// `namespace __vg_user { ... }` (inserted at the start of the line after the last #include, so no
// line is added and line numbers are unchanged) and dumped with -ast-dump-filter=__vg_user.
// The wrapped text is only analysed, never compiled. All `offset` fields are mapped back to byte
// offsets of the original source.
import { splitJson } from "./jsonsplit.js";

const NS = "namespace __vg_user { ";

export class Unsupported extends Error {
  /** @param {string} construct @param {number} [line] */
  constructor(construct, line) {
    super(`unsupported construct: ${construct}${line ? ` (line ${line})` : ""}`);
    this.construct = construct;
    this.line = line || null;
  }
}

/**
 * Classify the lines before the last `#include`. Returns
 *   { lastInclude: index|-1, onlyIncludesBefore: bool, codeBefore: line|null }
 * `codeBefore` is the first line (1-based) before the last #include that is neither blank, a
 * comment, a preprocessor directive nor a `using` declaration — such code would sit outside the
 * analysis namespace and silently escape instrumentation, so the instrumenter rejects it.
 * `onlyIncludesBefore` (no #define/#pragma/code at all before the last include) gates PCH use.
 * @param {string} source
 */
export function scanPrelude(source) {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, "")); // CRLF sources: `.` does not match \r
  let lastInclude = -1;
  /** @type {boolean[]} */
  const inComment = [];
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    inComment.push(open);
    const l = lines[i];
    // track /* */ state (strings in preprocessor lines are rare enough to ignore here)
    let k = 0;
    while (k < l.length) {
      if (open) { const e = l.indexOf("*/", k); if (e < 0) { k = l.length; } else { open = false; k = e + 2; } }
      else { const s = l.indexOf("/*", k); const c = l.indexOf("//", k); if (s >= 0 && (c < 0 || s < c)) { open = true; k = s + 2; } else k = l.length; }
    }
    if (!inComment[i] && /^\s*#\s*include\b/.test(l)) lastInclude = i;
  }
  let onlyIncludesBefore = true;
  /** @type {number | null} */
  let codeBefore = null;
  for (let i = 0; i < lastInclude; i++) {
    const raw = lines[i];
    const t = raw.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "").trim();
    if (inComment[i] || t === "" || /^\*/.test(t) || /^\s*\/\*/.test(raw)) continue;
    if (/^#\s*include\s*<[\w./+-]+>$/.test(t)) continue;
    onlyIncludesBefore = false;
    if (/^#/.test(t) || /^using\b/.test(t)) continue;
    if (codeBefore === null) codeBefore = i + 1;
  }
  return { lastInclude, onlyIncludesBefore, codeBefore };
}

/** @param {string} s */
const byteLen = (s) => new TextEncoder().encode(s).length;

/**
 * The analysis namespace must open at the start of a line that is real code: not a preprocessor
 * directive (or its backslash continuation) and not inside a block comment. Directives such as
 * `#define N 3` right after the includes are skipped (macros are namespace-agnostic); a
 * conditional-compilation directive there would put the namespace inside an #if branch, so it is
 * refused explicitly.
 * @param {string[]} lines @param {number} from
 */
export function namespaceLine(lines, from) {
  let open = false, cont = false;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "");
    const startsInComment = open;
    let k = 0;
    while (k < l.length) {
      if (open) { const e = l.indexOf("*/", k); if (e < 0) k = l.length; else { open = false; k = e + 2; } }
      else { const s = l.indexOf("/*", k), c = l.indexOf("//", k); if (s >= 0 && (c < 0 || s < c)) { open = true; k = s + 2; } else k = l.length; }
    }
    const wasCont = cont;
    cont = /\\$/.test(l);
    if (wasCont || startsInComment) continue; // never insert inside a comment or a continued directive
    const t = l.trim();
    if (/^#/.test(t)) {
      if (/^#\s*(if|ifdef|ifndef|elif|else|endif)\b/.test(t)) throw new Unsupported("preprocessor conditional between the #includes and the first declaration", i + 1);
      continue;
    }
    return i; // code, a blank line, or a line that starts a comment: inserting before it is safe
  }
  return lines.length;
}

/**
 * @param {import("./driver.js").Driver} driver
 * @param {string} source
 * @param {{ flags: string[], files?: Record<string, string | Uint8Array> }} o
 */
export async function userDecls(driver, source, o) {
  const pre = scanPrelude(source);
  if (pre.codeBefore !== null) throw new Unsupported("code before the last #include", pre.codeBefore);
  const lines = source.split("\n");
  const insLine = namespaceLine(lines, pre.lastInclude + 1);
  const head = lines.slice(0, insLine).join("\n") + (insLine > 0 ? "\n" : "");
  const insAt = byteLen(head);
  const shift = byteLen(NS);
  const wrapped = head + NS + lines.slice(insLine).join("\n") + "\n}\n";
  const r = await driver.astJson(wrapped, { flags: o.flags, filter: "__vg_user", files: o.files || {} });
  if (r.code !== 0) return { ok: false, log: r.err };
  const un = (/** @type {number} */ off) => (off >= insAt + shift ? off - shift : off);
  /** @param {any} n @returns {any} */
  const norm = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(norm);
    const out = /** @type {any} */ ({});
    for (const k of Object.keys(n)) out[k] = k === "offset" && typeof n[k] === "number" ? un(n[k]) : norm(n[k]);
    return out;
  };
  const ns = splitJson(r.out).find((x) => x.kind === "NamespaceDecl" && x.name === "__vg_user");
  if (!ns) return { ok: false, log: r.err || "clang produced no AST for the program" };
  return { ok: true, top: /** @type {any[]} */ ((norm(ns).inner || [])), log: r.err };
}
