// 取得「使用者自己宣告的所有東西」的 AST：把使用者程式碼包進命名空間 __vg_user，
// 用 -ast-dump-filter=__vg_user 一次 dump 全部（全域變數、所有函式），不必逐個名字去問。
// 只是拿來分析，這份包過命名空間的程式碼不會被編譯。命名空間開頭插在「最後一個 #include 的下一行行首」，
// 不新增任何一行，所以行號不變；偏移量要減掉插入的長度才是原始碼的偏移量。
import { astOf } from "./ast.mjs";
import { splitJson } from "./jsonsplit.mjs";

const NS = "namespace __vg_user { ";

export async function userDecls(source, std = "c++17", astOpts = {}) {
  const lines = source.split("\n");
  let lastInc = -1;
  lines.forEach((l, i) => { if (/^\s*#\s*include\b/.test(l)) lastInc = i; });
  const insLine = lastInc + 1;                       // 插在這一行的行首
  const insAt = Buffer.byteLength(lines.slice(0, insLine).join("\n") + (insLine > 0 ? "\n" : ""), "utf8");
  const wrapped = lines.slice(0, insLine).join("\n") + (insLine > 0 ? "\n" : "") + NS + lines.slice(insLine).join("\n") + "\n}\n";
  const shift = Buffer.byteLength(NS, "utf8");
  const un = (off) => (off >= insAt + shift ? off - shift : off);
  const objs = splitJson((await astOf(wrapped, { std, filter: "__vg_user", ...astOpts })).out);
  const norm = (n) => { // 偏移量還原成原始碼的偏移量（遞迴）
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(norm);
    const o = {};
    for (const [k, v] of Object.entries(n)) o[k] = (k === "offset" && typeof v === "number") ? un(v) : norm(v);
    return o;
  };
  const nsObj = objs.find((o) => o.kind === "NamespaceDecl" && o.name === "__vg_user");
  if (!nsObj) throw new Error("clang 沒有輸出使用者命名空間的 AST（語法錯誤？）");
  const top = (norm(nsObj).inner || []).filter((o) => o.range && ["FunctionDecl", "VarDecl"].includes(o.kind));
  const globals = top.filter((n) => n.kind === "VarDecl" && n.storageClass !== "extern").map((n) => ({ name: n.name, offset: n.range.begin.offset, type: n.type?.qualType }));
  const functions = top.filter((n) => n.kind === "FunctionDecl" && (n.inner || []).some((c) => c.kind === "CompoundStmt") && !n.isImplicit && !/^__vg/.test(n.name));
  return { globals, functions };
}

import { pathToFileURL } from "node:url";
import fs from "node:fs";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const t = performance.now();
  const r = await userDecls(fs.readFileSync(process.argv[2], "utf8"));
  console.log("耗時", (performance.now() - t).toFixed(0), "ms");
  console.log("全域變數:", r.globals.map((g) => `${g.name}:${g.type}@${g.offset}`).join(" | "));
  console.log("函式:", r.functions.map((f) => f.name).join(", "));
}
