// Lexical block structure of each user function, recovered from the SOURCE TEXT.
//
// Why: GDB lists a frame's locals per DWARF lexical block, innermost block first, each block in
// declaration order, and lists a block's variables even before their declaration has executed. The
// engine result only names the variables in scope per step, so LocalGdb needs the block structure to
// reproduce `-stack-list-variables` and to decide varobj `in_scope`. The engine already tells us
// which names are variables (`functions[fn].vars`) and where each function starts and ends; this
// module finds where they are declared.
//
// Block ranges (line granular, inclusive) follow where GDB's address ranges fall for g++ -O0:
//   function block   [header line .. closing brace line]  parameters + top-level locals
//   for block        [`for` line .. end of loop]          the init-statement variables
//   body block       [first line inside `{` .. `}` line]  braces of a loop/if/else/plain compound
// so on the `for` line itself only the loop variable is visible, not the body's declarations.
//
// Heuristic (documented gap): this is a token-level scan, not a C++ parser. Declarations are
// recognised as `<type> name` followed by `= ; , ( { [ :` where `name` is a known variable of the
// function; a `typedef`-only or macro-generated declaration falls back to the function block.
// Plain ES module, no DOM / Node APIs.

/** @typedef {{ t: string, line: number }} Tok */
/** @typedef {{ id: number, kind: "function" | "for" | "body", start: number, end: number, parent: number, depth: number, vars: Array<{ name: string, declLine: number, nth: number }> }} Block */
/** @typedef {{ blocks: Block[], loops: Array<{ kind: "for" | "while", start: number, end: number }> }} FnScopes */

const KEYWORDS_NOT_TYPES = new Set(["return", "delete", "throw", "goto", "break", "continue", "case", "default", "else", "new", "sizeof", "using", "namespace", "co_return", "co_yield", "co_await", "typedef"]);
const TYPE_PREFIX = new Set(["const", "static", "constexpr", "volatile", "register", "extern", "inline", "mutable"]);
const BUILTIN = new Set(["unsigned", "signed", "short", "long", "int", "char", "bool", "float", "double", "void", "wchar_t", "auto"]);
const FOLLOW = new Set(["=", ";", ",", "(", "{", "[", ":", ")"]);

/** @param {string} src @returns {Tok[]} */
export function lex(src) {
  /** @type {Tok[]} */
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  let lineStart = true;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; lineStart = true; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    if (c === "#" && lineStart) {
      while (i < n && src[i] !== "\n") { if (src[i] === "\\" && src[i + 1] === "\n") { line++; i++; } i++; }
      continue;
    }
    lineStart = false;
    if (c === '"' || c === "'") {
      const q = c;
      const startLine = line;
      i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; if (src[i] === "\n") line++; i++; }
      i++;
      out.push({ t: q === '"' ? '"str"' : "'chr'", line: startLine });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /\w/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "R" && src[j] === '"') { // raw string R"delim( ... )delim"
        const m = /^"([^(\s]*)\(/.exec(src.slice(j, j + 20));
        if (m) {
          const end = src.indexOf(")" + m[1] + '"', j);
          const stop = end < 0 ? n : end + m[1].length + 2;
          for (let k = j; k < stop; k++) if (src[k] === "\n") line++;
          out.push({ t: '"str"', line });
          i = stop; continue;
        }
      }
      out.push({ t: word, line });
      i = j; continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.']/.test(src[j])) j++;
      out.push({ t: "0", line });
      i = j; continue;
    }
    if (c === ":" && src[i + 1] === ":") { out.push({ t: "::", line }); i += 2; continue; }
    if (c === "-" && src[i + 1] === ">") { out.push({ t: "->", line }); i += 2; continue; }
    if (c === "&" && src[i + 1] === "&") { out.push({ t: "&&", line }); i += 2; continue; }
    if ((c === "=" || c === "!" || c === "<" || c === ">") && src[i + 1] === "=") { out.push({ t: c + "=", line }); i += 2; continue; }
    out.push({ t: c, line });
    i++;
  }
  return out;
}

/** @param {Tok[]} T @param {number} i index of an opening ( [ { @returns {number} index of the matching closer */
function matching(T, i) {
  const open = T[i].t;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let d = 0;
  for (let j = i; j < T.length; j++) {
    if (T[j].t === open) d++;
    else if (T[j].t === close && --d === 0) return j;
  }
  return T.length - 1;
}

