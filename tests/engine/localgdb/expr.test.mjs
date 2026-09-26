// Typed expression evaluator (expr.js): C++ semantics, and agreement with the engine's untyped evalexpr.js on the grammar they share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpr, evalAst, resultClass, rawOf, collectNames } from "../../../gdbgui/static/engine/localgdb/expr.js";
import { classify, parseType, formatScalar } from "../../../gdbgui/static/engine/localgdb/types.js";
import { evalExpr } from "../../../gdbgui/static/engine/evalexpr.js";

const vars = { a: [classify(parseType("int")), 7], b: [classify(parseType("int")), -3], n: [classify(parseType("long long")), 5000000000], u: [classify(parseType("unsigned int")), 5], v: [classify(parseType("std::vector<int>")), [1, 2, 3]], g: [classify(parseType("std::vector<std::vector<int>>")), [[1, 2], [3, 4]]], t: [classify(parseType("bool")), 1] };
const lookup = (name) => (Object.prototype.hasOwnProperty.call(vars, name) ? { cls: vars[name][0], raw: vars[name][1] } : null);
const ev = (src) => { const v = evalAst(parseExpr(src), lookup); const rc = resultClass(v); return [formatScalar(rc.cls, rawOf(v)), rc.name]; };

test("C++ typing and values", () => {
  assert.deepEqual(ev("a + b"), ["4", "int"]);
  assert.deepEqual(ev("a / b"), ["-2", "int"]);
  assert.deepEqual(ev("a % b"), ["1", "int"]);
  assert.deepEqual(ev("n * 2"), ["10000000000", "long long"]);
  assert.deepEqual(ev("u - 6"), ["4294967295", "unsigned int"]);
  assert.deepEqual(ev("u - 6 > 0"), ["true", "bool"]);
  assert.deepEqual(ev("b < 0"), ["true", "bool"]);
  assert.deepEqual(ev("t + t"), ["2", "int"]);
  assert.deepEqual(ev("a * 0.5"), ["3.5", "double"]);
  assert.deepEqual(ev("g[1][0] * v[2]"), ["9", "int"]);
  assert.deepEqual(ev("1 ? a : b"), ["7", "int"]);
  assert.deepEqual(ev("0 && zzz"), ["false", "bool"], "&& short-circuits like C++ (the unknown name is never looked up)");
  assert.throws(() => ev("a / (b + 3)"), /Division by zero/);
  assert.deepEqual([...collectNames(parseExpr("a + v[b] * g[0][t]"))].sort(), ["a", "b", "g", "t", "v"]);
});

test("agreement with evalexpr.js on the shared grammar (integer expressions without wrap-around)", () => {
  const snap = { a: 7, b: -3, t: 1, v: [1, 2, 3], g: [[1, 2], [3, 4]] };
  for (const src of ["a + b * 2", "(a - b) * (a + b)", "a / 2", "a % 4", "a > b", "a <= b", "a == 7 && b < 0", "!t", "v[1] + g[1][0]", "a > 3 ? a : b", "-a + 1", "v[a - 6]"]) {
    const [ours] = ev(src);
    const theirs = evalExpr(src, snap);
    assert.equal(ours, typeof theirs === "number" && /[<>=!&]/.test(src.replace(/[-+*%\/]/g, "")) && !/\?/.test(src) ? (theirs ? "true" : "false") : String(theirs), src);
  }
});

test("parser errors use GDB's wording", () => {
  assert.throws(() => parseExpr("a +"), /A syntax error in expression, near `'\./);
  assert.throws(() => parseExpr("a b"), /A syntax error in expression, near `b'\./);
  assert.throws(() => parseExpr("a $ b"), /Invalid character/);
  assert.throws(() => parseExpr("*a"), /not supported by the browser engine/);
  assert.throws(() => parseExpr("f(a)"), /not supported by the browser engine/);
  assert.throws(() => evalAst(parseExpr("v.size()"), lookup), /Cannot evaluate function -- may be inlined/);
  assert.throws(() => evalAst(parseExpr("zz + 1"), lookup), /No symbol "zz" in current context\./);
  assert.throws(() => evalAst(parseExpr("v[3]"), lookup), /Cannot access memory/);
});
