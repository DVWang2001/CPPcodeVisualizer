// E3：PCH 對「AST 分析」與「編譯」的影響，每種設定重複量測、取中位數（V8 有暖機，單次很吵）。
import fs from "node:fs";
import { compile } from "../driver.mjs";
import { instrument } from "./instrument.mjs";
import { userDecls } from "./userast.mjs";

const NL = String.fromCharCode(10);
const vg = fs.readFileSync("vg.h", "utf8");
const stdcpp = fs.readFileSync("../mine/stdc++.h", "utf8");
const src = fs.readFileSync("../lessons/tsp.cpp", "utf8");
const commonSrc = ["#include <iostream>", "#include <vector>", "#include <algorithm>", "#include <string>", "#include <map>", "#include <set>", '#include "vg.h"', ""].join(NL);
const common = fs.readFileSync("pch_common.pch");
const pchFlags = ["-Xclang", "-include-pch", "-Xclang", "common.pch", "-Xclang", "-fno-validate-pch"];
const pchFiles = { "common.pch": common, "pch_src.h": commonSrc, "include/vg.h": vg, "include/bits/stdc++.h": stdcpp };
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const N = 5;

async function timeAst(label, astOpts) {
  const ts = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await userDecls(src, "c++17", astOpts); ts.push(performance.now() - t); }
  console.log(label.padEnd(22), "AST 分析  中位數", Math.round(med(ts)), "ms  （每次:", ts.map(Math.round).join(", "), ")");
}
const ins = await instrument(src);
async function timeCompile(label, flags, extra) {
  const ts = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await compile({ source: ins.text, flags, extraFiles: { "include/vg.h": vg, ...extra } });
    if (!r.ok) { console.log(label, "✗", r.log.split(NL).filter((l) => /error|fatal/.test(l))[0]?.slice(0, 120)); return; }
    ts.push(performance.now() - t);
  }
  console.log(label.padEnd(22), "編譯＋連結 中位數", Math.round(med(ts)), "ms  （每次:", ts.map(Math.round).join(", "), ")");
}

await timeAst("無 PCH", {});
await timeAst("PCH（常用標頭）", { flags: pchFlags, extraFiles: pchFiles });
await timeCompile("無 PCH", ["-std=c++17", "-fno-exceptions", "-include", "vg.h"], {});
await timeCompile("PCH（常用標頭）", ["-std=c++17", "-fno-exceptions", ...pchFlags], pchFiles);
