// Pure unit tests (no compiler): C++ type-string expansion / value formatting, and the lexical-block
// analysis LocalGdb derives from the source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseType, gdbType, gdbTypeOfQual, signatureType, classify, isSupported, isSimple, isDynamic, formatScalar, formatG } from "../../../gdbgui/static/engine/localgdb/types.js";
import { analyzeScopes, chainAt, lex } from "../../../gdbgui/static/engine/localgdb/scopes.js";
import { ROOT } from "./golden_replay.mjs";

test("type expansion is libstdc++-style (the spec's example, spaces before `>`)", () => {
  assert.equal(gdbTypeOfQual("std::vector<std::vector<int>>"), "std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > >");
  assert.equal(gdbTypeOfQual("std::vector<int>"), "std::vector<int, std::allocator<int> >");
  assert.equal(gdbTypeOfQual("std::vector<int, std::allocator<int> >"), "std::vector<int, std::allocator<int> >", "already expanded input is left alone");
  assert.equal(gdbTypeOfQual("std::vector<std::vector<std::vector<int>>>"), "std::vector<std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > >, std::allocator<std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > > > >");
});

test("type spelling: builtins, string, containers, pointers, references, arrays, const, aliases", () => {
  const t = (q) => gdbTypeOfQual(q);
  assert.deepEqual(["int", "long long", "unsigned int", "unsigned", "long", "long int", "unsigned long long", "short", "unsigned char", "signed char", "char", "bool", "double", "float", "long double"].map(t),
    ["int", "long long", "unsigned int", "unsigned int", "long", "long", "unsigned long long", "short", "unsigned char", "signed char", "char", "bool", "double", "float", "long double"]);
  assert.equal(t("std::string"), "std::string");
  assert.equal(t("std::vector<std::string>"), "std::vector<std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >, std::allocator<std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> > > >");
  assert.equal(t("size_t"), "unsigned long");
  assert.equal(t("__int64"), "long long");
  assert.equal(t("const int"), "const int");
  assert.equal(t("int *"), "int *");
  assert.equal(t("char **"), "char **");
  assert.equal(t("std::vector<int> &"), "std::vector<int, std::allocator<int> > &");
  assert.equal(t("const std::string &"), "const std::string &");
  assert.equal(t("int[3]"), "int [3]");
  assert.equal(t("int[3][4]"), "int [3][4]");
  assert.equal(t("std::map<int, int>"), "std::map<int, int, std::less<int>, std::allocator<std::pair<const int, int> > >");
  assert.equal(t("std::set<int>"), "std::set<int, std::less<int>, std::allocator<int> >");
  assert.equal(t("std::deque<int>"), "std::deque<int, std::allocator<int> >");
  assert.equal(t("std::stack<int>"), "std::stack<int, std::deque<int, std::allocator<int> > >");
  assert.equal(t("std::priority_queue<int>"), "std::priority_queue<int, std::vector<int, std::allocator<int> >, std::less<int> >");
  assert.equal(t("std::pair<int, std::string>"), "std::pair<int, std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> > >");
  assert.equal(t("Pt"), "Pt");
  assert.equal(t("some weird ((( type"), "some weird ((( type", "unparsable input is passed through");
  assert.equal(signatureType(parseType("std::vector<int> &")), "std::vector<int, std::allocator<int> >&");
  assert.equal(signatureType(parseType("char *")), "char*");
});

test("classification: supported set, simple values, dynamic (pretty-printed) types", () => {
  const c = (q) => classify(parseType(q));
  for (const q of ["int", "long long", "bool", "char", "double", "float", "std::string", "std::vector<int>", "std::vector<std::vector<int>>", "std::vector<std::string>", "std::vector<double> &", "unsigned"]) assert.equal(isSupported(c(q)), true, q);
  for (const q of ["std::map<int,int>", "std::set<int>", "std::deque<int>", "std::stack<int>", "std::queue<int>", "std::priority_queue<int>", "int *", "int[3]", "Pt", "std::vector<bool>", "std::vector<std::map<int,int>>", "std::pair<int,int>"]) assert.equal(isSupported(c(q)), false, q);
  assert.deepEqual(["int", "bool", "char", "double", "int *", "int &", "std::string", "std::vector<int>", "int[3]", "Pt", "std::vector<int> &"].map((q) => isSimple(c(q))), [true, true, true, true, true, true, false, false, false, false, false]);
  assert.deepEqual(["std::vector<int>", "std::string", "int", "std::vector<int> &"].map((q) => isDynamic(c(q))), [true, true, false, true]);
});

