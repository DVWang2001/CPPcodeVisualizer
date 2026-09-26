// @ts-check
// Source instrumenter. Uses clang's JSON AST to put a probe (`__vg::step(...)`) at every place where
// GDB (g++ -O0) would stop with `next`/`step`, by INSERTING text only — line numbers never change.
//
// GDB stop rules (measured in experiments/frontend-only/e1/e2, REPORT.md):
//   * a declaration without initialiser has no code: no stop
//   * declarations with initialisers, expression statements, break, continue: one stop before the line
//   * for: one stop at the for line (before init), then one per increment; the condition shares the line
//   * while / if / else if: one stop per condition evaluation
//   * return X;: stop at the return line, then (after X is evaluated) at the function's closing `}`
//   * falling off the end of a function: stop at `}`
//   * several statements on one line = one stop (the decoder merges consecutive same-line records)
//   * range-for behaves exactly like the classic for above
//
// Supported: procedural code, recursion, reference parameters, range-for (incl. structured bindings),
// global variables, `long long`, structs WITHOUT member functions (shown as "<?>").
// Everything else fails loudly with `unsupported construct: X (line N)` instead of being
// mis-instrumented: switch, do-while, goto/labels, try, lambdas, templates, class member functions,
// user namespaces, overloaded functions, if/while with initialiser or condition variable,
// `if constexpr`, static locals, GNU statement expressions, asm, attributed statements,
// coroutines, and function-like macros at positions where text must be inserted.
import { userDecls, Unsupported } from "./userast.js";

export { Unsupported };

/** Statement/expression kinds that are rejected wherever they appear inside a function or initialiser. */
const FORBIDDEN = new Map([
  ["SwitchStmt", "switch"], ["CaseStmt", "switch"], ["DefaultStmt", "switch"], ["DoStmt", "do-while"],
  ["GotoStmt", "goto"], ["IndirectGotoStmt", "goto"], ["LabelStmt", "goto label"], ["CXXTryStmt", "try"],
  ["CXXThrowExpr", "throw"], ["LambdaExpr", "lambda"], ["StmtExpr", "GNU statement expression"],
  ["GCCAsmStmt", "asm"], ["MSAsmStmt", "asm"], ["AttributedStmt", "attributed statement"],
  ["CoroutineBodyStmt", "coroutine"], ["CoreturnStmt", "coroutine"], ["CoawaitExpr", "coroutine"],
  ["CoyieldExpr", "coroutine"], ["BlockExpr", "block"], ["SEHTryStmt", "try"],
]);
const TEMPLATE_DECLS = new Set(["FunctionTemplateDecl", "ClassTemplateDecl", "VarTemplateDecl", "TypeAliasTemplateDecl",
  "ClassTemplateSpecializationDecl", "ClassTemplatePartialSpecializationDecl", "VarTemplateSpecializationDecl",
  "VarTemplatePartialSpecializationDecl", "ConceptDecl"]);
const METHOD_DECLS = new Set(["CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl", "CXXConversionDecl"]);
const IDENT = /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*$/;

/** Escape a string as a C++ narrow string literal (ASCII-safe; UTF-8 passes through). @param {string} s */
export function cStr(s) {
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if (ch === '"') o += '\\"';
    else if (ch === "\\") o += "\\\\";
    else if (c < 0x20 || c === 0x7f) o += "\\" + c.toString(8).padStart(3, "0");
    else if (ch === "?") o += "\\?"; // no trigraph surprises
    else o += ch;
  }
  return o + '"';
}

/** Is this AST node an expression (clang JSON gives expressions a valueCategory)? @param {any} n */
const isExpr = (n) => n && typeof n === "object" && typeof n.valueCategory === "string";

/**
 * @param {import("./driver.js").Driver} driver
 * @param {string} source
 * @param {{ flags: string[], files?: Record<string, string | Uint8Array> }} astOpts
 */
export async function instrument(driver, source, astOpts) {
  const ast = await userDecls(driver, source, astOpts);
  if (!ast.ok) return { ok: false, log: ast.log };
  return { ok: true, ...instrumentAst(source, ast.top) };
}

