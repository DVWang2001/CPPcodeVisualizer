// E2 插樁器：用 clang 的 AST 決定每個 GDB 會停的位置，插入探針；只做「插入」，不改行號。
//
// GDB `next` 在 gcc -O0 下的停駐規則（實測後寫在這裡）：
//   * 沒有初值的宣告（int h, w;）沒有機器碼，不停。
//   * for：在 for 那行停一次做 init，之後每次「遞增」再停一次；條件判斷跟遞增同一行，不再多停。
//   * while / if：每次求值條件停一次（else if 各自在自己那行停）。
//   * return X;：先停在 return 那行，算完 X 之後停在函式的 `}`。
import fs from "node:fs";
import { astOf } from "./ast.mjs";
import { splitJson } from "./jsonsplit.mjs";

export async function instrument(source, { funcs = ["main"], std = "c++17" } = {}) {
  const buf = Buffer.from(source, "utf8");
  const lineStarts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lineStarts.push(i + 1);
  const lineAt = (off) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };

  const edits = [];
  const ins = (at, text) => edits.push({ at, text, seq: edits.length });
  ins(0, "#include <vg.h> ");

  const begin = (n) => n.range.begin.offset;
  const endTok = (n) => n.range.end.offset + (n.range.end.tokLen || 0);
  // 語句結尾：若後面緊跟 `;` 就一起吃掉（Expr／Return／Break 的 range 不含分號）
  const endStmt = (n) => { let e = endTok(n); let k = e; while (k < buf.length && (buf[k] === 32 || buf[k] === 9)) k++; return buf[k] === 59 ? k + 1 : e; };

  const names = (scopes) => { const seen = new Map(); for (const sc of scopes) for (const v of sc) seen.set(v, true); return [...seen.keys()]; };
  const vars = (scopes) => "{" + names(scopes).map((n) => `__vg::v("${n}", ${n})`).join(", ") + "}";
  let curFn = "main";
  const probe = (line, scopes) => `__vg::step(${line}, "${curFn}", ${vars(scopes)})`;

  const unsupported = new Set(["CXXForRangeStmt", "SwitchStmt", "DoStmt", "CaseStmt", "DefaultStmt", "LabelStmt", "GotoStmt", "CXXTryStmt"]);
  const declHasInit = (d) => d.kind === "VarDecl" && (d.init !== undefined || (d.inner || []).some((c) => /Expr|Literal|Init/.test(c.kind || "")));

  function compound(node, scopes, ctx) {
    scopes.push([]);
    for (const st of node.inner || []) stmt(st, scopes, ctx);
    scopes.pop();
  }
  function body(node, scopes, ctx) {
    if (node.kind === "CompoundStmt") return compound(node, scopes, ctx);
    ins(begin(node), "{ ");
    stmt(node, scopes, ctx);
    ins(endStmt(node), " }");
  }
  function stmt(st, scopes, ctx) {
    const L = lineAt(begin(st));
    if (unsupported.has(st.kind)) throw new Error("E2 尚未支援的語句：" + st.kind + " @行 " + L);
    switch (st.kind) {
      case "NullStmt": return;
      case "CompoundStmt": return compound(st, scopes, ctx);
      case "DeclStmt": {
        const ds = (st.inner || []).filter((d) => d.kind === "VarDecl");
        if (ds.some(declHasInit)) ins(begin(st), probe(L, scopes) + "; ");
        for (const d of ds) { scopes[scopes.length - 1].push(d.name); if (!declHasInit(d)) ctx.uninit.push({ name: d.name, line: L }); }
        return;
      }
      case "ForStmt": {
        const [init, , cond, inc, bodyN] = st.inner;
        ins(begin(st), probe(L, scopes) + "; ");
        scopes.push([]);
        if (init && init.kind === "DeclStmt") for (const d of init.inner || []) if (d.kind === "VarDecl") scopes[scopes.length - 1].push(d.name);
        if (inc && inc.kind) { ins(begin(inc), "(" + probe(L, scopes) + ", "); ins(endTok(inc), ")"); }
        body(bodyN, scopes, ctx);
        scopes.pop();
        return;
      }
      case "WhileStmt": {
        const cond = st.inner[st.inner.length - 2], bodyN = st.inner[st.inner.length - 1];
        ins(begin(cond), "(" + probe(L, scopes) + ", "); ins(endTok(cond), ")");
        body(bodyN, scopes, ctx);
        return;
      }
      case "IfStmt": {
        let i = 0; if (st.hasInit) i++; if (st.hasVar) i++;
        const cond = st.inner[i], thenN = st.inner[i + 1], elseN = st.hasElse ? st.inner[i + 2] : null;
        ins(begin(cond), "(" + probe(L, scopes) + ", "); ins(endTok(cond), ")");
        body(thenN, scopes, ctx);
        if (elseN) body(elseN, scopes, ctx);
        return;
      }
      case "ReturnStmt": {
        const closeVars = [scopes[0], scopes[1] || []];
        const expr = (st.inner || [])[0];
        ins(begin(st), "{ " + probe(L, scopes) + "; ");
        if (expr) {
          ins(begin(expr), "__vg::ret(");
          ins(endTok(expr), `, [&]{ ${probe(ctx.closeLine, closeVars)}; })`);
        } else {
          ins(begin(st), probe(ctx.closeLine, closeVars) + "; ");
        }
        ins(endStmt(st), " }");
        return;
      }
      default: // 運算式語句、break、continue…
        ins(begin(st), probe(L, scopes) + "; ");
    }
  }

  const ctxAll = { uninit: [], funcs: {} };
  for (const fn of funcs) {
    const objs = splitJson((await astOf(source, { std, filter: fn })).out);
    const decl = objs.find((o) => o.kind === "FunctionDecl" && o.name === fn && (o.loc?.file === "main.cpp" || o.loc?.includedFrom === undefined) && (o.inner || []).some((c) => c.kind === "CompoundStmt"));
    if (!decl) throw new Error("找不到函式定義：" + fn);
    const bodyN = decl.inner.find((c) => c.kind === "CompoundStmt");
    const params = (decl.inner || []).filter((c) => c.kind === "ParmVarDecl").map((p) => p.name).filter(Boolean);
    curFn = fn;
    const closeLine = lineAt(bodyN.range.end.offset);
    const ctx = { closeLine, uninit: ctxAll.uninit };
    const scopes = [params];
    scopes.push([]);
    for (const st of bodyN.inner || []) stmt(st, scopes, ctx);
    // 函式正常結束（沒走 return）也要停在 `}`
    ins(bodyN.range.end.offset, probe(closeLine, [scopes[0], scopes[1]]) + "; ");
    ctxAll.funcs[fn] = { closeLine };
  }

  edits.sort((a, b) => a.at - b.at || a.seq - b.seq);
  let out = "", prev = 0;
  for (const e of edits) { out += buf.subarray(prev, e.at).toString("utf8") + e.text; prev = e.at; }
  out += buf.subarray(prev).toString("utf8");
  return { text: out, uninit: ctxAll.uninit, funcs: ctxAll.funcs };
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const r = await instrument(fs.readFileSync(process.argv[2], "utf8"), { funcs: (process.argv[3] || "main").split(",") });
  fs.writeFileSync("instrumented.cpp", r.text);
  console.log("行數 原/插樁後:", fs.readFileSync(process.argv[2], "utf8").split("\n").length, r.text.split("\n").length, "| 未初始化宣告:", JSON.stringify(r.uninit));
}
