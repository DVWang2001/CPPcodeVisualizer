// C++ type strings: parse the clang AST `qualType` recorded in the engine result (`decls`), expand it
// to the libstdc++ spelling GDB prints (spec S4: `std::vector<std::vector<int>>` ->
// `std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > >`),
// classify it for the supported-type set, and format values the way GDB does.
// Plain ES module, no DOM / Node APIs.

/**
 * @typedef {{ k: "n", name: string, args: TypeNode[], c: boolean }
 *   | { k: "p", to: TypeNode }
 *   | { k: "r", to: TypeNode }
 *   | { k: "a", of: TypeNode, dim: string }} TypeNode
 */

/** Standard names clang prints unqualified after `using namespace std;` (normalised to their std:: spelling). */
const STD_UNQUALIFIED = new Set(["vector", "deque", "list", "forward_list", "set", "multiset", "map", "multimap", "unordered_map", "unordered_set", "unordered_multimap", "unordered_multiset", "stack", "queue", "priority_queue", "pair", "array", "string", "basic_string"]);

const BUILTIN_WORDS = new Set(["unsigned", "signed", "short", "long", "int", "char", "bool", "float", "double", "void", "wchar_t", "char16_t", "char32_t", "__int128"]);

/** @param {string} s @returns {string[]} */
function tokenize(s) {
  const toks = [];
  const re = /\s*(::|&&|[<>,*&\[\]]|[A-Za-z_][\w]*|\d+)/y;
  let pos = 0;
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error("cannot parse type: " + s);
    toks.push(m[1]);
    pos = re.lastIndex;
  }
  return toks;
}

/**
 * Parse a C++ type spelling (clang `qualType`) into a small tree.
 * @param {string} q
 * @returns {TypeNode}
 */
export function parseType(q) {
  const toks = tokenize(q);
  let i = 0;
  /** @returns {TypeNode} */
  function parseOne() {
    let c = false;
    const words = [];
    const takeQuals = () => { while (toks[i] === "const" || toks[i] === "volatile") { if (toks[i] === "const") c = true; i++; } };
    takeQuals();
    /** @type {TypeNode} */
    let node;
    if (BUILTIN_WORDS.has(toks[i])) {
      while (i < toks.length && (BUILTIN_WORDS.has(toks[i]) || toks[i] === "const")) { if (toks[i] === "const") c = true; else words.push(toks[i]); i++; }
      node = { k: "n", name: builtinName(words), args: [], c };
    } else {
      let name = "";
      let args = [];
      if (toks[i] === "::") i++;
      for (;;) {
        if (i >= toks.length || !/^[A-Za-z_]/.test(toks[i])) throw new Error("cannot parse type: " + q);
        name += toks[i++];
        if (toks[i] === "<") {
          i++;
          args = [];
          if (toks[i] !== ">") for (;;) { args.push(parseOne()); if (toks[i] === ",") { i++; continue; } break; }
          if (toks[i] !== ">") throw new Error("unbalanced template in type: " + q);
          i++;
        }
        if (toks[i] === "::") { name += "::"; i++; continue; }
        break;
      }
      if (!name.includes("::") && STD_UNQUALIFIED.has(name)) name = "std::" + name; // `using namespace std;` programs
      node = { k: "n", name, args, c };
    }
    takeQuals();
    if (c) node.c = true;
    for (;;) {
      if (toks[i] === "*") { i++; node = { k: "p", to: node }; takeQuals(); } else if (toks[i] === "&" || toks[i] === "&&") { i++; node = { k: "r", to: node }; } else break;
    }
    const dims = [];
    while (toks[i] === "[") { i++; dims.push(/^\d+$/.test(toks[i]) ? toks[i++] : ""); if (toks[i] === "]") i++; }
    for (let d = dims.length - 1; d >= 0; d--) node = { k: "a", of: node, dim: dims[d] };
    return node;
  }
  const n = parseOne();
  if (i < toks.length) throw new Error("trailing characters in type: " + q);
  return n;
}

/** @param {string[]} w */
function builtinName(w) {
  const has = (x) => w.includes(x);
  const longs = w.filter((x) => x === "long").length;
  const unsigned = has("unsigned");
  if (has("double")) return longs ? "long double" : "double";
  if (has("float")) return "float";
  if (has("bool")) return "bool";
  if (has("void")) return "void";
  if (has("wchar_t")) return "wchar_t";
  if (has("char")) return has("signed") ? "signed char" : unsigned ? "unsigned char" : "char";
  if (has("short")) return unsigned ? "unsigned short" : "short";
  if (longs >= 2) return unsigned ? "unsigned long long" : "long long";
  if (longs === 1) return unsigned ? "unsigned long" : "long";
  return unsigned ? "unsigned int" : "int";
}

