// Typed evaluator for the C++ expressions the UI feeds to `-var-create` / `-data-evaluate-expression`
// (`w - 1`, `j + 1`, `dp[r][j + 1]`, `i < n && !done`): integer/bool/char/floating arithmetic with C++
// promotion rules and GDB's spelling of the result type.
//
// Why not gdbgui/static/engine/evalexpr.js: it is untyped (JS numbers) - it cannot say that `w - 1` is an `int`,
// that a comparison is a `bool` (GDB prints `true`), or wrap 32-bit ints. Its grammar is mirrored here
// (numbers, names, [], + - * / %, comparisons, && || ! ?:, parentheses; `.size()`-style members differ, see below).
//
// Semantics: integers are BigInt with wrap-around at the type width (int = 32 bit, long/long long = 64), C++ usual
// arithmetic conversions, truncating `/` and `%`, "Division by zero" (GDB's text). Any member call (`v.size()`,
// `v.empty()`, `v.capacity()`) is `Cannot evaluate function -- may be inlined`, which is what real GDB answers for
// the libstdc++ members (golden: cost.capacity()). Out-of-range subscripts are an error (GDB would read garbage).
// Not supported (explicit error): unary `*`, `->`, `::`, casts, function calls, bitwise/shift operators, assignment.
// Plain ES module, no DOM / Node APIs.

import { classify, parseType } from "./types.js";
import { unsupportedMsg } from "./mi.js";

const MAX_SOURCE = 4096, MAX_TOKENS = 512, MAX_DEPTH = 64;
const TOO_COMPLEX = "expression too long or nested too deeply: not supported by the browser engine";

export class ExprError extends Error {
  /** @param {string} msg @param {string} kind */
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

const TOK = /\s*(?:(0[xX][0-9a-fA-F]+|\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+|\d+[eE][-+]?\d+|\d+)([uUlLfF]*)(?![\w.])|([A-Za-z_]\w*)|(&&|\|\||==|!=|<=|>=|->|::|<<|>>|[-+*\/%<>!?:()\[\].,&|^~=]))/y;

/** @param {string} src */
function tokenize(src) {
  if (src.length > MAX_SOURCE) throw new ExprError(TOO_COMPLEX, "unsupported");
  const out = [];
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOK.lastIndex = pos;
    const m = TOK.exec(src);
    if (!m) throw new ExprError(`Invalid character '${src.slice(pos).trim()[0]}' in expression.`, "syntax");
    const start = pos + (m[0].length - m[0].trimStart().length);
    pos = TOK.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: m[1], suf: m[2].toLowerCase(), at: start });
    else if (m[3] !== undefined) out.push({ t: "id", v: m[3], at: start });
    else out.push({ t: "op", v: m[4], at: start });
    if (out.length > MAX_TOKENS) throw new ExprError(TOO_COMPLEX, "unsupported");
  }
  return out;
}

/**
 * @typedef {{ k: "num", text: string, suf: string } | { k: "id", name: string } | { k: "bin", op: string, a: any, b: any }
 *   | { k: "un", op: string, a: any } | { k: "idx", a: any, i: any } | { k: "call", a: any } | { k: "cond", c: any, a: any, b: any }} Ast
 */

