// @ts-check
// Evaluate a lesson `{expr}` on a trace snapshot (variable name -> JSON value). Port of
// experiments/frontend-only/e1/e2/evalexpr.mjs with the plan §6 M3 fix: variable lookups use
// own-property checks (Object.hasOwn semantics) instead of `in`, so names such as "constructor",
// "toString" or "__proto__" are never resolved through Object.prototype.
// Supported: numbers, variables, indexing a[i][j], .size()/.length()/.empty()/.back()/.front(),
// name.capacity() (pseudo variable), + - * / %, comparisons, && || !, ?:, parentheses.
// Nothing is executed; failures throw EvalError with a `kind`.

export class EvalError extends Error {
  /** @param {string} kind @param {string} msg */
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

const own = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);
const TOKEN = /\s*(?:(\d+\.\d+|\d+)|([A-Za-z_]\w*)|(&&|\|\||==|!=|<=|>=|->|[-+*/%<>!?:()\[\].,&]))/y;
const MAX_TOKENS = 512;

/** @param {string} src */
function tokenize(src) {
  /** @type {Array<{ t: string, v: any }>} */
  const out = [];
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new EvalError("syntax", "cannot parse: " + src.slice(pos, pos + 10));
    pos = TOKEN.lastIndex;
    out.push(m[1] !== undefined ? { t: "num", v: Number(m[1]) } : m[2] !== undefined ? { t: "id", v: m[2] } : { t: "op", v: m[3] });
    if (out.length > MAX_TOKENS) throw new EvalError("syntax", "expression too long");
  }
  return out;
}

/**
 * @param {string} src
 * @param {Record<string, any>} vars  snapshot (null-prototype object from the engine, or any object)
 */
export function evalExpr(src, vars) {
  if (typeof src !== "string") throw new EvalError("syntax", "expression must be a string");
  const toks = tokenize(src);
  let p = 0, depth = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const isOp = (/** @type {string} */ v) => !!peek() && peek().t === "op" && peek().v === v;
  const expect = (/** @type {string} */ v) => { if (!isOp(v)) throw new EvalError("syntax", "missing " + v); p++; };
  const num = (/** @type {any} */ x) => {
    if (typeof x === "string" && x.length === 1) return x.charCodeAt(0);
    if (typeof x !== "number") throw new EvalError("type", "not a number");
    return x;
  };
  const enter = () => { if (++depth > 64) throw new EvalError("syntax", "expression nested too deeply"); };

  /** @returns {any} */
  function ternary() {
    enter();
    const c = orExpr();
    let r = c;
    if (isOp("?")) { p++; const a = ternary(); expect(":"); const b = ternary(); r = num(c) ? a : b; }
    depth--;
    return r;
  }
  /** @param {() => any} sub @param {Record<string, (a: any, b: any) => any>} ops */
  const bin = (sub, ops) => () => {
    let l = sub();
    while (peek() && peek().t === "op" && own(ops, peek().v)) { const op = next().v; l = ops[op](l, sub()); }
    return l;
  };
  const mulLevel = () => {
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = next().v; const a = num(l), b = num(unary());
      if (op === "*") l = a * b;
      else if (b === 0) throw new EvalError("div0", "division by zero");
      else if (op === "/") l = Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
      else l = a % b;
    }
    return l;
  };
  const additive = bin(mulLevel, { "+": (a, b) => num(a) + num(b), "-": (a, b) => num(a) - num(b) });
  const rel = bin(additive, { "<": (a, b) => +(num(a) < num(b)), ">": (a, b) => +(num(a) > num(b)), "<=": (a, b) => +(num(a) <= num(b)), ">=": (a, b) => +(num(a) >= num(b)) });
  const eq = bin(rel, { "==": (a, b) => +(num(a) === num(b)), "!=": (a, b) => +(num(a) !== num(b)) });
  const andExpr = bin(eq, { "&&": (a, b) => +(!!num(a) && !!num(b)) });
  const orExpr = bin(andExpr, { "||": (a, b) => +(!!num(a) || !!num(b)) });

  /** @returns {any} */
  function unary() {
    if (isOp("-")) { p++; return -num(unary()); }
    if (isOp("!")) { p++; return +!num(unary()); }
    if (isOp("&")) throw new EvalError("unsupported", "address-of needs memory addresses, which snapshots do not have");
    return postfix();
  }
  function postfix() {
    const startTok = peek();
    let v = primary();
    let recv = startTok && startTok.t === "id" ? startTok.v : null; // only `name.capacity()`
    for (;;) {
      if (isOp("[")) {
        recv = null; p++;
        const i = num(ternary()); expect("]");
        if (!(Array.isArray(v) || typeof v === "string")) throw new EvalError("type", "value cannot be indexed");
        if (!Number.isInteger(i) || i < 0 || i >= v.length) throw new EvalError("oob", `index ${i} out of range 0..${v.length - 1}`);
        v = v[i];
      } else if (isOp(".")) {
        p++;
        const name = next();
        if (!name || name.t !== "id") throw new EvalError("syntax", "member name");
        if (!isOp("(")) throw new EvalError("unsupported", "member ." + name.v);
        p++; expect(")");
        const arr = v;
        const isC = Array.isArray(arr) || typeof arr === "string";
        if (!isC) throw new EvalError("type", "not a container");
        if (name.v === "size" || name.v === "length") v = arr.length;
        else if (name.v === "empty") v = +(arr.length === 0);
        else if (name.v === "back") { if (!arr.length) throw new EvalError("oob", "empty container"); v = arr[arr.length - 1]; }
        else if (name.v === "front") { if (!arr.length) throw new EvalError("oob", "empty container"); v = arr[0]; }
        else if (name.v === "capacity" && recv !== null && own(vars, recv + ".capacity()")) v = vars[recv + ".capacity()"];
        else throw new EvalError("unsupported", "member function " + name.v + "() is not recorded in snapshots");
      } else return v;
    }
  }
  function primary() {
    const t = next();
    if (!t) throw new EvalError("syntax", "incomplete expression");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      if (isOp("(")) throw new EvalError("unsupported", "function call " + t.v + "()");
      if (!own(vars, t.v)) throw new EvalError("undefined", "variable " + t.v + " is not in scope");
      return vars[t.v];
    }
    if (t.v === "(") { const v = ternary(); expect(")"); return v; }
    throw new EvalError("syntax", "unexpected " + t.v);
  }
  const v = ternary();
  if (p < toks.length) throw new EvalError("syntax", "trailing characters");
  return v;
}
