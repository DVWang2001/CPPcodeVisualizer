// 執行錯誤圖解（P2）的資料層：從這次執行的錯誤紀錄（runtimeErrors、exit）與軌跡（LocalGdb TraceModel 的 steps）
// 算出每個畫面要的值。純函式、沒有 DOM；畫面在 RuntimeErrorView.tsx，設計稿在 docs/superpowers/designs/runtime-errors-p2/。
// 規則（規劃文件 §4.1、§11）：圖上的值全部來自這次執行，不寫死；「值從哪裡來」指向寫入那個值的那一步；
// 空指標的物件圖不畫箭頭（軌跡只記得指標是不是 nullptr）。「和原生 Linux 比較」的句子只寫 §11 實測過的行為。
// 軌跡的語意：steps[k].vars 是停在第 k 步（那一行還沒執行）時的值，所以「寫入 x 的那一步」是 x 在下一步才變的那一步。
// 錯誤紀錄的 col 是 UTF-8 位元組位置（clang），行裡有中文時要先換成字元位置（byteColToIndex）。

// tsconfig 的 lib 是 es2015，沒有 BigInt 的型別；執行環境（瀏覽器、jest）都有 BigInt。
declare const BigInt: any;

export interface RtStep {
  line: number;
  fn: string;
  depth: number;
  frame: number;
  vars: { [name: string]: any };
  uninit?: string[];
}
export interface RtError {
  kind: string;
  fatal: boolean;
  step: number;
  line: number | null;
  col: number | null;
  inUser?: boolean;
  file?: string | null;
  values: { [k: string]: any };
  message: string;
  libcxxMessage?: string;
}
export interface RtRun {
  errors: RtError[];
  exit: any;
  steps: RtStep[];
  source: string;
  functions?: { [fn: string]: { line: number; closeLine: number; params: string[]; vars?: string[] } };
  decls?: { [fn: string]: { [name: string]: any } };
  classes?: { [cls: string]: { fields: { name: string; qualType: string }[] } };
}
export type RtWhich = number | "stack-overflow";
export type RtKind =
  | "div-by-zero"
  | "signed-overflow"
  | "array-bounds"
  | "container-index"
  | "empty-container"
  | "null-deref"
  | "missing-return"
  | "stack-overflow"
  | "other";
/** 「值從哪裡來」的一項。desc 裡用反引號包住的是原始碼。 */
export interface RtOrigin {
  name: string;
  label: string;
  desc: string;
  step: number;
  line: number;
  /** cin、decl、ctor、for-init、for-update、assign、incdec、mutate、change、param、here、call */
  how: string;
  red?: boolean;
  sameLine?: boolean;
}
export interface RtFixLine {
  text: string;
  add?: boolean;
}
export interface RtDiag {
  kind: RtKind;
  family: string;
  fatal: boolean;
  title: string;
  en: string;
  /** 編輯器要標紅的行（1 起算） */
  line: number;
  /** 那一行的原始碼 */
  code: string;
  /** code 裡要畫底線的範圍 [start, end)，字元位置 */
  bad: [number, number] | null;
  /** 錯誤發生在軌跡的哪一步 */
  step: number;
  /** 每種錯誤自己的圖要的值 */
  pic: any;
  /** 「發生了什麼」的文字（反引號包住的是原始碼） */
  what: string[];
  origins: RtOrigin[];
  /** 「值從哪裡來」的補充說明（例如索引是常數，沒有變數可以追） */
  originNote: string | null;
  fix: { text: string; code: RtFixLine[] } | null;
  native: string;
  raw: string;
  rawWhere: string;
  rawNote: string | null;
}

// ── 原始碼工具 ──────────────────────────────────────────────

function srcLines(src: string): string[] {
  return (src || "").split(/\r?\n/);
}

/** 錯誤紀錄的欄位（UTF-8 位元組，1 起算）換成 text 裡的字元位置（0 起算）；超過行尾回傳行長。 */
export function byteColToIndex(text: string, byteCol: number): number {
  if (!(byteCol >= 1)) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteCol - 1) return i;
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return text.length;
}

/** 一行的程式部分：註解、字串與字元常值換成空白（長度不變，位置照用）。 */
function codeOnly(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      out += " ".repeat(line.length - i);
      break;
    }
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end < 0 ? line.length : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < line.length && line[i] !== c) {
        if (line[i] === "\\" && i + 1 < line.length) {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
      }
      if (i < line.length) {
        out += c;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 去掉行尾的註解（給「怎麼改」與說明用，原本的 // BUG 註解不留下）。 */
export function stripComment(line: string): string {
  return line.slice(0, codeOnly(line).replace(/\s+$/, "").length);
}

const NAME_RE = /^[A-Za-z_]\w*$/;
const OPERAND = "[A-Za-z_]\\w*(?:\\s*(?:\\.|->)\\s*[A-Za-z_]\\w*|\\s*\\[[^\\[\\]]*\\])*|\\d+(?:\\.\\d+)?|\\([^()]*\\)";
const OPERAND_BEFORE = new RegExp("(" + OPERAND + ")\\s*$");
const OPERAND_AFTER = new RegExp("^\\s*(" + OPERAND + ")");

interface Span {
  text: string;
  start: number;
  end: number;
}

/** index end 之前的運算元（名稱、成員鏈、下標、數字或一層括號），沒有就 null。 */
function operandBefore(code: string, end: number): Span | null {
  const left = code.slice(0, end);
  const m = OPERAND_BEFORE.exec(left);
  if (!m) return null;
  const start = left.length - m[0].length;
  return { text: m[1], start, end: start + m[1].length };
}

/** index start 之後的運算元，沒有就 null。 */
function operandAfter(code: string, start: number): Span | null {
  const m = OPERAND_AFTER.exec(code.slice(start));
  if (!m) return null;
  const s = start + m[0].length - m[1].length;
  return { text: m[1], start: s, end: s + m[1].length };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 括號配對：從 open（指向 "("、"[" 或 "{"）找到對應的右括號的位置，找不到回傳 -1。 */
function matchClose(code: string, open: number): number {
  const o = code[open];
  const c = o === "(" ? ")" : o === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** for (init; cond; update) 的三段（文字取自原始碼）；不是三段式的 for 回傳 null。 */
function forParts(text: string): { init: string; cond: string; update: string } | null {
  const code = codeOnly(text);
  const m = /\bfor\s*\(/.exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchClose(code, open);
  if (close < 0) return null;
  const cuts: number[] = [];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) cuts.push(i);
  }
  if (cuts.length !== 2) return null;
  return { init: text.slice(open + 1, cuts[0]).trim(), cond: text.slice(cuts[0] + 1, cuts[1]).trim(), update: text.slice(cuts[1] + 1, close).trim() };
}

/** 這一行裡呼叫 fn 的那一段原始碼（例如 sign(0)），沒有回傳 ""。 */
function callText(text: string, fn: string): string {
  const short = fn.split("::").pop() || fn;
  const code = codeOnly(text);
  const m = new RegExp("\\b" + escapeRe(short) + "\\s*\\(").exec(code);
  if (!m) return "";
  const close = matchClose(code, m.index + m[0].length - 1);
  return close > 0 ? text.slice(m.index, close + 1) : "";
}

/** cin >> a >> b 裡，name 是讀進的第幾個（只有一個時回傳 0）。 */
function cinPosition(text: string, name: string): number {
  const code = codeOnly(text);
  const at = code.search(/\bcin\b/);
  if (at < 0) return 0;
  const parts = code
    .slice(at)
    .split(">>")
    .slice(1)
    .map((p) => p.replace(/[;)].*$/, "").trim());
  const i = parts.indexOf(name);
  return parts.length > 1 && i >= 0 ? i + 1 : 0;
}

// ── 這一行有沒有寫入某個變數 ────────────────────────────────

const KEYWORDS = /^(return|else|do|case|goto|throw|delete|new|sizeof|typedef|using|co_return|co_yield|co_await)$/;
const MUTATORS = "push|push_back|push_front|pop|pop_back|pop_front|insert|erase|clear|emplace|emplace_back|emplace_front|assign|resize|swap";
interface Pats {
  cin: RegExp;
  read: RegExp[];
  assign: RegExp;
  incdec: RegExp[];
  mutate: RegExp;
  ctor: RegExp;
}
const PATS: { [name: string]: Pats } = {};

/** 每個變數名稱的樣式只編一次（軌跡很長時，往回找要對很多步比對）。 */
function pats(name: string): Pats {
  if (PATS[name]) return PATS[name];
  const n = escapeRe(name);
  const p: Pats = {
    cin: new RegExp(">>\\s*" + n + "\\b"),
    read: [new RegExp("getline\\s*\\([^,]*,\\s*" + n + "\\b"), new RegExp("\\bscanf\\s*\\(.*&\\s*" + n + "\\b")],
    assign: new RegExp("(^|[^\\w.>])" + n + "\\s*(?:\\[[^\\]]*\\]\\s*)*(?:[-+*/%&|^]|<<|>>)?=(?!=)"),
    incdec: [new RegExp("(?:\\+\\+|--)\\s*" + n + "\\b"), new RegExp("(^|[^\\w.>])" + n + "\\s*(?:\\+\\+|--)")],
    mutate: new RegExp("(^|[^\\w.>])" + n + "\\s*\\.\\s*(" + MUTATORS + ")\\s*\\("),
    ctor: new RegExp("(\\w+|[>\\]*&])\\s+" + n + "\\s*[({]", "g"),
  };
  PATS[name] = p;
  return p;
}

/** 這一行（已去掉註解與字串）有沒有寫入變數 name；有的話回傳方式，沒有回傳 null。 */
function writesVar(code: string, name: string): string | null {
  const p = pats(name);
  if ((/\bcin\b/.test(code) && p.cin.test(code)) || p.read[0].test(code) || p.read[1].test(code)) return "cin";
  if (p.assign.test(code)) return "assign";
  if (p.incdec[0].test(code) || p.incdec[1].test(code)) return "incdec";
  if (p.mutate.test(code)) return "mutate";
  p.ctor.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = p.ctor.exec(code))) if (!KEYWORDS.test(m[1])) return "ctor"; // Node b{20, nullptr}、vector<int> v(5)
  return null;
}