/**
 * Pure part of the instrumenter (unit-testable with a canned AST).
 * @param {string} source
 * @param {any[]} top   top-level declarations of the user namespace (offsets already normalised)
 */
export function instrumentAst(source, top) {
  const buf = new TextEncoder().encode(source);
  const td = new TextDecoder();
  const text = (/** @type {number} */ a, /** @type {number} */ b) => td.decode(buf.subarray(a, b));
  const lineStarts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lineStarts.push(i + 1);
  const lineCount = lineStarts.length;
  const lineAt = (/** @type {number} */ off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= off) lo = m; else hi = m - 1; }
    return lo + 1;
  };

  /** @type {Array<{ at: number, text: string, del: number, seq: number }>} */
  const edits = [];
  const ins = (/** @type {number} */ at, /** @type {string} */ t, del = 0) => edits.push({ at, text: t, del, seq: edits.length });

  // ---- source locations (macro aware) --------------------------------------------------------
  /** @param {any} loc @returns {{ offset: number, tokLen: number, macro: boolean } | null} */
  const locOf = (loc) => {
    if (!loc) return null;
    if (typeof loc.offset === "number") return { offset: loc.offset, tokLen: loc.tokLen || 0, macro: false };
    if (loc.expansionLoc && typeof loc.expansionLoc.offset === "number") return { offset: loc.expansionLoc.offset, tokLen: loc.expansionLoc.tokLen || 0, macro: true };
    return null;
  };
  const isIdent = (/** @type {number} */ c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
  /** For a macro location: the length of the identifier at `off` if it is an object-like macro use, else -1. */
  const objectMacroLen = (/** @type {number} */ off) => {
    let k = off;
    while (k < buf.length && isIdent(buf[k])) k++;
    if (k === off) return -1;
    let q = k;
    while (q < buf.length && (buf[q] === 32 || buf[q] === 9)) q++;
    return buf[q] === 40 /* ( */ ? -1 : k - off;
  };
  /** Start of a statement: inserting before a macro invocation that begins the statement is safe. */
  const B = (/** @type {any} */ n) => {
    const l = locOf(n && n.range && n.range.begin);
    if (!l) throw new Unsupported("statement without source location");
    return l.offset;
  };
  /** Strict begin: plain text or an object-like macro. */
  const Bs = (/** @type {any} */ n, /** @type {string} */ what) => {
    const l = locOf(n && n.range && n.range.begin);
    if (!l) throw new Unsupported("expression without source location");
    if (l.macro && objectMacroLen(l.offset) < 0) throw new Unsupported(`function-like macro in ${what}`, lineAt(l.offset));
    return l.offset;
  };
  /** Strict end (one past the last token). */
  const E = (/** @type {any} */ n, /** @type {string} */ what) => {
    const l = locOf(n && n.range && n.range.end);
    if (!l) throw new Unsupported("expression without source location");
    if (l.macro) {
      const len = objectMacroLen(l.offset);
      if (len < 0) throw new Unsupported(`function-like macro in ${what}`, lineAt(l.offset));
      return l.offset + len;
    }
    return l.offset + l.tokLen;
  };
  /** Plain (non-macro) location required. */
  const P = (/** @type {any} */ loc, /** @type {string} */ what) => {
    const l = locOf(loc);
    if (!l || l.macro) throw new Unsupported(`macro in ${what}`, l ? lineAt(l.offset) : undefined);
    return l.offset;
  };
  const endStmt = (/** @type {any} */ n, /** @type {string} */ what) => {
    const e = E(n, what);
    let k = e;
    while (k < buf.length && (buf[k] === 32 || buf[k] === 9)) k++;
    return buf[k] === 59 /* ; */ ? k + 1 : e;
  };

  // ---- walkers --------------------------------------------------------------------------------
  /** Reject forbidden constructs anywhere below `n`. @param {any} n */
  const scanForbidden = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) scanForbidden(c); return; }
    if (typeof n.kind === "string") {
      const bad = FORBIDDEN.get(n.kind);
      const l = locOf(n.range && n.range.begin);
      if (bad) throw new Unsupported(bad, l ? lineAt(l.offset) : undefined);
      if (TEMPLATE_DECLS.has(n.kind)) throw new Unsupported("template", l ? lineAt(l.offset) : undefined);
      if (n.kind === "CXXRecordDecl" && (n.inner || []).some((/** @type {any} */ c) => (METHOD_DECLS.has(c.kind) && !c.isImplicit) || c.kind === "FriendDecl")) {
        throw new Unsupported("class member function", l ? lineAt(l.offset) : undefined);
      }
    }
    if (n.inner) scanForbidden(n.inner);
  };
  /**
   * Names of declared-without-initialiser variables (by decl id) that `nodes` may write:
   * any DeclRefExpr to such a variable that is NOT directly under an lvalue-to-rvalue conversion
   * (i.e. assignment targets, ++/--, &x, reference arguments such as `cin >> x`, member access,
   * array decay). Conservative on purpose: it may clear the "uninitialised" flag early (showing
   * the raw value), never late (never hides a real value behind the D6 zero).
   * @param {any[]} nodes @param {Map<string, number>} uninitIds decl-id -> uninit ordinal
   */
  const writesOf = (nodes, uninitIds) => {
    /** @type {Set<number>} */
    const out = new Set();
    /** @param {any} n @param {any} parent */
    const walk = (n, parent) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const c of n) walk(c, parent); return; }
      if (n.kind === "DeclRefExpr" && n.referencedDecl && uninitIds.has(n.referencedDecl.id)) {
        const read = parent && parent.kind === "ImplicitCastExpr" && parent.castKind === "LValueToRValue";
        if (!read) out.add(/** @type {number} */ (uninitIds.get(n.referencedDecl.id)));
      }
      if (n.inner) for (const c of n.inner) walk(c, n);
    };
    for (const n of nodes) walk(n, null);
    return [...out];
  };

  // ---- top level ------------------------------------------------------------------------------
  /** @type {Array<{ name: string, offset: number, type: string, id: string }>} */
  const globals = [];
  /** @type {any[]} */
  const functions = [];
  for (const d of top) {
    const l = locOf(d.range && d.range.begin);
    const line = l ? lineAt(l.offset) : undefined;
    if (TEMPLATE_DECLS.has(d.kind)) throw new Unsupported("template", line);
    if (d.kind === "NamespaceDecl") throw new Unsupported("namespace", line);
    if (d.kind === "LinkageSpecDecl") {
      // declarations only (e.g. `extern "C" int f(int);`) are fine; definitions inside would escape instrumentation
      const defines = (d.inner || []).some((/** @type {any} */ c) => (c.inner || []).some((/** @type {any} */ x) => x.kind === "CompoundStmt") || (c.kind === "VarDecl" && c.storageClass !== "extern"));
      if (defines) throw new Unsupported("extern \"C\" block with definitions", line);
      continue;
    }
    if (METHOD_DECLS.has(d.kind)) throw new Unsupported("class member function", line);
    if (d.kind === "CXXRecordDecl") { scanForbidden(d); continue; }
    if (d.kind === "VarDecl") {
      scanForbidden(d.inner);
      if (d.storageClass !== "extern" && d.name && l) globals.push({ name: d.name, offset: l.offset, type: d.type && d.type.qualType, id: d.id });
      continue;
    }
    if (d.kind === "FunctionDecl" && !d.isImplicit && (d.inner || []).some((/** @type {any} */ c) => c.kind === "CompoundStmt")) {
      if (/^__vg/.test(d.name || "")) throw new Unsupported("identifier starting with __vg", line);
      functions.push(d);
    }
  }
  const byName = new Map();
  for (const f of functions) {
    if (byName.has(f.name)) throw new Unsupported(`overloaded function ${f.name}`, lineAt(B(f)));
    byName.set(f.name, f);
  }

  /** Static description of every probe site, indexed by probe id. */
  /** @type {Array<{ line: number, fn: string, names: string[], u: Array<[string, number]>, w: number[] }>} */
  const probes = [];
  /** @type {Record<string, any>} */
  const fnMeta = Object.create(null);
  /** @type {Record<string, Record<string, string | string[]>>} */
  const decls = Object.create(null);
  /** @type {Array<{ fn: string, name: string, line: number, id: number }>} */
  const uninitDecls = [];
  /** @type {Record<string, string>} */
  const globalTypes = Object.create(null);
  for (const g of globals) globalTypes[g.name] = g.type;

  for (const decl of functions) {
    const fn = /** @type {string} */ (decl.name);
    const bodyN = decl.inner.find((/** @type {any} */ c) => c.kind === "CompoundStmt");
    scanForbidden(bodyN);
    scanForbidden((decl.inner || []).filter((/** @type {any} */ c) => c.kind === "ParmVarDecl"));
    const fnDecls = /** @type {Record<string, string | string[]>} */ (Object.create(null));
    decls[fn] = fnDecls;
    const addDecl = (/** @type {string} */ name, /** @type {any} */ type) => {
      const t = (type && type.qualType) || "?";
      const prev = fnDecls[name];
      if (prev === undefined) fnDecls[name] = t;
      else if (Array.isArray(prev)) { if (!prev.includes(t)) prev.push(t); }
      else if (prev !== t) fnDecls[name] = [prev, t];
    };
    const visibleGlobals = globals.filter((g) => g.offset < B(decl));
    for (const g of visibleGlobals) addDecl(g.name, { qualType: g.type });
    const knownVars = new Set();

    /** A scope entry: [name, uninitOrdinal | -1] */
    /** @typedef {Array<[string, number]>} Scope */
    /** @type {Map<string, number>} decl id -> uninit ordinal (for this function) */
    const uninitIds = new Map();

    /** @param {Scope[]} scopes */
    const visible = (scopes) => {
      /** @type {Map<string, number>} */
      const m = new Map();
      for (const g of visibleGlobals) m.set(g.name, -1);
      for (const sc of scopes) for (const [n, u] of sc) { m.delete(n); m.set(n, u); }
      return m;
    };
    /** @param {number} line @param {Scope[]} scopes @param {any[]} writeNodes */
    const probe = (line, scopes, writeNodes) => {
      const vis = visible(scopes);
      const names = [...vis.keys()];
      // Names are spliced into C++ as identifiers: accept only identifier-shaped AST names.
      for (const n of names) if (!IDENT.test(n)) throw new Unsupported(`variable name ${JSON.stringify(n)}`, line);
      for (const n of names) knownVars.add(n);
      /** @type {Array<[string, number]>} */
      const u = [];
      for (const [n, k] of vis) if (k >= 0) u.push([n, k]);
      const id = probes.length;
      probes.push({ line, fn, names, u, w: writesOf(writeNodes, uninitIds) });
      const vars = names.map((n) => `__vg::v(${cStr(n)}, ${n})`).join(", ");
      return `__vg::step(${id}, ${line}, ${cStr(fn)}, {${vars}})`;
    };

    const closeLine = lineAt(P(bodyN.range.end, "function body"));
    /** @param {any} node @param {Scope[]} scopes */
    const compound = (node, scopes) => {
      scopes.push([]);
      for (const st of node.inner || []) stmt(st, scopes);
      scopes.pop();
    };
    /** @param {any} node @param {Scope[]} scopes */
    const body = (node, scopes) => {
      if (node.kind === "CompoundStmt") return compound(node, scopes);
      ins(B(node), "{ ");
      stmt(node, scopes);
      ins(endStmt(node, "statement"), " }");
    };
    const declHasInit = (/** @type {any} */ d) => d.kind === "VarDecl" && (d.init !== undefined || (d.inner || []).some((/** @type {any} */ c) => isExpr(c)));

    /** @param {any} st @param {Scope[]} scopes */
    function stmt(st, scopes) {
      const L = lineAt(B(st));
      const cur = scopes[scopes.length - 1];
      if (isExpr(st)) { ins(B(st), probe(L, scopes, [st]) + "; "); return; }
      switch (st.kind) {
        case "NullStmt": return;
        case "CompoundStmt": return compound(st, scopes);
        case "BreakStmt": case "ContinueStmt": ins(B(st), probe(L, scopes, []) + "; "); return;
        case "DeclStmt": {
          const inner = st.inner || [];
          for (const d of inner) {
            if (d.kind === "CXXRecordDecl") scanForbidden(d);
            else if (d.kind === "VarDecl" && (d.storageClass === "static" || d.tls)) throw new Unsupported("static local variable", L);
          }
          const ds = inner.filter((/** @type {any} */ d) => d.kind === "VarDecl");
          if (ds.some(declHasInit)) ins(B(st), probe(L, scopes, [st]) + "; ");
          for (const d of ds) {
            addDecl(d.name, d.type);
            if (declHasInit(d)) cur.push([d.name, -1]);
            else {
              const k = uninitDecls.length;
              uninitDecls.push({ fn, name: d.name, line: L, id: k });
              uninitIds.set(d.id, k);
              cur.push([d.name, k]);
            }
          }
          return;
        }
        case "CXXForRangeStmt": {
          // for (D x : E) BODY  ->  { probe; auto&& r = (E); auto b = std::begin(r); auto e = std::end(r);
          //                          for (; b != e; (probe, ++b)) { D = *b; BODY } }
          // Only the header text on the same lines is replaced; the newline count is preserved.
          const [initS, , beginDS, , , , varDS, bodyN2] = st.inner;
          if (initS && initS.kind) throw new Unsupported("range-for with init-statement", L);
          const start = P(st.range.begin, "range-for");
          const colon = P(beginDS.range.begin, "range-for");
          if (buf[colon] !== 58) throw new Unsupported("range-for header layout", L);
          const closeParen = P(varDS.range.end, "range-for");
          if (buf[closeParen] !== 41) throw new Unsupported("range-for header layout", L);
          const declText = text(P(varDS.range.begin, "range-for"), colon).trim();
          const rangeText = text(colon + 1, closeParen).trim();
          const rangeNode = (st.inner[1] && st.inner[1].inner) || [];
          const bodyBegin = P(bodyN2.range.begin, "range-for body");
          let nl = 0;
          for (let k = start; k < bodyBegin; k++) if (buf[k] === 10) nl++;
          const loopScope = /** @type {Scope} */ ([]);
          for (const d of varDS.inner || []) {
            if (d.kind === "VarDecl" && !d.isImplicit && d.name) { loopScope.push([d.name, -1]); addDecl(d.name, d.type); }
            if (d.kind === "DecompositionDecl") for (const b of d.inner || []) if (b.kind === "BindingDecl") { loopScope.push([b.name, -1]); addDecl(b.name, b.type); }
          }
          // `for (x : {1, 2, 3})`: a braced list cannot be parenthesised; `auto&& r = {..}` deduces initializer_list
          const rangeInit = rangeText.startsWith("{") ? rangeText : `(${rangeText})`;
          const head = `{ ${probe(L, scopes, rangeNode)}; auto&& __vg_r = ${rangeInit}; auto __vg_b = std::begin(__vg_r); auto __vg_e = std::end(__vg_r); `
            + `for (; __vg_b != __vg_e; (${probe(L, scopes, [])}, ++__vg_b)) ` + "\n".repeat(nl);
          ins(start, head, bodyBegin - start);
          scopes.push(loopScope);
          if (bodyN2.kind === "CompoundStmt") {
            ins(bodyBegin + 1, ` ${declText} = *__vg_b; `);
            compound(bodyN2, scopes);
            ins(E(bodyN2, "range-for body"), " }");
          } else {
            ins(bodyBegin, `{ ${declText} = *__vg_b; `);
            stmt(bodyN2, scopes);
            ins(endStmt(bodyN2, "range-for body"), " } }");
          }
          scopes.pop();
          return;
        }
        case "ForStmt": {
          const [init, condVar, cond, inc, bodyN2] = st.inner;
          if (condVar && condVar.kind) throw new Unsupported("for with condition variable", L);
          const forScope = /** @type {Scope} */ ([]);
          ins(B(st), probe(L, scopes, [init, cond]) + "; ");
          scopes.push(forScope);
          if (init && init.kind === "DeclStmt") {
            for (const d of init.inner || []) if (d.kind === "VarDecl") {
              if (d.storageClass === "static") throw new Unsupported("static local variable", L);
              addDecl(d.name, d.type);
              if (declHasInit(d)) forScope.push([d.name, -1]);
              else { const k = uninitDecls.length; uninitDecls.push({ fn, name: d.name, line: L, id: k }); uninitIds.set(d.id, k); forScope.push([d.name, k]); }
            }
          }
          if (inc && inc.kind) { ins(Bs(inc, "for increment"), "(" + probe(L, scopes, [inc, cond]) + ", "); ins(E(inc, "for increment"), ")"); }
          body(bodyN2, scopes);
          scopes.pop();
          return;
        }
        case "WhileStmt": {
          if (st.hasVar) throw new Unsupported("while with condition variable", L);
          const cond = st.inner[st.inner.length - 2], bodyN2 = st.inner[st.inner.length - 1];
          ins(Bs(cond, "while condition"), "(" + probe(L, scopes, [cond]) + ", "); ins(E(cond, "while condition"), ")");
          body(bodyN2, scopes);
          return;
        }
        case "IfStmt": {
          if (st.hasInit) throw new Unsupported("if with initializer", L);
          if (st.hasVar) throw new Unsupported("if with condition variable", L);
          if (st.isConstexpr) throw new Unsupported("if constexpr", L);
          if (st.isConsteval) throw new Unsupported("if consteval", L);
          const cond = st.inner[0], thenN = st.inner[1], elseN = st.hasElse ? st.inner[2] : null;
          ins(Bs(cond, "if condition"), "(" + probe(L, scopes, [cond]) + ", "); ins(E(cond, "if condition"), ")");
          body(thenN, scopes);
          if (elseN) body(elseN, scopes);
          return;
        }
        case "ReturnStmt": {
          const closeVars = [scopes[0], scopes[1] || []];
          const expr = (st.inner || [])[0];
          ins(B(st), "{ " + probe(L, scopes, expr ? [expr] : []) + "; ");
          if (expr) {
            if (expr.kind === "InitListExpr" || (expr.kind === "ExprWithCleanups" && (expr.inner || []).some((/** @type {any} */ c) => c.kind === "InitListExpr"))) {
              throw new Unsupported("return with braced initializer", L);
            }
            ins(Bs(expr, "return value"), "__vg::ret(");
            ins(E(expr, "return value"), `, [&]{ ${probe(closeLine, closeVars, [])}; })`);
          } else {
            ins(B(st), probe(closeLine, closeVars, []) + "; ");
          }
          ins(endStmt(st, "return"), " }");
          return;
        }
        default:
          throw new Unsupported(`statement ${st.kind}`, L);
      }
    }

    const params = (decl.inner || []).filter((/** @type {any} */ c) => c.kind === "ParmVarDecl" && c.name);
    for (const p of params) addDecl(p.name, p.type);
    /** @type {Scope[]} */
    const scopes = [params.map((/** @type {any} */ p) => /** @type {[string, number]} */ ([p.name, -1])), []];
    const open = P(bodyN.range.begin, "function body");
    if (buf[open] !== 123) throw new Unsupported("function body layout", lineAt(open));
    ins(open + 1, " __vg::Frame __vg_fr; ");
    for (const st of bodyN.inner || []) stmt(st, scopes);
    ins(P(bodyN.range.end, "function body"), probe(closeLine, [scopes[0], scopes[1]], []) + "; ");
    fnMeta[fn] = { line: lineAt(B(decl)), closeLine, params: params.map((/** @type {any} */ p) => p.name), vars: [...knownVars] };
  }

  edits.sort((a, b) => a.at - b.at || a.seq - b.seq);
  let out = "", prev = 0;
  for (const e of edits) {
    if (e.at < prev) throw new Unsupported("overlapping instrumentation edits", lineAt(e.at));
    out += text(prev, e.at) + e.text;
    prev = e.at + e.del;
  }
  out += text(prev, buf.length);
  if (out.split("\n").length !== lineCount) throw new Error("instrumenter changed the line count (internal error)");
  return { text: out, meta: { lineCount, functions: fnMeta, probes, decls, globals: globalTypes, uninitDecls } };
}