/**
 * Names declared by the declaration occupying T[from..to) (empty when it is not a declaration).
 * @param {Tok[]} T @param {number} from @param {number} to @param {Set<string>} known
 * @returns {Array<{ name: string, line: number }>}
 */
function declaredNames(T, from, to, known) {
  let i = from;
  while (i < to && TYPE_PREFIX.has(T[i].t)) i++;
  if (i >= to) return [];
  const head = T[i].t;
  if (KEYWORDS_NOT_TYPES.has(head)) return [];
  if (!/^[A-Za-z_]/.test(head)) return [];
  const isBuiltin = BUILTIN.has(head);
  if (isBuiltin) {
    while (i < to && (BUILTIN.has(T[i].t) || TYPE_PREFIX.has(T[i].t))) i++;
  } else {
    // qualified name with optional template arguments
    let sawQual = false;
    for (;;) {
      if (i >= to || !/^[A-Za-z_]/.test(T[i].t)) return [];
      i++;
      if (T[i] && i < to && T[i].t === "<") {
        let d = 0;
        for (; i < to; i++) { if (T[i].t === "<") d++; else if (T[i].t === ">" && --d === 0) { i++; break; } }
        sawQual = true;
      }
      if (i < to && T[i].t === "::") { i++; sawQual = true; continue; }
      break;
    }
    if (!sawQual && known.has(head)) return []; // `a * b;` style expression, not a declaration
  }
  while (i < to && (T[i].t === "*" || T[i].t === "&" || T[i].t === "&&" || T[i].t === "const")) i++;
  /** @type {Array<{ name: string, line: number }>} */
  const names = [];
  if (i < to && T[i].t === "[" && head === "auto") { // structured binding
    const e = matching(T, i);
    for (let j = i + 1; j < e; j++) if (known.has(T[j].t)) names.push({ name: T[j].t, line: T[j].line });
    return names;
  }
  for (;;) {
    if (i >= to || !known.has(T[i].t)) break;
    const nm = T[i];
    const nx = i + 1 < to ? T[i + 1].t : ";";
    if (!FOLLOW.has(nx)) break;
    names.push({ name: nm.t, line: nm.line });
    i++;
    // skip the declarator's initialiser / array bounds up to the next top-level comma
    let d = 0;
    while (i < to) {
      const t = T[i].t;
      if (t === "(" || t === "[" || t === "{") d++;
      else if (t === ")" || t === "]" || t === "}") d--;
      else if (t === "," && d === 0) break;
      i++;
    }
    if (i < to && T[i].t === ",") i++; else break;
    while (i < to && (T[i].t === "*" || T[i].t === "&")) i++;
  }
  return names;
}

/**
 * @param {string} source
 * @param {Record<string, { line: number, closeLine: number, params: string[], vars: string[] }>} functions
 * @param {Record<string, string>} [globals] names of global variables (never listed as locals)
 * @returns {Map<string, FnScopes>}
 */