/** @param {string} src @returns {Ast} */
export function parseExpr(src) {
  const toks = tokenize(src);
  let p = 0;
  const near = () => `A syntax error in expression, near \`${toks[p] ? src.slice(toks[p].at) : ""}'.`;
  const isOp = (v) => p < toks.length && toks[p].t === "op" && toks[p].v === v;
  const expect = (v) => { if (!isOp(v)) throw new ExprError(near(), "syntax"); p++; };
  let depth = 0;
  const enter = () => { if (++depth > MAX_DEPTH) throw new ExprError(TOO_COMPLEX, "unsupported"); };
  const binLevel = (ops, sub) => () => {
    let l = sub();
    while (p < toks.length && toks[p].t === "op" && ops.includes(toks[p].v)) { const op = toks[p++].v; l = { k: "bin", op, a: l, b: sub() }; }
    return l;
  };
  function ternary() {
    enter();
    const c = orE();
    let r = c;
    if (isOp("?")) { p++; const a = ternary(); expect(":"); const b = ternary(); r = { k: "cond", c, a, b }; }
    depth--;
    return r;
  }
  function unary() {
    if (isOp("-") || isOp("+") || isOp("!")) { const op = toks[p++].v; enter(); const a = unary(); depth--; return { k: "un", op, a }; }
    if (isOp("*") || isOp("&") || isOp("~")) throw new ExprError(unsupportedMsg(`operator '${toks[p].v}' in expression '${src.trim()}'`), "unsupported");
    return postfix();
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp("[")) { p++; const i = ternary(); expect("]"); v = { k: "idx", a: v, i }; }
      else if (isOp(".")) {
        p++;
        if (!(p < toks.length && toks[p].t === "id")) throw new ExprError(near(), "syntax");
        p++;
        if (!isOp("(")) throw new ExprError(unsupportedMsg(`member access in expression '${src.trim()}'`), "unsupported");
        p++; while (p < toks.length && !isOp(")")) p++; expect(")");
        v = { k: "call", a: v };
      } else if (isOp("->") || isOp("::")) throw new ExprError(unsupportedMsg(`operator '${toks[p].v}' in expression '${src.trim()}'`), "unsupported");
      else return v;
    }
  }
  function primary() {
    const t = toks[p];
    if (!t) throw new ExprError(near(), "syntax");
    p++;
    if (t.t === "num") return { k: "num", text: t.v, suf: t.suf };
    if (t.t === "id") {
      if (isOp("(")) throw new ExprError(unsupportedMsg(`function call ${t.v}()`), "unsupported");
      return { k: "id", name: t.v };
    }
    if (t.v === "(") { const v = ternary(); expect(")"); return v; }
    p--;
    throw new ExprError(near(), "syntax");
  }
  const mulE = binLevel(["*", "/", "%"], unary);
  const addE = binLevel(["+", "-"], mulE);
  const relE = binLevel(["<", ">", "<=", ">="], addE);
  const eqE = binLevel(["==", "!="], relE);
  const andE = binLevel(["&&"], eqE);
  const orE = binLevel(["||"], andE);
  const ast = ternary();
  if (p < toks.length) throw new ExprError(near(), "syntax");
  return ast;
}

/** @param {Ast} a @param {Set<string>} [out] @returns {Set<string>} identifiers used */
export function collectNames(a, out = new Set()) {
  switch (a.k) {
    case "id": out.add(a.name); break;
    case "bin": collectNames(a.a, out); collectNames(a.b, out); break;
    case "un": case "call": collectNames(a.a, out); break;
    case "idx": collectNames(a.a, out); collectNames(a.i, out); break;
    case "cond": collectNames(a.c, out); collectNames(a.a, out); collectNames(a.b, out); break;
  }
  return out;
}

// ---- values ---------------------------------------------------------------------------------------

/**
 * @typedef {{ t: "int", bits: number, uns: boolean, name: string, v: bigint } | { t: "bool", v: bigint } | { t: "char", uns: boolean, name: string, v: bigint }
 *   | { t: "float", single: boolean, v: number } | { t: "vec", cls: any, v: any[] } | { t: "str", v: string }} Val
 */

const INT_INFO = new Map([
  ["int", [32, false]], ["unsigned int", [32, true]], ["long", [64, false]], ["unsigned long", [64, true]], ["long long", [64, false]],
  ["unsigned long long", [64, true]], ["short", [16, false]], ["unsigned short", [16, true]], ["wchar_t", [32, false]],
]);

/** Convert a variable (class + raw trace value) to a Val. @param {any} cls @param {any} raw @returns {Val} */
export function fromRaw(cls, raw) {
  if (cls.kind === "ref") return fromRaw(cls.to, raw);
  const big = (x) => (typeof x === "bigint" ? x : BigInt(Math.trunc(typeof x === "number" && Number.isFinite(x) ? x : 0)));
  switch (cls.kind) {
    case "bool": return { t: "bool", v: raw ? 1n : 0n };
    case "char": return { t: "char", uns: !!cls.unsigned, name: cls.node.name, v: big(raw) };
    case "int": { const [bits, uns] = INT_INFO.get(cls.node.name) || [32, false]; return { t: "int", bits, uns, name: cls.node.name, v: big(raw) }; }
    case "float": return { t: "float", single: !!cls.single, v: typeof raw === "number" ? raw : raw === "inf" ? Infinity : raw === "-inf" ? -Infinity : raw === "nan" ? NaN : 0 };
    case "vector": return { t: "vec", cls, v: Array.isArray(raw) ? raw : [] };
    case "array": return { t: "vec", cls, v: Array.isArray(raw) ? raw : [], arr: true };
    case "string": return { t: "str", v: typeof raw === "string" ? raw : "" };
    default: throw new ExprError(unsupportedMsg(`type '${cls.node && cls.node.k === "n" ? cls.node.name : cls.kind}'`), "unsupported");
  }
}