const STD_STRING_FULL = "std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >";
const ALIASES = new Map([
  ["size_t", "unsigned long"], ["std::size_t", "unsigned long"], ["ssize_t", "long"], ["ptrdiff_t", "long"], ["std::ptrdiff_t", "long"],
  ["__int64", "long long"], ["int64_t", "long"], ["uint64_t", "unsigned long"], ["int32_t", "int"], ["uint32_t", "unsigned int"],
  ["std::int64_t", "long"], ["std::uint64_t", "unsigned long"], ["std::int32_t", "int"], ["std::uint32_t", "unsigned int"],
  ["int8_t", "signed char"], ["uint8_t", "unsigned char"], ["int16_t", "short"], ["uint16_t", "unsigned short"],
  ["string", "std::string"],
]);

/** `name<a, b>` with GDB's `> >` spacing. @param {string} name @param {string[]} args */
function tmpl(name, args) {
  const inner = args.join(", ");
  return `${name}<${inner}${inner.endsWith(">") ? " " : ""}>`;
}

/**
 * GDB's spelling of a type. `inTemplate` selects the fully expanded std::string spelling used
 * inside template argument lists.
 * @param {TypeNode} t
 * @param {boolean} [inTemplate]
 * @returns {string}
 */
export function gdbType(t, inTemplate = false) {
  if (t.k === "p" && t.to.k === "a") { // pointer to array: `int (*)[3]`
    const s = gdbType(t.to, inTemplate);
    const i = s.indexOf(" [");
    return `${s.slice(0, i)} (*)${s.slice(i + 1)}`;
  }
  if (t.k === "p") { const s = gdbType(t.to, inTemplate); return s.endsWith("*") ? s + "*" : s + " *"; }
  if (t.k === "r") return gdbType(t.to, inTemplate) + " &";
  if (t.k === "a") {
    const dims = [];
    /** @type {TypeNode} */
    let cur = t;
    while (cur.k === "a") { dims.push(cur.dim); cur = cur.of; }
    return `${gdbType(cur, inTemplate)} ${dims.map((d) => `[${d}]`).join("")}`;
  }
  const name = ALIASES.get(t.name) || t.name;
  const a = t.args.map((x) => gdbType(x, true));
  const pre = t.c ? "const " : "";
  if (name === "std::string" || name === "std::basic_string") return pre + (inTemplate ? STD_STRING_FULL : "std::string");
  const alloc = (e) => tmpl("std::allocator", [e]);
  let body;
  switch (name) {
    case "std::vector": case "std::deque": case "std::list": case "std::forward_list":
      body = a.length === 1 ? tmpl(name, [a[0], alloc(a[0])]) : tmpl(name, a); break;
    case "std::set": case "std::multiset":
      body = a.length === 1 ? tmpl(name, [a[0], tmpl("std::less", [a[0]]), alloc(a[0])]) : tmpl(name, a); break;
    case "std::map": case "std::multimap":
      body = a.length === 2 ? tmpl(name, [a[0], a[1], tmpl("std::less", [a[0]]), alloc(tmpl("std::pair", ["const " + a[0], a[1]]))]) : tmpl(name, a); break;
    case "std::unordered_set": case "std::unordered_multiset":
      body = a.length === 1 ? tmpl(name, [a[0], tmpl("std::hash", [a[0]]), tmpl("std::equal_to", [a[0]]), alloc(a[0])]) : tmpl(name, a); break;
    case "std::unordered_map": case "std::unordered_multimap":
      body = a.length === 2 ? tmpl(name, [a[0], a[1], tmpl("std::hash", [a[0]]), tmpl("std::equal_to", [a[0]]), alloc(tmpl("std::pair", ["const " + a[0], a[1]]))]) : tmpl(name, a); break;
    case "std::stack": case "std::queue":
      body = a.length === 1 ? tmpl(name, [a[0], tmpl("std::deque", [a[0], alloc(a[0])])]) : tmpl(name, a); break;
    case "std::priority_queue":
      body = a.length === 1 ? tmpl(name, [a[0], tmpl("std::vector", [a[0], alloc(a[0])]), tmpl("std::less", [a[0]])]) : tmpl(name, a); break;
    default:
      body = t.args.length ? tmpl(name, a) : name;
  }
  return pre + body;
}

/** @param {string} q @returns {string} GDB type string for a clang qualType */
export function gdbTypeOfQual(q) {
  try { return gdbType(parseType(q)); } catch { return q; }
}

/** Function-signature spelling of a type (`std::vector<int, std::allocator<int> >&`). @param {TypeNode} t */
export function signatureType(t) {
  return gdbType(t).replace(/ &$/, "&").replace(/ \*/g, "*");
}

const INT_NAMES = new Set(["int", "unsigned int", "long", "unsigned long", "long long", "unsigned long long", "short", "unsigned short", "wchar_t", "__int128"]);
const CHAR_NAMES = new Set(["char", "signed char", "unsigned char"]);
const FLOAT_NAMES = new Set(["float", "double", "long double"]);