test("value formatting like GDB: bool, char escapes, floating point (%g with 17/9 digits), strings", () => {
  const f = (q, v) => formatScalar(classify(parseType(q)), v);
  assert.deepEqual([f("int", 5), f("long long", 1234567890123), f("bool", 1), f("bool", 0)], ["5", "1234567890123", "true", "false"]);
  assert.deepEqual([f("char", 97), f("char", 10), f("char", 0), f("char", 39), f("char", 92), f("char", 7), f("char", 27), f("char", 200), f("char", -1), f("unsigned char", 255)], ["97 'a'", "10 '\\n'", "0 '\\000'", "39 '\\''", "92 '\\\\'", "7 '\\a'", "27 '\\033'", "200 '\\310'", "-1 '\\377'", "255 '\\377'"]);
  assert.deepEqual([0.1, 1.5, 100, 0, -2.5, 1e20, 1e-5, 123456789.125, 3.141592653589793, 1e16, 1e17].map((v) => f("double", v)), ["0.10000000000000001", "1.5", "100", "0", "-2.5", "1e+20", "1.0000000000000001e-05", "123456789.125", "3.1415926535897931", "10000000000000000", "1e+17"]);
  assert.deepEqual([f("float", 0.1), f("float", 1.5), f("float", 16777216)], ["0.100000001", "1.5", "16777216"]);
  assert.deepEqual([f("double", "nan"), f("double", "inf"), f("double", "-inf")], ["nan(0x8000000000000)", "inf", "-inf"]);
  assert.deepEqual([f("std::string", "hi"), f("std::string", 'a"b\\c\n'), f("std::string", ""), f("std::string", "é")], ['"hi"', '"a\\"b\\\\c\\n"', '""', '"é"']);
  assert.equal(formatG(-0, 17), "-0");
});

// ---- scopes -------------------------------------------------------------------------------------

const meta = (line, closeLine, params, vars) => ({ line, closeLine, params, vars });
const names = (b) => b.vars.map((v) => v.name).join(",");
const visible = (sc, line) => chainAt(sc, line).map((b) => `${b.kind}[${names(b)}]`);

test("scopes: the golden lesson's blocks reproduce GDB's variable order at every line (checked against the golden sample's variable lists)", () => {
  const src = fs.readFileSync(path.join(ROOT, "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp"), "utf8");
  const functions = { main: meta(21, 64, [], ["INF", "h", "w", "cost", "i", "j", "dp", "nxt", "cand", "best", "bestRow", "k", "r", "start"]) };
  const sc = analyzeScopes(src, functions, { INF: "const int" }).get("main");
  const order = (line) => chainAt(sc, line).flatMap((b) => b.vars.map((v) => v.name)).join(" ");
  // (line -> variable order) exactly as GDB listed them in the golden sample (raw_events.jsonl, -stack-list-variables)
  assert.equal(order(23), "h w cost dp nxt start r");
  assert.equal(order(33), "i h w cost dp nxt start r");
  assert.equal(order(34), "i h w cost dp nxt start r");
  assert.equal(order(36), "j h w cost dp nxt start r");
  assert.equal(order(37), "i j h w cost dp nxt start r");
  assert.equal(order(38), "cand best bestRow i j h w cost dp nxt start r");
  assert.equal(order(41), "k cand best bestRow i j h w cost dp nxt start r");
  assert.equal(order(42), "r k cand best bestRow i j h w cost dp nxt start r", "the inner r shadows the outer one; GDB lists both");
  assert.equal(order(45), "r k cand best bestRow i j h w cost dp nxt start r");
  assert.equal(order(51), "h w cost dp nxt start r");
  assert.equal(order(52), "i h w cost dp nxt start r");
  assert.equal(order(57), "h w cost dp nxt start r");
  assert.ok(!order(23).includes("INF"), "globals are not locals");
  assert.deepEqual(sc.blocks.filter((b) => b.kind === "for").map((b) => [b.start, b.end, names(b)]).slice(0, 4), [[25, 29, "i"], [26, 28, "j"], [33, 35, "i"], [36, 50, "j"]]);
});