const INT = { t: "int", bits: 32, uns: false, name: "int" };

/** integral promotion @param {Val} x @returns {Val} */
function promote(x) {
  if (x.t === "bool" || x.t === "char" || (x.t === "int" && x.bits < 32)) return { ...INT, v: x.v };
  return x;
}

const wrap = (bits, uns, v) => (uns ? BigInt.asUintN(bits, v) : BigInt.asIntN(bits, v));
const isNum = (x) => x.t === "int" || x.t === "bool" || x.t === "char" || x.t === "float";
const asNumber = (x) => (x.t === "float" ? x.v : Number(x.v));
const bool = (b) => /** @type {Val} */ ({ t: "bool", v: b ? 1n : 0n });
const truthy = (x) => (x.t === "float" ? x.v !== 0 : x.v !== 0n);

/** usual arithmetic conversions for two promoted integers @param {any} a @param {any} b */
function commonInt(a, b) {
  if (a.bits !== b.bits) return a.bits > b.bits ? a : b;
  if (a.uns !== b.uns) return a.uns ? a : b;
  return a;
}

/** @param {string} op @param {Val} x @param {Val} y @returns {Val} */
function arith(op, x, y) {
  if (!isNum(x) || !isNum(y)) throw new ExprError(unsupportedMsg("arithmetic on non-scalar values"), "unsupported");
  if (x.t === "float" || y.t === "float") {
    const a = asNumber(x), b = asNumber(y);
    const single = (x.t !== "float" || x.single) && (y.t !== "float" || y.single);
    switch (op) {
      case "+": return { t: "float", single, v: a + b };
      case "-": return { t: "float", single, v: a - b };
      case "*": return { t: "float", single, v: a * b };
      case "/": return { t: "float", single, v: a / b };
      case "%": throw new ExprError("Integer only operation MOD.", "error");
      default: return bool({ "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b, "==": a === b, "!=": a !== b }[op]);
    }
  }
  const a = /** @type {any} */ (promote(x)), b = /** @type {any} */ (promote(y));
  const t = commonInt(a, b);
  const av = wrap(t.bits, t.uns, a.v), bv = wrap(t.bits, t.uns, b.v);
  switch (op) {
    case "+": return { ...t, v: wrap(t.bits, t.uns, av + bv) };
    case "-": return { ...t, v: wrap(t.bits, t.uns, av - bv) };
    case "*": return { ...t, v: wrap(t.bits, t.uns, av * bv) };
    case "/": if (bv === 0n) throw new ExprError("Division by zero", "error"); return { ...t, v: wrap(t.bits, t.uns, av / bv) };
    case "%": if (bv === 0n) throw new ExprError("Division by zero", "error"); return { ...t, v: wrap(t.bits, t.uns, av % bv) };
    default: return bool({ "<": av < bv, ">": av > bv, "<=": av <= bv, ">=": av >= bv, "==": av === bv, "!=": av !== bv }[op]);
  }
}

/**
 * @param {Ast} a
 * @param {(name: string) => { cls: any, raw: any } | null} lookup  variable lookup of the frame the expression lives in
 * @returns {Val}
 */
export function evalAst(a, lookup) {
  try { return evalNode(a, lookup); } catch (x) {
    if (x instanceof RangeError) throw new ExprError(TOO_COMPLEX, "unsupported"); // host stack exhausted: never an internal error
    throw x;
  }
}

/** @param {Ast} a @param {(name: string) => { cls: any, raw: any } | null} lookup @returns {Val} */
function evalNode(a, lookup) {
  switch (a.k) {
    case "num": {
      const hex = /^0[xX]/.test(a.text);
      if (/[.eE]/.test(a.text) && !hex) {
        if (/[ul]/.test(a.suf) || (a.suf.includes("f") && !/[.eE]/.test(a.text))) throw new ExprError(`Invalid number "${a.text}${a.suf}".`, "syntax");
        return { t: "float", single: a.suf.includes("f"), v: Number(a.text) };
      }
      if (a.suf.includes("f") || !/^(u?(l|ll)?|(l|ll)u)$/.test(a.suf)) throw new ExprError(`Invalid number "${a.text}${a.suf}".`, "syntax");
      const octal = !hex && /^0\d/.test(a.text);
      if (octal && /[89]/.test(a.text)) throw new ExprError(`Invalid number "${a.text}".`, "syntax");
      const v = octal ? BigInt("0o" + a.text.slice(1)) : BigInt(a.text);
      const u = a.suf.includes("u"), ls = (a.suf.match(/l/g) || []).length;
      // C++ [lex.icon]: the first type that fits. Decimal without `u`: int, long (, long long); hex/octal also try the unsigned ones.
      const cands = ls === 2 ? [["long long", 64, false], ["unsigned long long", 64, true]]
        : ls === 1 ? [["long", 64, false], ["unsigned long", 64, true]]
          : [["int", 32, false], ["unsigned int", 32, true], ["long", 64, false], ["unsigned long", 64, true]];
      for (const [name, bits, uns] of cands) {
        if (u && !uns) continue;
        if (!u && uns && !(hex || octal)) continue;
        if (v < (uns ? 1n << BigInt(bits) : 1n << BigInt(bits - 1))) return { t: "int", bits: /** @type {number} */ (bits), uns: /** @type {boolean} */ (uns), name: /** @type {string} */ (name), v };
      }
      throw new ExprError("Numeric constant too large.", "syntax");
    }
    case "id": {
      if (a.name === "true" || a.name === "false") return bool(a.name === "true");
      const e = lookup(a.name);
      if (!e) throw new ExprError(`No symbol "${a.name}" in current context.`, "nosymbol");
      return fromRaw(e.cls, e.raw);
    }
    case "un": {
      const x = evalNode(a.a, lookup);
      if (!isNum(x)) throw new ExprError(unsupportedMsg("operator on non-scalar value"), "unsupported");
      if (a.op === "!") return bool(!truthy(x));
      if (x.t === "float") return { ...x, v: a.op === "-" ? -x.v : x.v };
      const p = /** @type {any} */ (promote(x));
      return a.op === "-" ? { ...p, v: wrap(p.bits, p.uns, -p.v) } : p;
    }
    case "bin": {
      if (a.op === "&&" || a.op === "||") {
        const l = evalNode(a.a, lookup);
        if (!isNum(l)) throw new ExprError(unsupportedMsg("logical operator on non-scalar value"), "unsupported");
        if (a.op === "&&" ? !truthy(l) : truthy(l)) return bool(a.op === "||");
        const r = evalNode(a.b, lookup);
        if (!isNum(r)) throw new ExprError(unsupportedMsg("logical operator on non-scalar value"), "unsupported");
        return bool(truthy(r));
      }
      return arith(a.op, evalNode(a.a, lookup), evalNode(a.b, lookup));
    }
    case "cond": {
      const c = evalNode(a.c, lookup);
      if (!isNum(c)) throw new ExprError(unsupportedMsg("condition of non-scalar type"), "unsupported");
      return truthy(c) ? evalNode(a.a, lookup) : evalNode(a.b, lookup);
    }
    case "idx": {
      const base = evalNode(a.a, lookup);
      const ix = evalNode(a.i, lookup);
      if (!(ix.t === "int" || ix.t === "char" || ix.t === "bool")) throw new ExprError("Argument to arithmetic operation not a number or boolean.", "error");
      const i = Number(ix.v);
      if (base.t === "vec") {
        if (i < 0 || i >= base.v.length) throw new ExprError("Cannot access memory at address 0x0", "error");
        return fromRaw(classify(base.cls.elem), base.v[i]); // vector element or C array element (cls.elem = element type)
      }
      if (base.t === "str") {
        if (i < 0 || i >= base.v.length) throw new ExprError("Cannot access memory at address 0x0", "error");
        return { t: "char", uns: false, name: "char", v: BigInt(base.v.charCodeAt(i)) };
      }
      throw new ExprError("cannot subscript something of type `int'", "error");
    }
    case "call": {
      evalNode(a.a, lookup); // errors of the receiver (unknown name) come first, like GDB
      throw new ExprError("Cannot evaluate function -- may be inlined", "inlined");
    }
  }
}

/** GDB type name and class of a scalar result, for varobj `type` and value formatting. @param {Val} v */
export function resultClass(v) {
  switch (v.t) {
    case "bool": return { name: "bool", cls: classify(parseType("bool")) };
    case "float": { const n = v.single ? "float" : "double"; return { name: n, cls: classify(parseType(n)) }; }
    case "char": return { name: v.name, cls: classify(parseType(v.name)) };
    case "int": return { name: v.name, cls: classify(parseType(v.name)) };
    default: return null;
  }
}

/** JS raw value matching formatScalar() for a scalar Val. @param {Val} v */
export function rawOf(v) {
  return v.t === "float" ? v.v : v.t === "bool" ? (v.v ? 1 : 0) : v.t === "int" ? v.v : Number(v.v);
}