// ── 值的工具 ────────────────────────────────────────────────

const own = (o: any, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const isScalar = (v: any) => v === null || typeof v !== "object";

/** 給學生看的值：數字照印，字串加引號，指標用中文。 */
function fmt(v: any): string {
  if (v === undefined) return "？";
  if (typeof v === "string") return v === "<ptr>" ? "不是 nullptr" : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function declType(run: RtRun, fn: string, name: string): string {
  const d = run.decls && run.decls[fn] ? run.decls[fn][name] : undefined;
  if (Array.isArray(d)) return String(d[0] || "");
  return typeof d === "string" ? d : "";
}

const isPtrType = (t: string) => /\*\s*$/.test(t.trim());

/** 依宣告型別印值：指標只說是不是 nullptr。 */
function fmtVar(run: RtRun, fn: string, name: string, v: any): string {
  if (isPtrType(declType(run, fn, name))) return v === 0 || v === null ? "nullptr" : "不是 nullptr";
  return fmt(v);
}

/** 下標裡的運算式（數字或變數名稱）在這一步的值；算不出來回傳 undefined。 */
function evalIndex(expr: string, vars: any): number | undefined {
  const t = expr.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  if (NAME_RE.test(t) && own(vars, t) && typeof vars[t] === "number") return vars[t];
  return undefined;
}

/** 存取路徑（a、a.b、a[2]、a.b[i][0]）在這一步的值；跟不到（指標、算不出的下標）回傳 undefined。 */
function readPath(vars: any, path: string): any {
  const m = /^\s*([A-Za-z_]\w*)/.exec(path);
  if (!m || !own(vars, m[1])) return undefined;
  let v = vars[m[1]];
  let rest = path.slice(m[0].length);
  while (rest.length) {
    let mm: RegExpExecArray | null;
    if ((mm = /^\s*\.\s*([A-Za-z_]\w*)/.exec(rest))) {
      if (!own(v, mm[1])) return undefined;
      v = v[mm[1]];
    } else if ((mm = /^\s*\[([^\[\]]*)\]/.exec(rest))) {
      const i = evalIndex(mm[1], vars);
      if (i === undefined || !Array.isArray(v) || i < 0 || i >= v.length) return undefined;
      v = v[i];
    } else return undefined;
    rest = rest.slice(mm[0].length);
  }
  return v;
}

/** 路徑裡的下標換成數字（g[r] → g[1]），算不出來的保留原文。 */
function resolvePath(path: string, vars: any): string {
  return path
    .replace(/\[([^\[\]]*)\]/g, (all: string, e: string) => {
      const i = evalIndex(e, vars);
      return i === undefined ? all : "[" + i + "]";
    })
    .replace(/\s+/g, "");
}

/** 一個值攤成葉子：{"b.data[0]": 0, "b.guard": 42}。 */
function leaves(prefix: string, v: any, out: { [p: string]: any }) {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(prefix + "[" + i + "]", x, out));
  else if (v && typeof v === "object") Object.keys(v).forEach((k) => leaves(prefix + "." + k, v[k], out));
  else out[prefix] = v;
}

const ZH_NUM = ["零", "一", "兩", "三", "四", "五", "六", "七", "八", "九", "十"];
const zhCount = (n: number) => (n >= 0 && n <= 10 ? ZH_NUM[n] : String(n));

// ── 值從哪裡來 ──────────────────────────────────────────────

/** diagnose 這一次用的原始碼（每一行與去掉註解字串的版本只算一次）。 */
interface Ctx {
  run: RtRun;
  lines: string[];
  codes: string[];
}

interface Found {
  step: number;
  line: number;
  how: string;
  sameLine: boolean;
  before?: any;
  after?: any;
  part?: string;
  cond?: string;
  call?: string;
}

/** 這一步之前，最後一次寫入 name 的那一步（同一個函式呼叫裡）；參數則是呼叫它的那一步。 */
function findWrite(C: Ctx, errStep: number, name: string): Found | null {
  const steps = C.run.steps;
  const S = steps[errStep];
  if (!S) return null;
  if (!own(S.vars, name)) {
    // 這一步看不到它（例如宣告在同一行的 for），寫入它的就是這一行
    const how = writesVar(C.codes[S.line - 1] || "", name);
    return how ? { step: errStep, line: S.line, how: "here", sameLine: true } : null;
  }
  let next = errStep;
  let caller = -1;
  for (let k = errStep - 1; k >= 0; k--) {
    const s = steps[k];
    if (!s) break; // 測試用的軌跡只留頭尾
    if (s.depth < S.depth) {
      caller = k;
      break;
    }
    if (s.frame !== S.frame) continue;
    const nv = steps[next].vars;
    const had = own(s.vars, name);
    const before = had ? s.vars[name] : undefined;
    const after = nv[name];
    const base = { step: k, line: s.line, sameLine: s.line === S.line, before, after };
    const fp = forParts(C.lines[s.line - 1] || "");
    if (fp) {
      if (!had && own(nv, name) && writesVar(codeOnly(fp.init), name)) return { ...base, how: "for-init", part: fp.init };
      if (had && !same(before, after) && writesVar(codeOnly(fp.update), name))
        return { ...base, how: "for-update", part: fp.update, cond: S.line !== s.line ? fp.cond : undefined };
    }
    const how = writesVar(C.codes[s.line - 1] || "", name);
    if (how === "cin") return { ...base, how };
    if (!had && own(nv, name)) return { ...base, how: "decl" };
    if (how) return { ...base, how };
    if (had && !same(before, after)) return { ...base, how: "change" };
    next = k;
  }
  const f = C.run.functions && C.run.functions[S.fn];
  if (caller >= 0 && f && f.params && f.params.indexOf(name) >= 0) {
    const cl = steps[caller].line;
    return { step: caller, line: cl, how: "param", sameLine: false, call: callText(C.lines[cl - 1] || "", S.fn) };
  }
  return null;
}

function describe(C: Ctx, f: Found, name: string, fn: string, ctx: string): string {
  const code = "`" + stripComment(C.lines[f.line - 1] || "").trim() + "`";
  const changed =
    f.before !== undefined && f.after !== undefined && isScalar(f.before) && isScalar(f.after) && !same(f.before, f.after)
      ? `把 ${name} 從 ${fmtVar(C.run, fn, name, f.before)} 變成 ${fmtVar(C.run, fn, name, f.after)}`
      : "";
  switch (f.how) {
    case "here":
      return "就在這一行：" + code;
    case "cin": {
      const nth = cinPosition(C.lines[f.line - 1] || "", name);
      return `第 ${f.line} 行 ${code} 讀進的${nth ? `第 ${nth} 個數` : "值"}`;
    }
    case "for-init":
      return `第 ${f.line} 行 for 的 \`${f.part}\` 宣告的`;
    case "for-update":
      return `第 ${f.line} 行 for 的 \`${f.part}\` ${changed || "寫入的"}` + (f.cond ? `；條件 \`${f.cond}\` 還成立，所以又進了迴圈` : "");
    case "decl":
    case "ctor":
      return `第 ${f.line} 行 ${code} 宣告的`;
    case "param":
      return `第 ${f.line} 行呼叫 ${f.call ? "`" + f.call + "`" : fn + "(…)"} 時傳進來的`;
    default:
      if (f.sameLine) return `上一次執行第 ${f.line} 行時算出來的${ctx ? `（那時 ${ctx}）` : ""}`;
      return `第 ${f.line} 行 ${code} ${changed || "寫入的"}`;
  }
}

/** 變數 name 的值從哪裡來；ctxNames 是說明「那時」要一起列出的其他變數。 */
function makeOrigin(C: Ctx, errStep: number, name: string, label: string, red = false, ctxNames: string[] = []): RtOrigin | null {
  const f = findWrite(C, errStep, name);
  if (!f) return null;
  const S = C.run.steps[errStep];
  const fn = S ? S.fn : "";
  const at = C.run.steps[f.step] ? C.run.steps[f.step].vars : {};
  const ctx = ctxNames
    .filter((n) => n !== name && own(at, n))
    .map((n) => `${n} = ${fmtVar(C.run, fn, n, at[n])}`)
    .join("、");
  return { name, label, desc: describe(C, f, name, fn, ctx), step: f.step, line: f.line, how: f.how, red, sameLine: f.sameLine };
}

/** 容器（vector、string、stack…）的大小從哪裡來：宣告的那一步，或大小最後一次改變的那一步。 */
function sizeOrigin(C: Ctx, errStep: number, name: string, label: string, red = false): RtOrigin | null {
  const steps = C.run.steps;
  const S = steps[errStep];
  if (!S || !own(S.vars, name)) return null;
  const len = (v: any) => (Array.isArray(v) || typeof v === "string" ? v.length : -1);
  let next = errStep;
  let caller = -1;
  for (let k = errStep - 1; k >= 0; k--) {
    const s = steps[k];
    if (!s) break;
    if (s.depth < S.depth) {
      caller = k;
      break;
    }
    if (s.frame !== S.frame) continue;
    const nv = steps[next].vars;
    const text = "`" + stripComment(C.lines[s.line - 1] || "").trim() + "`";
    if (!own(s.vars, name) && own(nv, name)) return { name, label, desc: `第 ${s.line} 行 ${text} 宣告的`, step: k, line: s.line, how: "decl", red };
    if (own(s.vars, name) && len(s.vars[name]) !== len(nv[name])) {
      const before = s.vars[name];
      const n = len(nv[name]);
      const m = pats(name).mutate.exec(C.codes[s.line - 1] || "");
      let what = `之後變成 ${n} 個元素`;
      if (n === 0 && m && /^pop/.test(m[2]) && Array.isArray(before) && before.length === 1) what = `拿走了最後一個元素（${fmt(before[0])}）`;
      else if (n === 0 && m && m[2] === "clear") what = "清空了";
      else if (n === 0) what = "之後變成空的";
      return { name, label, desc: `第 ${s.line} 行 ${text} ${what}`, step: k, line: s.line, how: "mutate", red };
    }
    next = k;
  }
  const f = C.run.functions && C.run.functions[S.fn];
  if (caller >= 0 && f && f.params && f.params.indexOf(name) >= 0) {
    const cl = steps[caller].line;
    const call = callText(C.lines[cl - 1] || "", S.fn);
    return { name, label, desc: `第 ${cl} 行呼叫 ${call ? "`" + call + "`" : S.fn + "(…)"} 時傳進來的`, step: caller, line: cl, how: "param", red };
  }
  return null;
}

// ── 共同的部分 ──────────────────────────────────────────────

const FAMILY: { [k: string]: string } = {
  "div-by-zero": "家族 1・數值",
  "signed-overflow": "家族 1・數值",
  "array-bounds": "家族 2・陣列與容器",
  "container-index": "家族 2・陣列與容器",
  "empty-container": "家族 2・陣列與容器",
  "null-deref": "家族 3・指標與記憶體",
  "missing-return": "家族 4・函式與流程",
  "stack-overflow": "家族 4・函式與流程",
  other: "其他",
};

/** 這次執行有哪些錯誤畫面：每一筆錯誤紀錄一個，堆疊用完（沒有錯誤紀錄）另一個。 */
export function listRuntimeErrors(run: RtRun): RtWhich[] {
  const out: RtWhich[] = (run.errors || []).map((_, i) => i);
  if (run.exit && run.exit.reason === "stack-overflow") out.push("stack-overflow");
  return out;
}

function classify(e: RtError): RtKind {
  switch (e.kind) {
    case "div-by-zero":
    case "signed-overflow":
    case "array-bounds":
    case "null-deref":
    case "missing-return":
      return e.kind;
    case "libcxx":
      if (/index out of bounds/.test(e.message)) return "container-index";
      if (/empty/.test(e.message)) return "empty-container";
      return "other";
    default:
      return "other";
  }
}

function usesStd(source: string): boolean {
  return /using\s+namespace\s+std\s*;/.test(source);
}

/** 原始碼行包進 if：if (cond) { line } */
function guardFix(cond: string, line: string): RtFixLine[] {
  return [{ text: `if (${cond}) {`, add: true }, { text: "    " + stripComment(line).trim() }, { text: "}", add: true }];
}

/** 下標來自 for 迴圈且條件寫成 i <= N（N 等於大小）：改成 i < N。 */
function forBoundFix(C: Ctx, line: number, name: string, size: number, vars: any): RtFixLine[] | null {
  const text = stripComment(C.lines[line - 1] || "");
  if (!forParts(text)) return null;
  const m = new RegExp("\\b" + escapeRe(name) + "\\s*<=\\s*(\\d+|[A-Za-z_]\\w*)\\b").exec(text);
  if (!m) return null;
  const bound = /^\d+$/.test(m[1]) ? Number(m[1]) : own(vars, m[1]) ? vars[m[1]] : undefined;
  if (bound !== size) return null;
  const fixed = text.slice(0, m.index) + `${name} < ${m[1]}` + text.slice(m.index + m[0].length);
  return [{ text: fixed.trim(), add: true }];
}

function base(kind: RtKind): RtDiag {
  return {
    kind,
    family: FAMILY[kind],
    fatal: true,
    title: "執行錯誤",
    en: "",
    line: 1,
    code: "",
    bad: null,
    step: 0,
    pic: {},
    what: [],
    origins: [],
    originNote: null,
    fix: null,
    native: "",
    raw: "",
    rawWhere: "",
    rawNote: null,
  };
}

// ── 每一種錯誤 ──────────────────────────────────────────────

export function diagnose(run: RtRun, which: RtWhich): RtDiag {
  const lines = srcLines(run.source);
  const C: Ctx = { run, lines, codes: lines.map(codeOnly) };
  if (which === "stack-overflow") return stackOverflow(C);
  const e = run.errors[which];
  const kind = classify(e);
  const d = base(kind);
  const S = run.steps[e.step];
  d.fatal = !!e.fatal;
  d.step = e.step;
  d.line = (kind === "missing-return" && S ? S.line : e.line) || (S ? S.line : 1);
  d.code = lines[d.line - 1] || "";
  d.raw = e.message;
  const idx = e.col && kind !== "missing-return" ? byteColToIndex(d.code, e.col) : -1;
  d.rawWhere = idx >= 0 ? `第 ${d.line} 行第 ${idx + 1} 個字` : `第 ${d.line} 行`;
  const vars = S ? S.vars : {};
  switch (kind) {
    case "div-by-zero":
      return divByZero(C, d, e, idx, vars);
    case "signed-overflow":
      return overflow(C, d, e, idx, vars);
    case "array-bounds":
      return arrayBounds(C, d, e, idx, vars);
    case "container-index":
      return containerIndex(C, d, e, vars);
    case "empty-container":
      return emptyContainer(C, d, e, vars);
    case "null-deref":
      return nullDeref(C, d, e, idx, vars);
    case "missing-return":
      return missingReturn(C, d, e);
    default:
      d.en = e.kind;
      if (idx >= 0 && idx < d.code.length) d.bad = [idx, idx + 1];
      d.what = ["這種錯誤還沒有專屬的圖解，下方是原始訊息。"];
      return d;
  }
}

function divByZero(C: Ctx, d: RtDiag, e: RtError, idx: number, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const op = code[idx] === "%" ? "%" : "/";
  const L = operandBefore(code, idx);
  const R = operandAfter(code, idx + 1);
  const lhsText = L ? d.code.slice(L.start, L.end) : null;
  const rhsText = R ? d.code.slice(R.start, R.end) : null;
  const lhsName = lhsText && NAME_RE.test(lhsText) ? lhsText : null;
  const rhsName = rhsText && NAME_RE.test(rhsText) ? rhsText : null;
  d.title = op === "%" ? "取餘數（%）時除以零" : "整數除以零";
  d.en = "division by zero";
  d.bad = [idx, idx + 1];
  d.pic = { op, lhs: e.values.lhs, rhs: e.values.rhs, type: e.values.type, lhsText, rhsText, lhsName, rhsName };
  const what = op === "%" ? "取餘數" : "除法";
  d.what = [
    e.values.lhs !== 0
      ? `除數 \`${rhsText || "?"}\` 是 0。沒有任何整數乘以 0 會等於 ${e.values.lhs}，所以這個${what}沒有答案，程式只能在這一行結束。`
      : `除數 \`${rhsText || "?"}\` 是 0。除以 0 沒有答案，程式只能在這一行結束。`,
  ];
  const os: RtOrigin[] = [];
  if (lhsName) {
    const o = makeOrigin(C, d.step, lhsName, `${lhsName} = ${fmt(vars[lhsName])}`);
    if (o) os.push(o);
  }
  if (rhsName) {
    const o = makeOrigin(C, d.step, rhsName, `${rhsName} = ${fmt(vars[rhsName])}`, true);
    if (o) os.push(o);
  }
  d.origins = os;
  if (!rhsName) d.originNote = "除數是程式裡直接寫的算式，沒有變數可以往回追。";
  const guard = rhsName || (rhsText && rhsText[0] === "(" ? rhsText : `(${rhsText})`);
  const S = C.run.steps[d.step];
  const std = usesStd(C.run.source) ? "" : "std::";
  const body: RtFixLine[] =
    S && S.fn === "main"
      ? [
          { text: `    ${std}cout << "除數不能是 0" << ${std}endl;`, add: true },
          { text: "    return 0;", add: true },
        ]
      : [{ text: "    // 除數是 0：在這裡處理，不要往下除", add: true }];
  const head: RtFixLine[] = [{ text: `if (${guard} == 0) {`, add: true }];
  d.fix = { text: "除之前先確認除數不是 0。", code: head.concat(body, [{ text: "}", add: true }, { text: stripComment(d.code).trim() }]) };
  d.native = "g++ 編譯的程式也會在這一行結束，終端機顯示 Floating point exception。";
  return d;
}

function overflow(C: Ctx, d: RtDiag, e: RtError, idx: number, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const v = e.values;
  const op: string = v.op;
  const type = String(v.type || "int");
  const width = /long\s+long|int64/.test(type) ? 64 : 32;
  d.title = "有號整數溢位";
  d.en = "signed integer overflow";
  // 底線：整個運算式（lhs op rhs，或 -x）
  let L: Span | null = null;
  let R: Span | null = null;
  let assignTo: string | null = null;
  if (op === "neg") {
    R = operandAfter(code, idx + 1);
    d.bad = [idx, R ? R.end : idx + 1];
  } else {
    L = operandBefore(code, idx);
    const doubled = code[idx + 1] === code[idx]; // x++、x--
    const compound = code[idx + 1] === "=";
    const after = compound || doubled ? idx + 2 : idx + 1;
    R = doubled ? null : operandAfter(code, after);
    d.bad = [L ? L.start : idx, R ? R.end : after];
    if ((compound || doubled) && L && NAME_RE.test(L.text)) assignTo = L.text;
  }
  if (!assignTo && d.bad) {
    const m = /([A-Za-z_]\w*)\s*=\s*$/.exec(code.slice(0, d.bad[0]));
    if (m) assignTo = m[1];
  }
  let exact: string;
  let stored: string;
  let wraps = 0;
  let modulus = width === 64 ? "18446744073709551616" : "4294967296";
  let wrapAmount = "";
  let exactBits: string | null = null;
  let storedBits: string | null = null;
  if (typeof BigInt === "function") {
    const a = BigInt(v.lhs);
    const b = BigInt(op === "neg" ? 0 : v.rhs);
    const x = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : -a;
    const m = BigInt(1) << BigInt(width);
    const low = ((x % m) + m) % m;
    const s = low >= m / BigInt(2) ? low - m : low;
    exact = x.toString();
    stored = s.toString();
    modulus = m.toString();
    wrapAmount = (x - s).toString();
    wraps = Number((x - s) / m);
    const bits = x > BigInt(0) ? x.toString(2) : null;
    if (bits && bits.length <= width + 8) {
      exactBits = bits;
      const lb = low.toString(2);
      storedBits = "0".repeat(width - lb.length) + lb;
    }
  } else {
    const x = op === "+" ? v.lhs + v.rhs : op === "-" ? v.lhs - v.rhs : op === "*" ? v.lhs * v.rhs : -v.lhs;
    exact = String(x);
    stored = "?";
  }
  const max = width === 64 ? "9223372036854775807" : "2147483647";
  const min = width === 64 ? "-9223372036854775808" : "-2147483648";
  const positive = exact[0] !== "-";
  d.pic = { op, lhs: v.lhs, rhs: v.rhs, type, width, exact, stored, wraps, modulus, wrapAmount, max, min, exactBits, storedBits, assignTo };
  const sym = op === "*" ? "×" : op;
  const expr = op === "neg" ? `-(${v.lhs})` : `${v.lhs} ${sym} ${v.rhs}`;
  d.what = [`\`${expr}\` 的正確答案是 ${exact}，${positive ? `比 ${type} 的上限 ${max} 還大` : `比 ${type} 的下限 ${min} 還小`}。`];
  const names: string[] = [];
  [L, R].forEach((sp) => {
    const t = sp ? d.code.slice(sp.start, sp.end) : "";
    if (sp && NAME_RE.test(t) && names.indexOf(t) < 0) names.push(t);
  });
  const os: RtOrigin[] = [];
  names.forEach((t) => {
    const o = makeOrigin(C, d.step, t, `${t} = ${fmt(vars[t])}`, false, names);
    if (o) os.push(o);
  });
  d.origins = os;
  if (!os.length) d.originNote = "運算的兩邊都不是變數，沒有值可以往回追。";
  d.fix = overflowFix(C, d, names[0] || null, width);
  d.native = "g++ 編譯的程式不會報錯，存進去的一樣是繞回之後的值，程式照樣往下跑。";
  return d;
}

/** 有號溢位的修正：int 改成 long long（變數的宣告；結果要 return 時，函式的回傳型別也要改）。 */
function overflowFix(C: Ctx, d: RtDiag, target: string | null, width: number): { text: string; code: RtFixLine[] } {
  const fp = forParts(d.code);
  if (target && fp && new RegExp("\\b" + escapeRe(target) + "\\b").test(fp.update) && new RegExp("\\b" + escapeRe(target) + "\\s*(?:>|>=|!=)\\s*0\\b").test(fp.cond))
    return {
      text: `迴圈要等 ${target} 溢位、變成負數，條件 ${fp.cond} 才會不成立。溢位之後的值不可靠，不能拿來當停止條件；要改成在溢位之前就會不成立的條件。`,
      code: [],
    };
  if (width !== 32) return { text: "已經是 long long 了還是放不下：要換個算法（例如邊算邊取餘數），或改用大數。", code: [] };
  const S = C.run.steps[d.step];
  const info = S && C.run.functions ? C.run.functions[S.fn] : undefined;
  const edits: { [line: number]: string } = {};
  if (info) {
    const from = info.line;
    const to = info.closeLine || d.line;
    const sig = stripComment(C.lines[from - 1] || "").trim();
    const returnsIt =
      /\breturn\b/.test(C.codes[d.line - 1] || "") ||
      (!!target && C.codes.slice(from - 1, to).some((l) => new RegExp("\\breturn\\s+" + escapeRe(target) + "\\s*;").test(l)));
    if (returnsIt && S.fn !== "main" && /^int\s/.test(sig)) edits[from] = sig.replace(/^int\b/, "long long");
    if (target) {
      const declRe = new RegExp("\\bint(\\s+" + escapeRe(target) + "\\b)");
      for (let l = from; l <= to; l++) {
        const t = edits[l] !== undefined ? edits[l] : stripComment(C.lines[l - 1] || "").trim();
        if (declRe.test(codeOnly(t))) {
          edits[l] = t.replace(declRe, "long long$1");
          break;
        }
      }
    }
  }
  // 每一行保留相對於函式開頭那一行的縮排（函式內的宣告要比函式開頭多縮一層）
  const indentOf = (s: string) => (/^[ \t]*/.exec(s) || [""])[0];
  const base = info ? indentOf(C.lines[info.line - 1] || "") : "";
  const code = Object.keys(edits)
    .map(Number)
    .sort((a, b) => a - b)
    .map((l) => {
      const ind = indentOf(C.lines[l - 1] || "");
      return { text: (ind.startsWith(base) ? ind.slice(base.length) : "") + edits[l], add: true };
    });
  return { text: "改用範圍更大的 long long（上限約 9.2 × 10¹⁸），就放得下。", code };
}

/** idx 開始的陣列運算式：基底（名稱與成員鏈）加上一串下標。 */
function subscriptChain(code: string, idx: number): { base: Span; subs: Span[]; end: number } | null {
  const m = /^[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*/.exec(code.slice(idx));
  if (!m) return null;
  const baseSpan = { text: m[0], start: idx, end: idx + m[0].length };
  const subs: Span[] = [];
  let p = baseSpan.end;
  for (;;) {
    let q = p;
    while (code[q] === " ") q++;
    if (code[q] !== "[") break;
    const close = matchClose(code, q);
    if (close < 0) break;
    subs.push({ text: code.slice(q + 1, close).trim(), start: q, end: close + 1 });
    p = close + 1;
  }
  return subs.length ? { base: baseSpan, subs, end: p } : null;
}

/** 錯誤之後同一個函式呼叫的下一步（寫入已經發生）；沒有回傳 -1。 */
function nextInFrame(run: RtRun, step: number): number {
  const S = run.steps[step];
  if (!S) return -1;
  for (let k = step + 1; k < run.steps.length; k++) {
    const s = run.steps[k];
    if (!s || s.depth < S.depth) return -1;
    if (s.frame === S.frame) return k;
  }
  return -1;
}

function arrayBounds(C: Ctx, d: RtDiag, e: RtError, idx: number, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const index: number = e.values.index;
  const typeText = String(e.values.array || "");
  const sizeM = /\[(\d+)\]\s*$/.exec(typeText);
  const size = sizeM ? Number(sizeM[1]) : NaN;
  d.title = "陣列索引超出範圍";
  d.en = "array index out of bounds";
  const ch = subscriptChain(code, idx);
  let arrayText = "?";
  let indexText = String(index);
  let cells: any[] | null = null;
  let end = idx + 1;
  if (ch) {
    // 越界的是哪一個下標：值等於錯誤紀錄的索引的那個（找不到就用最後一個）
    let chosen = -1;
    for (let i = ch.subs.length - 1; i >= 0; i--)
      if (evalIndex(ch.subs[i].text, vars) === index) {
        chosen = i;
        break;
      }
    if (chosen < 0) chosen = ch.subs.length - 1;
    arrayText = d.code.slice(ch.base.start, chosen > 0 ? ch.subs[chosen - 1].end : ch.base.end).replace(/\s+/g, "");
    indexText = ch.subs[chosen].text;
    end = ch.end;
    const val = readPath(vars, arrayText);
    cells = Array.isArray(val) ? val : null;
  }
  d.bad = [idx, end];
  const write = /^\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)/.test(code.slice(end));
  const resolved = resolvePath(arrayText, vars);
  let after: any = null;
  if (write && !d.fatal) {
    const nx = nextInFrame(C.run, d.step);
    if (nx >= 0) {
      const baseVar = (/^[A-Za-z_]\w*/.exec(resolved) || [""])[0];
      const flat = (vs: any) => {
        const out: { [p: string]: any } = {};
        Object.keys(vs).forEach((k) => {
          if (k !== baseVar && writesVar(code, k)) return; // 這一行本來就會寫的變數（一行的 for 的 i）
          leaves(k, vs[k], out);
        });
        return out;
      };
      const a = flat(vars);
      const b = flat(C.run.steps[nx].vars);
      const parent = resolved.indexOf(".") > 0 ? resolved.slice(0, resolved.lastIndexOf(".")) : null;
      const overwritten = Object.keys(b)
        .filter((p) => own(a, p) && !same(a[p], b[p]) && p.indexOf(resolved + "[") !== 0)
        .map((p) => ({ path: p, from: a[p], to: b[p], sibling: !!parent && p.indexOf(parent + ".") === 0, sameArray: p.indexOf(baseVar + "[") === 0 }));
      after = { step: nx, overwritten, target: `${resolved}[${index}]`, parent };
    }
  }
  d.pic = { arrayText, typeText, size, index, indexText, cells, write, after };
  const where = index >= size ? "已經超出最後一格" : "是負數，在第一格前面";
  d.what = [`\`${arrayText}\` 只有 ${size} 格，索引是 0～${size - 1}。現在 \`${indexText}\` = ${index}，${where}。`];
  if (!write) d.what.push("讀出來的值來自陣列外面的記憶體，沒有意義。");
  const os: RtOrigin[] = [];
  if (NAME_RE.test(indexText)) {
    const o = makeOrigin(C, d.step, indexText, `${indexText} = ${index}`, true);
    if (o) os.push(o);
  } else d.originNote = `索引 ${indexText} 是程式裡直接寫的，沒有變數可以往回追。`;
  d.origins = os;
  const fl = os.length ? forBoundFix(C, os[0].line, indexText, size, vars) : null;
  const shortName = arrayText.replace(/^.*[.>]/, "");
  d.fix = fl
    ? { text: `${shortName} 有 ${size} 格，條件要寫 ${indexText} < ${size}，${indexText} 就只會是 0～${size - 1}。`, code: fl }
    : { text: `${shortName} 有 ${size} 格，使用前先確認索引在 0～${size - 1} 之間。`, code: guardFix(`0 <= ${indexText} && ${indexText} < ${size}`, d.code) };
  d.native = "g++ 編譯的程式通常不會報錯。越界的讀寫碰到陣列旁邊的記憶體，結果不可靠：同一個程式改用 -O2 編譯，結果就可能不同。";
  return d;
}

function containerType(run: RtRun, fn: string, name: string): string {
  const t = declType(run, fn, name);
  const m = /(priority_queue|stack|queue|deque|vector|list|array|string)\b/.exec(t);
  return m ? m[1] : "";
}

function containerIndex(C: Ctx, d: RtDiag, e: RtError, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const S = C.run.steps[d.step];
  const fn = S ? S.fn : "";
  const re = /([A-Za-z_]\w*)\s*\[/g;
  let pick: { name: string; span: Span; idxText: string; index: number | undefined; val: any } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (!own(vars, name)) continue;
    const val = vars[name];
    if (!Array.isArray(val) && typeof val !== "string") continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    if (close < 0) continue;
    const idxText = d.code.slice(open + 1, close).trim();
    const index = evalIndex(idxText, vars);
    const cand = { name, span: { text: d.code.slice(m.index, close + 1), start: m.index, end: close + 1 }, idxText, index, val };
    if (!pick) pick = cand;
    if (index !== undefined && (index < 0 || index >= val.length)) {
      pick = cand;
      break;
    }
  }
  const isString = !!pick && typeof pick.val === "string";
  const tname = pick ? containerType(C.run, fn, pick.name) || (isString ? "string" : "vector") : /string/.test(e.message) ? "string" : "vector";
  d.title = `${tname} 索引超出範圍`;
  d.en = "out of range";
  if (!pick) {
    d.what = ["這一行有容器的索引超出範圍，下方是原始訊息。"];
    return d;
  }
  const cells: any[] = isString ? String(pick.val).split("") : pick.val;
  const capRaw = vars[pick.name + ".capacity()"];
  const capacity = typeof capRaw === "number" ? capRaw : null;
  const typeText = declType(C.run, fn, pick.name) || tname;
  d.bad = [pick.span.start, pick.span.end];
  d.pic = { name: pick.name, typeText, size: cells.length, capacity, index: pick.index, indexText: pick.idxText, cells, isString };
  const unit = isString ? "個字元" : "個元素";
  const idxShow = pick.index === undefined ? "" : NAME_RE.test(pick.idxText) ? `\`${pick.idxText}\` = ${pick.index}` : `索引 ${pick.index}`;
  d.what = [
    `\`${pick.name}\` 有 ${cells.length} ${unit}，索引是 0～${cells.length - 1}。${idxShow ? `現在 ${idxShow}，超出範圍。` : "這一行的索引超出範圍。"}`,
    `\`${pick.name}.at(i)\` 會先檢查索引，超出就報錯；\`${pick.name}[i]\` 不檢查。IRIS 替 \`${pick.name}[i]\` 加了檢查，所以停在這一行。`,
  ];
  const os: RtOrigin[] = [];
  if (NAME_RE.test(pick.idxText)) {
    const o = makeOrigin(C, d.step, pick.idxText, `${pick.idxText} = ${fmt(vars[pick.idxText])}`, true);
    if (o) os.push(o);
  } else d.originNote = `索引 ${pick.idxText} 是程式裡直接寫的，沒有變數可以往回追。`;
  const so = sizeOrigin(C, d.step, pick.name, `${pick.name} 有 ${cells.length} ${unit}`);
  if (so) os.push(so);
  d.origins = os;
  const fl = os.length && os[0].name === pick.idxText ? forBoundFix(C, os[0].line, pick.idxText, cells.length, vars) : null;
  d.fix = fl
    ? { text: `${pick.name} 有 ${cells.length} ${unit}，條件要寫 ${pick.idxText} < ${cells.length}（或 ${pick.idxText} < ${pick.name}.size()）。`, code: fl }
    : { text: `使用前先確認索引小於 ${pick.name}.size()。`, code: guardFix(`${pick.idxText} < ${pick.name}.size()`, d.code) };
  d.native = "g++ 編譯的程式通常不會報錯：[] 不檢查索引，越界的讀寫落在容器外面，程式可能照樣跑完。";
  return d;
}

const UNDERLYING: { [k: string]: string } = { stack: "deque", queue: "deque", priority_queue: "vector" };

/** s.top() 這類呼叫要做什麼（給「發生了什麼」用）。 */
function methodText(ckind: string, method: string): string {
  const top = ckind === "priority_queue" ? "最大的元素" : ckind === "queue" ? "最前面的元素" : "最上面的元素";
  switch (method) {
    case "top":
      return `要拿 ${ckind} ${top}`;
    case "front":
      return `要拿 ${ckind} 最前面的元素`;
    case "back":
      return `要拿 ${ckind} 最後面的元素`;
    case "pop":
      return `要拿走 ${ckind} ${top}`;
    case "pop_back":
      return `要拿走 ${ckind} 最後面的元素`;
    case "pop_front":
      return `要拿走 ${ckind} 最前面的元素`;
    default:
      return `要用 ${ckind} 的元素`;
  }
}

function emptyContainer(C: Ctx, d: RtDiag, e: RtError, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const S = C.run.steps[d.step];
  const re = /([A-Za-z_]\w*)\s*\.\s*(top|front|back|pop_back|pop_front|pop)\s*\(\s*\)/g;
  let pick: { name: string; method: string; span: Span } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const val = vars[m[1]];
    const cand = { name: m[1], method: m[2], span: { text: m[0], start: m.index, end: m.index + m[0].length } };
    if (!pick) pick = cand;
    if (Array.isArray(val) && val.length === 0) {
      pick = cand;
      break;
    }
  }
  d.en = "empty container";
  if (!pick) {
    d.title = "對空的容器取元素";
    d.what = ["這一行對空的容器取元素，下方是原始訊息。"];
    return d;
  }
  const ckind = containerType(C.run, S ? S.fn : "", pick.name) || "容器";
  const call = d.code.slice(pick.span.start, pick.span.end);
  d.title = `對空的 ${ckind} 呼叫 ${pick.method}()`;
  d.bad = [pick.span.start, pick.span.end];
  d.pic = { name: pick.name, method: pick.method, ckind, call };
  const takes = /^pop/.test(pick.method) ? "拿走" : "拿";
  d.what = [`\`${call}\` ${methodText(ckind, pick.method)}，可是 \`${pick.name}\` 裡一個元素都沒有，沒有東西可以${takes}。`];
  const o = sizeOrigin(C, d.step, pick.name, `${pick.name} 是空的`, true);
  if (o && o.how === "decl") o.desc = o.desc.replace(/宣告的$/, "宣告之後，一直是空的");
  d.origins = o ? [o] : [];
  if (!o) d.originNote = "這個容器從宣告起就是空的。";
  const under = UNDERLYING[ckind];
  if (under && e.message.indexOf(under) >= 0) d.rawNote = `${ckind} 是用 ${under} 存放元素，${pick.method}() 會去呼叫 ${under} 的函式，所以訊息寫的是 ${under}。`;
  d.fix = { text: `${takes}之前先確認 ${pick.name} 不是空的。`, code: guardFix(`!${pick.name}.empty()`, d.code) };
  d.native = "g++ 編譯的程式結果不一定：實測對空的 stack 呼叫 top() 會崩潰（Segmentation fault），對空的 queue 呼叫 front() 卻不會報錯，讀到沒有意義的值。";
  return d;
}