test("scopes: parameters first, multi-declarators, arrays, range-for, structured bindings, comments/strings with braces, one-line for", () => {
  const src = [
    "int f(int a, int b) {",            // 1
    "    int x = 1, y[2] = {1, 2}, *p = &x;", // 2
    "    // int ghost = 0; { { {",      // 3
    '    const char* s = "} for (int q = 0;;) {";', // 4
    "    for (auto& e : y) x += e;",    // 5
    "    for (int i = 0, j = 1; i < 3; ++i) { int t = i; x += t; }", // 6
    "    if (x > 0) {",                 // 7
    "        int u = 2;",               // 8
    "    } else {",                     // 9
    "        int w = 3;",               // 10
    "    }",                            // 11
    "    auto [m, n] = std::make_pair(1, 2);", // 12
    "    return x;",                    // 13
    "}",                                // 14
  ].join("\n");
  const sc = analyzeScopes(src, { f: meta(1, 14, ["a", "b"], ["a", "b", "x", "y", "p", "s", "e", "i", "j", "t", "u", "w", "m", "n"]) }).get("f");
  assert.equal(names(sc.blocks[0]), "a,b,x,y,p,s,m,n");
  const kinds = sc.blocks.slice(1).map((b) => `${b.kind}:${b.start}-${b.end}:${names(b)}`);
  assert.deepEqual(kinds, ["for:5-5:e", "for:6-6:i,j", "body:6-6:t", "body:8-9:u", "body:10-11:w"]);
  assert.deepEqual(visible(sc, 5), ["for[e]", "function[a,b,x,y,p,s,m,n]"]);
  assert.deepEqual(visible(sc, 8), ["body[u]", "function[a,b,x,y,p,s,m,n]"]);
  assert.deepEqual(visible(sc, 13), ["function[a,b,x,y,p,s,m,n]"]);
});

test("scopes: same name declared twice keeps its declaration order (nth) for type lookup; unplaced names fall back to the function block", () => {
  const src = "void g() {\n  { int v = 1; }\n  { double v = 2; }\n  MACRO_DECL(z);\n}\n";
  const sc = analyzeScopes(src, { g: meta(1, 5, [], ["v", "z"]) }).get("g");
  const bodies = sc.blocks.filter((b) => b.kind === "body");
  assert.deepEqual(bodies.map((b) => [b.start, b.vars[0].name, b.vars[0].nth]), [[2, "v", 0], [3, "v", 1]]);
  assert.equal(names(sc.blocks[0]), "z", "z is not seen as a declaration: function block fallback");
});

test("lexer: comments, strings, char literals, raw strings and preprocessor lines never produce tokens", () => {
  const toks = lex('#define X {\nint a; // {\n/* } */ char c = \'}\'; const char* s = "{"; auto r = R"x(})x";\n').map((t) => t.t);
  assert.deepEqual(toks, ["int", "a", ";", "char", "c", "=", "'chr'", ";", "const", "char", "*", "s", "=", '"str"', ";", "auto", "r", "=", '"str"', ";"]);
});

test("`using namespace std;` programs: unqualified std names (clang prints `vector<int>`) get the same expansion and support", () => {
  assert.equal(gdbTypeOfQual("vector<vector<int> >"), gdbTypeOfQual("std::vector<std::vector<int>>"));
  assert.equal(gdbTypeOfQual("vector<int>"), "std::vector<int, std::allocator<int> >");
  assert.equal(gdbTypeOfQual("string"), "std::string");
  assert.equal(gdbTypeOfQual("vector<string> &"), gdbTypeOfQual("std::vector<std::string> &"));
  assert.equal(gdbTypeOfQual("map<int, int>"), gdbTypeOfQual("std::map<int, int>"));
  assert.equal(isSupported(classify(parseType("vector<vector<int> >"))), true);
  assert.equal(isSupported(classify(parseType("map<int, int>"))), false);
  assert.equal(gdbTypeOfQual("mylib::vector<int>"), "mylib::vector<int>", "qualified user names are left alone");
});
