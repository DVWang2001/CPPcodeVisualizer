// 在紀錄的快照（變數名 → JSON 值）上求值教案的 {表達式}。
// 支援：數字、變數、索引 a[i][j]、成員 size()/empty()/back()/front()/length()、算術、比較、邏輯、三元、括號。
// 不執行任何程式碼；求不出來就丟出帶分類的錯誤（EvalError.kind），讓呼叫端決定怎麼顯示。

export class EvalError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

const TOKEN = /\s*(?:(\d+\.\d+|\d+)|([A-Za-z_]\w*)|(&&|\|\||==|!=|<=|>=|->|[-+*/%<>!?:()\[\].,&]))/y;

function tokenize(src) {
  const out = []; TOKEN.lastIndex = 0; let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new EvalError("syntax", "無法解析：" + src.slice(pos, pos + 10));
    pos = TOKEN.lastIndex;
    out.push(m[1] !== undefined ? { t: "num", v: Number(m[1]), int: !m[1].includes(".") } : m[2] !== undefined ? { t: "id", v: m[2] } : { t: "op", v: m[3] });
  }
  return out;
}

export function evalExpr(src, vars) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const isOp = (v) => peek() && peek().t === "op" && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new EvalError("syntax", "缺少 " + v); p++; };
  const num = (x) => { if (typeof x === "string" && x.length === 1) return x.charCodeAt(0); if (typeof x !== "number") throw new EvalError("type", "不是數字"); return x; };

  function ternary() {
    const c = orExpr();
    if (isOp("?")) { p++; const a = ternary(); expect(":"); const b = ternary(); return num(c) ? a : b; }
    return c;
  }
  const bin = (sub, ops) => () => {
    let l = sub();
    while (peek() && peek().t === "op" && ops[peek().v]) { const op = next().v; l = ops[op](l, sub()); }
    return l;
  };
  const mul = () => unary();
  const additive = bin(function mulLevel() { let l = unary(); while (isOp("*") || isOp("/") || isOp("%")) { const op = next().v; const r = unary(); const a = num(l), b = num(r);
    if (op === "*") l = a * b; else if (op === "/") { if (b === 0) throw new EvalError("div0", "除以 0"); l = (Number.isInteger(a) && Number.isInteger(b)) ? Math.trunc(a / b) : a / b; } else { if (b === 0) throw new EvalError("div0", "除以 0"); l = a % b; } } return l; },
    { "+": (a, b) => num(a) + num(b), "-": (a, b) => num(a) - num(b) });
  const rel = bin(additive, { "<": (a, b) => +(num(a) < num(b)), ">": (a, b) => +(num(a) > num(b)), "<=": (a, b) => +(num(a) <= num(b)), ">=": (a, b) => +(num(a) >= num(b)) });
  const eq = bin(rel, { "==": (a, b) => +(num(a) === num(b)), "!=": (a, b) => +(num(a) !== num(b)) });
  const andExpr = bin(eq, { "&&": (a, b) => +(!!num(a) && !!num(b)) });
  const orExpr = bin(andExpr, { "||": (a, b) => +(!!num(a) || !!num(b)) });

  function unary() {
    if (isOp("-")) { p++; return -num(unary()); }
    if (isOp("!")) { p++; return +!num(unary()); }
    if (isOp("&")) throw new EvalError("unsupported", "取址 & 需要記憶體位址，快照裡沒有");
    return postfix();
  }
  function postfix() {
    const startTok = peek();
    let v = primary();
    let recv = startTok && startTok.t === "id" ? startTok.v : null;   // 只支援「變數名.capacity()」
    for (;;) {
      if (isOp("[")) {
        recv = null; p++; const i = num(ternary()); expect("]");
        if (!(Array.isArray(v) || typeof v === "string")) throw new EvalError("type", "不能對這個值取索引");
        if (!Number.isInteger(i) || i < 0 || i >= v.length) throw new EvalError("oob", `索引 ${i} 超出範圍 0..${v.length - 1}`);
        v = v[i];
      } else if (isOp(".")) {
        p++; const name = next(); if (!name || name.t !== "id") throw new EvalError("syntax", "成員名稱");
        if (isOp("(")) {
          p++; expect(")");
          const arr = v;
          const isC = Array.isArray(arr) || typeof arr === "string";
          if (!isC) throw new EvalError("type", "不是容器");
          if (name.v === "size" || name.v === "length") v = arr.length;
          else if (name.v === "empty") v = +(arr.length === 0);
          else if (name.v === "back") { if (!arr.length) throw new EvalError("oob", "空容器"); v = arr[arr.length - 1]; }
          else if (name.v === "front") { if (!arr.length) throw new EvalError("oob", "空容器"); v = arr[0]; }
          else if (name.v === "capacity" && recv !== null && (recv + ".capacity()") in vars) v = vars[recv + ".capacity()"];
          else throw new EvalError("unsupported", "成員函式 " + name.v + "()（快照沒有記錄）");
        } else throw new EvalError("unsupported", "成員 ." + name.v);
      } else return v;
    }
  }
  function primary() {
    const t = next();
    if (!t) throw new EvalError("syntax", "表達式不完整");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      if (isOp("(")) throw new EvalError("unsupported", "函式呼叫 " + t.v + "()");
      if (!(t.v in vars)) throw new EvalError("undefined", "變數 " + t.v + " 不在作用域內");
      return vars[t.v];
    }
    if (t.v === "(") { const v = ternary(); expect(")"); return v; }
    throw new EvalError("syntax", "意外的 " + t.v);
  }
  const v = ternary();
  if (p < toks.length) throw new EvalError("syntax", "多餘的字元");
  return v;
}