/**
 * @typedef {{ kind: "int" | "bool" | "char" | "float" | "string" | "vector" | "vectorbool" | "ptr" | "array" | "ref" | "other", node: TypeNode,
 *   unsigned?: boolean, single?: boolean, elem?: TypeNode, to?: Cls, n?: number }} Cls
 */

/** @param {TypeNode} t @returns {Cls} */
export function classify(t) {
  if (t.k === "p") return { kind: "ptr", node: t };
  if (t.k === "a") return { kind: "array", node: t, elem: t.of, n: /^\d+$/.test(t.dim) ? Number(t.dim) : -1 };
  if (t.k === "r") return { kind: "ref", node: t, to: classify(t.to) };
  const name = ALIASES.get(t.name) || t.name;
  if (INT_NAMES.has(name)) return { kind: "int", node: t, unsigned: name.startsWith("unsigned") };
  if (name === "bool") return { kind: "bool", node: t };
  if (CHAR_NAMES.has(name)) return { kind: "char", node: t, unsigned: name === "unsigned char" };
  if (FLOAT_NAMES.has(name)) return { kind: "float", node: t, single: name === "float" };
  if (name === "std::string" || name === "std::basic_string") return { kind: "string", node: t };
  if (name === "std::vector" && t.args.length >= 1) {
    const e = t.args[0];
    if (e.k === "n" && e.name === "bool") return { kind: "vectorbool", node: t };
    return { kind: "vector", node: t, elem: e };
  }
  return { kind: "other", node: t };
}

/** Types shown with a value by `-stack-list-variables --simple-values` (not aggregates/classes). @param {Cls} c */
export function isSimple(c) {
  if (c.kind === "ref") return isSimple(/** @type {Cls} */ (c.to));
  return c.kind === "int" || c.kind === "bool" || c.kind === "char" || c.kind === "float" || c.kind === "ptr";
}

/**
 * The S4 minimal supported set for variable objects: int/bool/char/double/long long/std::string and
 * std::vector<T> (T supported, nested vectors included); references to those.
 * @param {Cls} c
 * @returns {boolean}
 */
export function isSupported(c) {
  switch (c.kind) {
    case "int": case "bool": case "char": case "float": case "string": return true;
    case "ref": return isSupported(/** @type {Cls} */ (c.to));
    case "vector": return isSupported(classify(/** @type {TypeNode} */ (c.elem)));
    case "array": return /** @type {any} */ (c).n >= 0 && isSupported(classify(/** @type {TypeNode} */ (c.elem)));
    default: return false;
  }
}

/** True for values GDB prints through a pretty-printer (dynamic children). @param {Cls} c */
export function isDynamic(c) {
  if (c.kind === "ref") return isDynamic(/** @type {Cls} */ (c.to));
  return c.kind === "vector" || c.kind === "string";
}

const CHAR_ESC = new Map([[7, "\\a"], [8, "\\b"], [9, "\\t"], [10, "\\n"], [11, "\\v"], [12, "\\f"], [13, "\\r"], [27, "\\033"]]);

/** @param {number} c @param {string} quote */
function escChar(c, quote) {
  const u = c & 0xff;
  if (CHAR_ESC.has(u)) return /** @type {string} */ (CHAR_ESC.get(u));
  if (u === 92) return "\\\\";
  if (String.fromCharCode(u) === quote) return "\\" + quote;
  if (u >= 32 && u < 127) return String.fromCharCode(u);
  return "\\" + u.toString(8).padStart(3, "0");
}

/** @param {number} v @param {number} prec printf("%.{prec}g") */
export function formatG(v, prec) {
  if (Number.isNaN(v)) return "nan(0x8000000000000)";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const e = v.toExponential(prec - 1); // d.ddde+X
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
  if (!m) return String(v);
  const exp = Number(m[4]);
  const digits = (m[2] + (m[3] || "")).replace(/0+$/, "") || "0";
  if (exp < -4 || exp >= prec) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return `${m[1]}${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp >= 0) {
    const ip = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const fp = digits.slice(exp + 1);
    return `${m[1]}${ip}${fp ? "." + fp : ""}`;
  }
  return `${m[1]}0.${"0".repeat(-exp - 1)}${digits}`;
}

/** @param {string} s */
function quoteString(s) {
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if (ch === '"') o += '\\"';
    else if (ch === "\\") o += "\\\\";
    else if (c < 128) o += escChar(c, '"');
    else o += ch;
  }
  return o + '"';
}

/**
 * Format one scalar/string raw trace value; containers are formatted by the callers (length/capacity).
 * @param {Cls} c
 * @param {any} raw
 * @returns {string}
 */
export function formatScalar(c, raw) {
  switch (c.kind) {
    case "bool": return raw ? "true" : "false";
    case "int": return typeof raw === "number" || typeof raw === "bigint" ? String(raw) : "0";
    case "char": {
      const n = typeof raw === "number" ? raw : 0;
      return `${n} '${escChar(n, "'")}'`;
    }
    case "float": {
      let v = typeof raw === "number" ? raw : raw === "nan" ? NaN : raw === "inf" ? Infinity : raw === "-inf" ? -Infinity : 0;
      if (c.single) return formatG(Math.fround(v), 9);
      return formatG(v, 17);
    }
    case "string": return printChars(typeof raw === "string" ? [...raw].map((ch) => ch.codePointAt(0) || 0) : [], false);
    case "ptr": return raw === 0 || raw === undefined ? "0x0" : "0x7ffe00000000";
    case "ref": return formatScalar(/** @type {Cls} */ (c.to), raw);
    default: return "{...}";
  }
}