export function analyzeScopes(source, functions, globals = {}) {
  const T = lex(source);
  /** @type {Map<string, FnScopes>} */
  const out = new Map();
  for (const fn of Object.keys(functions)) {
    const meta = functions[fn];
    const known = new Set(meta.vars);
    /** @type {Block[]} */
    const blocks = [];
    /** @type {Array<{ kind: "for" | "while", start: number, end: number }>} loop headers with the last line of their body */
    const loops = [];
    /** @type {Record<string, number>} */
    const nth = Object.create(null);
    const mk = (kind, start, end, parent) => {
      const b = { id: blocks.length, kind, start, end, parent: parent ? parent.id : -1, depth: parent ? parent.depth + 1 : 0, vars: [] };
      blocks.push(b);
      return b;
    };
    const declare = (/** @type {Block} */ b, /** @type {Array<{name:string,line:number}>} */ names) => {
      for (const d of names) {
        if (b.vars.some((v) => v.name === d.name)) continue;
        b.vars.push({ name: d.name, declLine: d.line, nth: nth[d.name] || 0 });
        nth[d.name] = (nth[d.name] || 0) + 1;
      }
    };
    const fb = mk("function", meta.line, meta.closeLine, null);
    for (const p of meta.params) { fb.vars.push({ name: p, declLine: meta.line, nth: 0 }); nth[p] = 1; }

    // body brace of the function
    let i0 = T.findIndex((t) => t.line >= meta.line);
    while (i0 >= 0 && i0 < T.length && T[i0].t !== "{") i0++;
    if (i0 >= 0 && i0 < T.length) {
      const stmtEnd = (/** @type {number} */ i) => {
        let d = 0;
        for (let j = i; j < T.length; j++) {
          const t = T[j].t;
          if (t === "(" || t === "[" || t === "{") d++;
          else if (t === ")" || t === "]" || t === "}") { if (--d < 0) return j; }
          else if (t === ";" && d === 0) return j;
        }
        return T.length - 1;
      };
      /** @returns {number} index after the statement */
      const parseStmt = (/** @type {number} */ i, /** @type {Block} */ block) => {
        const tok = T[i];
        if (!tok) return T.length;
        if (tok.t === "{") {
          const j = matching(T, i);
          const nb = mk("body", i + 1 < j ? T[i + 1].line : tok.line, T[j].line, block);
          parseRange(i + 1, j, nb);
          return j + 1;
        }
        if (tok.t === "for" && T[i + 1] && T[i + 1].t === "(") {
          const q = matching(T, i + 1);
          const fbk = mk("for", tok.line, tok.line, block);
          // split header at top-level ';'
          let semi = -1, colon = -1, d = 0;
          for (let j = i + 2; j < q; j++) {
            const t = T[j].t;
            if (t === "(" || t === "[" || t === "{") d++;
            else if (t === ")" || t === "]" || t === "}") d--;
            else if (d === 0 && t === ";" && semi < 0) semi = j;
            else if (d === 0 && t === ":" && colon < 0) colon = j;
          }
          const initEnd = semi >= 0 ? semi : colon >= 0 ? colon : q;
          declare(fbk, declaredNames(T, i + 2, initEnd, known));
          const r = q + 1;
          let next;
          if (T[r] && T[r].t === "{") {
            const j = matching(T, r);
            const nb = mk("body", r + 1 < j ? T[r + 1].line : T[r].line, T[j].line, fbk);
            parseRange(r + 1, j, nb);
            fbk.end = T[j].line;
            next = j + 1;
          } else {
            next = parseStmt(r, fbk);
            fbk.end = T[Math.max(next - 1, r)].line;
          }
          loops.push({ kind: "for", start: tok.line, end: fbk.end });
          return next;
        }
        if ((tok.t === "while" || tok.t === "if" || tok.t === "switch") && T[i + 1] && T[i + 1].t === "(") {
          const q = matching(T, i + 1);
          let next = parseStmt(q + 1, block);
          if (tok.t === "while") loops.push({ kind: "while", start: tok.line, end: T[Math.max(next - 1, q + 1)].line });
          if (tok.t === "if" && T[next] && T[next].t === "else") next = parseStmt(next + 1, block);
          return next;
        }
        if (tok.t === "else") return parseStmt(i + 1, block);
        const e = stmtEnd(i);
        declare(block, declaredNames(T, i, e, known));
        return e + 1;
      };
      const parseRange = (/** @type {number} */ from, /** @type {number} */ to, /** @type {Block} */ block) => {
        let i = from;
        while (i < to) i = parseStmt(i, block);
      };
      const close = matching(T, i0);
      parseRange(i0 + 1, close, fb);
    }
    // any known local the scan did not place (macro-generated, typedef'd declarations): function block
    const placed = new Set();
    for (const b of blocks) for (const v of b.vars) placed.add(v.name);
    for (const v of meta.vars) if (!placed.has(v) && !Object.prototype.hasOwnProperty.call(globals, v)) fb.vars.push({ name: v, declLine: meta.line, nth: 0 });
    out.set(fn, { blocks, loops });
  }
  return out;
}

/**
 * Blocks containing `line`, innermost first.
 * @param {FnScopes} sc @param {number} line @returns {Block[]}
 */
export function chainAt(sc, line) {
  return sc.blocks.filter((b) => b.start <= line && line <= b.end).sort((a, b) => b.depth - a.depth || b.id - a.id);
}