const NULL_TITLE: { [tck: number]: string } = { 0: "透過空指標讀取", 1: "透過空指標寫入", 3: "透過空指標存取成員", 4: "透過空指標呼叫成員函式" };

function nullDeref(C: Ctx, d: RtDiag, e: RtError, idx: number, vars: any): RtDiag {
  const code = C.codes[d.line - 1] || "";
  const tck = Number(e.values.tck);
  d.title = NULL_TITLE[tck] || "使用空指標";
  d.en = "null pointer";
  let baseText = "";
  let member: string | null = null;
  if (code[idx] === "*") {
    const b = operandAfter(code, idx + 1);
    if (b) {
      baseText = d.code.slice(b.start, b.end);
      d.bad = [idx, b.end];
    }
  } else {
    const left = code.slice(0, idx).replace(/\s+$/, "");
    const mm = /^[A-Za-z_]\w*/.exec(code.slice(idx));
    const arrow = left.slice(-2) === "->" ? 2 : left.slice(-1) === "." ? 1 : 0;
    if (mm && arrow) {
      member = mm[0];
      const b = operandBefore(code, left.length - arrow);
      if (b) {
        baseText = d.code.slice(b.start, b.end);
        d.bad = [b.start, idx + member.length];
      }
    }
  }
  const S = C.run.steps[d.step];
  const fn = S ? S.fn : "";
  // 物件圖（沒有箭頭）：這一步看得到的 struct 物件與指標
  const objects: any[] = [];
  const pointers: any[] = [];
  Object.keys(vars).forEach((name) => {
    const v = vars[name];
    const t = declType(C.run, fn, name).trim();
    if (isPtrType(t)) {
      pointers.push({ name, type: t, isNull: v === 0 || v === null });
      return;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const cls = C.run.classes ? C.run.classes[t] : undefined;
    const fieldDefs = cls ? cls.fields : Object.keys(v).map((k) => ({ name: k, qualType: "" }));
    objects.push({
      name,
      type: t,
      fields: fieldDefs.map((f) => {
        const ptr = isPtrType(f.qualType);
        const fv = v[f.name];
        const isNull = ptr && (fv === 0 || fv === null);
        return { name: f.name, value: ptr ? (isNull ? "nullptr" : "不是 nullptr") : fmt(fv), ptr, isNull };
      }),
    });
  });
  d.pic = { baseText, member, objects, pointers, tck };
  const doWhat = tck === 1 ? "寫" : "讀";
  const target = member ? `${baseText}->${member}` : `*${baseText}`;
  d.what = [`\`${baseText}\` 是 nullptr（沒有指向任何東西），所以 \`${target}\` 沒有東西可以${doWhat}。`];
  // cur->next 是 nullptr：看得到的物件裡，哪些的 next 是 nullptr
  const fieldM = /(?:->|\.)\s*([A-Za-z_]\w*)$/.exec(baseText);
  const os: RtOrigin[] = [];
  if (fieldM) {
    const holders = objects.filter((o) => o.fields.some((f: any) => f.name === fieldM[1] && f.isNull));
    if (holders.length) {
      const typeName = holders[0].type || "物件";
      d.what.push(`看得到的 ${typeName} 裡，${holders.length === 1 ? "只有 " : ""}${holders.map((o) => o.name).join("、")} 的 ${fieldM[1]} 是 nullptr。`);
      holders.forEach((o) => {
        const og = makeOrigin(C, d.step, o.name, `${o.name}.${fieldM[1]} = nullptr`);
        if (og) os.push({ ...og, name: `${o.name}.${fieldM[1]}` });
      });
    }
  }
  const baseVar = (/^[A-Za-z_]\w*/.exec(baseText) || [""])[0];
  if (baseVar && own(vars, baseVar)) {
    const isNull = vars[baseVar] === 0 || vars[baseVar] === null;
    const og = makeOrigin(C, d.step, baseVar, `${baseVar}${isNull ? " = nullptr" : " 不是 nullptr"}`, isNull);
    if (og) os.push(og);
  }
  d.origins = os;
  if (!os.length) d.originNote = "這個指標不是變數，沒有值可以往回追。";
  d.fix = { text: `${doWhat} ${target} 之前，先確認 ${baseText} 不是 nullptr。`, code: guardFix(`${baseText} != nullptr`, d.code) };
  d.native = "g++ 編譯的程式會在這一行崩潰（Segmentation fault）。";
  return d;
}

/** 條件裡的變數換成這一步的值：x > 0 → 0 > 0。 */
function substitute(cond: string, vars: any): string {
  return cond.replace(/\b[A-Za-z_]\w*\b/g, (n: string) => (own(vars, n) && (typeof vars[n] === "number" || typeof vars[n] === "boolean") ? String(vars[n]) : n));
}

function defaultValue(retType: string): string {
  if (/\bbool\b/.test(retType)) return "false";
  if (/\b(int|long|short|char|double|float|size_t|unsigned)\b/.test(retType)) return "0";
  if (/string/.test(retType)) return '""';
  return "/* 要回傳的值 */";
}

function missingReturn(C: Ctx, d: RtDiag, e: RtError): RtDiag {
  const S = C.run.steps[d.step];
  const fn = S ? S.fn : "?";
  d.title = "函式走到結尾都沒有 return";
  d.en = "missing return";
  const close = d.code.lastIndexOf("}");
  d.bad = close >= 0 ? [close, close + 1] : null;
  const info = C.run.functions ? C.run.functions[fn] : undefined;
  const params = info ? info.params : [];
  const vars = S ? S.vars : {};
  // 這次呼叫實際走過的每一步
  const idxs: number[] = [];
  for (let k = d.step; k >= 0; k--) {
    const s = C.run.steps[k];
    if (!s || (S && s.depth < S.depth)) break;
    if (S && s.frame === S.frame) idxs.unshift(k);
  }
  const path = idxs.map((k, j) => {
    const s = C.run.steps[k];
    const text = stripComment(C.lines[s.line - 1] || "");
    const c = C.codes[s.line - 1] || "";
    const last = j === idxs.length - 1;
    let note = "";
    let skip: [number, number] | null = null;
    if (last) note = "到了結尾，沒有 return";
    else {
      const m = /\bif\s*\(/.exec(c);
      const r = /\breturn\b[^;]*;/.exec(c);
      if (m && r) {
        const open = m.index + m[0].length - 1;
        const cl = matchClose(c, open);
        if (cl > 0) note = `${substitute(text.slice(open + 1, cl).trim(), s.vars)} 不成立`;
        skip = [r.index, r.index + r[0].length];
      }
    }
    return { line: s.line, code: text, note, skip, last };
  });
  const sigCode = info ? stripComment(C.lines[info.line - 1] || "") : "";
  const ps = params.map((p) => ({ name: p, value: fmtVar(C.run, fn, p, vars[p]) }));
  d.pic = { fn, params: ps, path, sig: info ? { line: info.line, code: sigCode } : null };
  const retM = new RegExp("^\\s*(.*?)\\b" + escapeRe(fn.split("::").pop() || fn) + "\\s*\\(").exec(sigCode);
  const retType = retM ? retM[1].trim() || "int" : "int";
  const callerStep = idxs.length && idxs[0] > 0 ? idxs[0] - 1 : -1;
  const call = (callerStep >= 0 && callText(C.lines[C.run.steps[callerStep].line - 1] || "", fn)) || `${fn}(${ps.map((p) => p.value).join(", ")})`;
  const walked = path.filter((p) => !p.last).map((p) => p.line);
  const ifs = path.filter((p) => p.note && !p.last).length;
  d.what = [
    `\`${call}\` ${walked.length ? `依序走過第 ${walked.join("、")} 行` : "一進去"}${ifs ? `，${zhCount(ifs)}個 if 都不成立，${zhCount(ifs)}個 return 都沒有執行` : ""}，就走到第 ${d.line} 行的 }。${retType} 函式結束前一定要 return 一個值，這裡沒有，所以 \`${call}\` 沒有答案。`,
  ];
  const os: RtOrigin[] = [];
  params.forEach((p) => {
    const o = makeOrigin(C, d.step, p, `${p} = ${fmtVar(C.run, fn, p, vars[p])}`);
    if (o) os.push(o);
  });
  d.origins = os;
  if (!os.length) d.originNote = "這個函式沒有參數。";
  // 怎麼改：整個函式（走過的行），結尾補上 return
  const code: RtFixLine[] = [];
  if (info) {
    code.push({ text: sigCode.replace(/\s+$/, "") });
    let prev = info.line;
    path
      .filter((p) => !p.last)
      .forEach((p) => {
        if (p.line > prev + 1) code.push({ text: "  …" });
        code.push({ text: p.code.replace(/\s+$/, "") });
        prev = p.line;
      });
    if (d.line > prev + 1) code.push({ text: "  …" });
  }
  const cond = ps.map((p) => `${p.name} == ${p.value}`).join("、");
  code.push({ text: `  return ${defaultValue(retType)};${cond ? `   // ${cond}` : ""}`, add: true }, { text: d.code.trim() });
  d.fix = { text: ps.length ? `補上 ${ps.map((p) => `${p.name} 等於 ${p.value}`).join("、")} 的情況。` : "在函式結尾補上 return。", code };
  if (e.line && e.col) d.rawWhere = `第 ${e.line} 行第 ${byteColToIndex(C.lines[e.line - 1] || "", e.col) + 1} 個字`;
  d.rawNote = `錯誤紀錄的位置是函式名稱 ${fn}（第 ${e.line} 行）；程式實際停在第 ${d.line} 行的 }。`;
  d.native = `g++ 編譯的程式也會在這裡中止（Illegal instruction）。g++ 編譯時其實已經警告：control reaches end of non-void function（第 ${d.line} 行）。`;
  return d;
}

function frameLabel(run: RtRun, s: RtStep): string {
  const info = run.functions ? run.functions[s.fn] : undefined;
  const ps = info ? info.params : [];
  return `${s.fn}(${ps.map((p) => `${p} = ${fmtVar(run, s.fn, p, s.vars[p])}`).join(", ")})`;
}

function stackOverflow(C: Ctx): RtDiag {
  const run = C.run;
  const d = base("stack-overflow");
  const n = run.steps.length;
  const last = n - 1;
  const S = run.steps[last];
  d.en = "stack overflow";
  d.raw = String((run.exit && run.exit.message) || "stack overflow");
  d.rawWhere = "引擎回報";
  d.rawNote = "這種錯誤沒有錯誤紀錄，是引擎回報堆疊用完（stack-overflow）。";
  if (!S) {
    d.title = "呼叫太多層，堆疊用完了";
    d.what = ["堆疊空間用完了。"];
    return d;
  }
  const D = S.depth;
  const fn = S.fn;
  const short = fn.split("::").pop() || fn;
  d.step = last;
  d.line = S.line;
  d.code = C.lines[S.line - 1] || "";
  const code = C.codes[S.line - 1] || "";
  const call = new RegExp("\\b" + escapeRe(short) + "\\s*\\(").exec(code);
  let callExpr = "";
  if (call) {
    const cl = matchClose(code, call.index + call[0].length - 1);
    if (cl > 0) {
      d.bad = [call.index, cl + 1];
      callExpr = d.code.slice(call.index, cl + 1);
    }
  }
  // 塔：最下面 B 層（從頭找）與最上面 3 層（從尾找），中間省略
  const B = Math.min(6, D);
  const firstAt: { [depth: number]: number } = {};
  let found = 0;
  for (let k = 0; k < n && found < B; k++) {
    const s = run.steps[k];
    if (!s) break;
    if (s.depth <= B && firstAt[s.depth] === undefined) {
      firstAt[s.depth] = k;
      found++;
    }
  }
  const topDepths = [D, D - 1, D - 2].filter((x) => x > B);
  const lastAt: { [depth: number]: number } = {};
  for (let k = last; k >= 0 && topDepths.some((x) => lastAt[x] === undefined); k--) {
    const s = run.steps[k];
    if (!s) break;
    if (topDepths.indexOf(s.depth) >= 0 && lastAt[s.depth] === undefined) lastAt[s.depth] = k;
  }
  const mk = (k: number, depth: number) => {
    const s = run.steps[k];
    return { depth, step: k, label: frameLabel(run, s), fn: s.fn, note: "", red: false, zero: false };
  };
  const top = topDepths.filter((x) => lastAt[x] !== undefined).map((x) => mk(lastAt[x], x));
  const bottom = [] as ReturnType<typeof mk>[];
  for (let x = B; x >= 1; x--) if (firstAt[x] !== undefined) bottom.push(mk(firstAt[x], x));
  if (top.length) {
    top[0].note = "堆疊在這一層用完";
    top[0].red = true;
  }
  const info = run.functions ? run.functions[fn] : undefined;
  const params = info ? info.params : [];
  const p0 = params[0];
  // 第一個參數在每一層的值（由淺到深）
  const seq: any[] = bottom
    .slice()
    .reverse()
    .filter((f) => f.fn === fn)
    .map((f) => run.steps[f.step].vars[p0]);
  const numeric = !!p0 && seq.length >= 3 && seq.every((v) => typeof v === "number");
  const delta = numeric ? seq[1] - seq[0] : 0;
  const steady = numeric && delta !== 0 && seq.every((v, i) => i === 0 || v - seq[i - 1] === delta);
  if (numeric && seq[seq.length - 1] < 0) {
    const zero = bottom.filter((f) => f.fn === fn && run.steps[f.step].vars[p0] === 0)[0];
    if (zero) {
      zero.note = `${p0} 經過 0，繼續變成負數`;
      zero.zero = true;
    }
  }
  const firstCall = firstAt[2];
  const callerStep = firstCall !== undefined && firstCall > 0 ? firstCall - 1 : -1;
  const f2 = bottom.filter((f) => f.depth === 2)[0];
  const gap = Math.max(0, D - top.length - B);
  // 停不下來（沒有停止條件）：函式裡沒有任何條件判斷，而且每個 return 都在呼叫自己
  let infinite = false;
  let neverHit: any = null;
  if (info) {
    const body = C.codes.slice(info.line - 1, info.closeLine).join("\n");
    const inner = body.slice(body.indexOf("{") + 1);
    const self = new RegExp("\\b" + escapeRe(short) + "\\s*\\(");
    const hasCond = /\b(if|while|for|switch)\b|\?/.test(inner);
    const rets = inner.match(/\breturn\b[^;]*;/g) || [];
    infinite = !hasCond && self.test(inner) && rets.every((r) => self.test(r));
    if (!infinite && steady) {
      const m = new RegExp("\\bif\\s*\\(\\s*" + escapeRe(p0) + "\\s*==\\s*(-?\\d+)\\s*\\)").exec(inner);
      if (m) {
        const target = Number(m[1]);
        const hits = (target - seq[0]) % delta === 0 && (target - seq[0]) / delta >= 0;
        if (!hits) neverHit = { name: p0, target, start: seq[0], delta };
      }
    }
  }
  d.title = infinite ? "遞迴停不下來，堆疊用完了" : "呼叫太多層，堆疊用完了";
  const perLevel = steady ? `每層 ${p0} ${delta < 0 ? "少" : "多"} ${Math.abs(delta)}` : "";
  d.pic = { fn, depth: D, infinite, gap, top, bottom, neverHit, callText: callExpr, perLevel };
  if (infinite) {
    d.what = [`\`${fn}\` 的每一層都再呼叫 \`${callExpr || fn + "(…)"}\`。函式裡沒有「不呼叫自己就 return」的路，所以永遠停不下來；呼叫到第 ${D} 層時，堆疊空間用完了。`];
  } else {
    const nh = neverHit
      ? `停止條件 \`${neverHit.name} == ${neverHit.target}\`：${neverHit.name} 從 ${neverHit.start} 開始每層${neverHit.delta < 0 ? "少" : "多"} ${Math.abs(neverHit.delta)}（${seq
          .slice(0, 4)
          .join("、")}……），永遠不會剛好等於 ${neverHit.target}。`
      : "";
    d.what = [
      `呼叫到第 ${D} 層時，堆疊空間用完了。可能是下面兩種情況之一：`,
      `① 停止條件一直沒有成立，遞迴停不下來。${nh}`,
      "② 遞迴其實會停，只是要走的層數超過瀏覽器引擎的堆疊上限。這不是程式的錯，是瀏覽器引擎的限制。",
    ];
  }
  if (callerStep >= 0) {
    const cl = run.steps[callerStep].line;
    d.origins = [
      { name: fn, label: `第一次呼叫 ${f2 ? f2.label : fn}`, desc: `第 ${cl} 行 \`${stripComment(C.lines[cl - 1] || "").trim()}\``, step: callerStep, line: cl, how: "call" },
    ];
  }
  if (infinite) {
    const sigLine = info ? stripComment(C.lines[info.line - 1] || "").trim() : "";
    const toZero = steady && delta < 0;
    d.fix = {
      text: toZero ? `加上停止條件：${p0} 到 0 時直接 return，不再呼叫自己。` : "加上停止條件：遇到最小的情況就直接 return，不再呼叫自己。",
      code: [
        { text: sigLine },
        ...(p0
          ? [
              { text: "  // 回傳值依題目決定", add: true },
              { text: `  if (${p0} == 0) return ${defaultValue(sigLine)};`, add: true },
            ]
          : [{ text: "  if (/* 停止條件 */) return …;", add: true }]),
        { text: "  " + stripComment(d.code).trim() },
        { text: "}" },
      ],
    };
  } else if (neverHit) {
    const condRe = new RegExp("\\bif\\s*\\(\\s*" + escapeRe(neverHit.name) + "\\s*==");
    let condLine = "";
    if (info) for (let l = info.line; l <= info.closeLine && !condLine; l++) if (condRe.test(C.codes[l - 1] || "")) condLine = stripComment(C.lines[l - 1] || "");
    const opNew = neverHit.delta < 0 ? "<=" : ">=";
    const fixed = condLine.trim().replace(new RegExp(escapeRe(neverHit.name) + "\\s*==\\s*"), `${neverHit.name} ${opNew} `);
    d.fix = { text: `讓停止條件一定會成立：${neverHit.name} 每層${neverHit.delta < 0 ? "變小" : "變大"}，條件改成 ${opNew} 就一定會碰到。`, code: fixed ? [{ text: fixed, add: true }] : [] };
  } else {
    d.fix = { text: "先確認停止條件一定會成立；如果遞迴其實會停、只是太深，可以改用迴圈。", code: [] };
  }
  d.native = infinite
    ? "g++ 編譯的程式也會崩潰（Segmentation fault）。"
    : "g++ 編譯的程式如果真的停不下來，也會崩潰（Segmentation fault）；原生 Linux 的堆疊大小和瀏覽器不同，會停的遞迴在兩邊能走的層數不一樣。";
  return d;
}