// ---- GDB `print` formatting of aggregates (defaults: `set print elements 200`, `set print repeats 10`) ------------------

export const PRINT_ELEMENTS = 200;
export const REPEAT_THRESHOLD = 10;

/** @param {number} c */
const quoteChar = (c) => (c > 127 ? String.fromCodePoint(c) : escChar(c, '"'));

/**
 * GDB's printstr: quoted segments, runs longer than the repeat threshold as `'c' <repeats N times>`, at most
 * 200 characters (a repeat group counts as 10), then `...`. `charArray` applies c_value_print_array's rule of not
 * printing the final NUL of a char array that was not truncated.
 * @param {number[]} codes @param {boolean} charArray @returns {string}
 */
export function printChars(codes, charArray) {
  let len = codes.length;
  if (charArray && len > 0 && len <= PRINT_ELEMENTS && (codes[len - 1] & 0xff) === 0) len--;
  if (len === 0) return '""';
  const parts = [];
  let seg = null, things = 0, i = 0;
  const norm = (c) => (charArray ? c & 0xff : c);
  while (i < len && things < PRINT_ELEMENTS) {
    const c = norm(codes[i]);
    let j = i + 1;
    while (j < len && norm(codes[j]) === c) j++;
    const reps = j - i;
    if (reps > REPEAT_THRESHOLD) {
      if (seg !== null) { parts.push(`"${seg}"`); seg = null; }
      parts.push(`'${c > 127 ? String.fromCodePoint(c) : escChar(c, "'")}' <repeats ${reps} times>`);
      things += REPEAT_THRESHOLD;
      i = j;
    } else {
      seg = (seg || "") + quoteChar(c);
      things++;
      i++;
    }
  }
  if (seg !== null) parts.push(`"${seg}"`);
  return parts.join(", ") + (i < len ? "..." : "");
}

/** @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Full GDB `print` value (as in `-stack-list-variables --all-values`, `-data-evaluate-expression`, frame args):
 * arrays `{1, 2, 0 <repeats 11 times>}` with the 200-element limit, char arrays as strings, vectors through the
 * libstdc++ printer `std::vector of length N, capacity M = {...}` (children are not repeat-compressed), scalars.
 * @param {Cls} cls @param {any} raw @param {number} [capacity] outermost vector capacity (inner vectors: length)
 * @returns {string}
 */
export function printValue(cls, raw, capacity) {
  if (cls.kind === "ref") return printValue(/** @type {Cls} */ (cls.to), raw, capacity);
  if (cls.kind === "array") {
    const ec = classify(/** @type {TypeNode} */ (cls.elem));
    const a = Array.isArray(raw) ? raw : [];
    if (ec.kind === "char") return printChars(a.map((x) => (typeof x === "number" ? x : 0)), true);
    const out = [];
    let i = 0, things = 0;
    for (; i < a.length && things < PRINT_ELEMENTS; i++) {
      let j = i + 1;
      while (j < a.length && same(a[j], a[i])) j++;
      const reps = j - i;
      const el = printValue(ec, a[i]);
      if (reps > REPEAT_THRESHOLD) { out.push(`${el} <repeats ${reps} times>`); i = j - 1; things += REPEAT_THRESHOLD; }
      else { out.push(el); things++; }
    }
    return `{${out.join(", ")}${i < a.length ? "..." : ""}}`;
  }
  if (cls.kind === "vector") {
    const a = Array.isArray(raw) ? raw : [];
    const head = `std::vector of length ${a.length}, capacity ${capacity === undefined ? a.length : capacity}`;
    if (!a.length) return head;
    const ec = classify(/** @type {TypeNode} */ (cls.elem));
    const shown = a.slice(0, PRINT_ELEMENTS).map((x) => printValue(ec, x));
    return `${head} = {${shown.join(", ")}${a.length > PRINT_ELEMENTS ? "..." : ""}}`;
  }
  return formatScalar(cls, raw);
}
