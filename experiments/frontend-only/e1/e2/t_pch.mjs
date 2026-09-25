// E3：PCH 對編譯時間的影響（用插樁後的技巧一，比較有／無 PCH）。
import fs from "node:fs";
import { compile, run } from "../driver.mjs";
import { instrument } from "./instrument.mjs";

const vg = fs.readFileSync("vg.h", "utf8");
const src = fs.readFileSync("../lessons/tsp.cpp", "utf8");
const inp = fs.readFileSync("../lessons/tsp.in", "utf8");
const ins = await instrument(src);
const NL = String.fromCharCode(10);
const commonSrc = ["#include <iostream>", "#include <vector>", "#include <algorithm>", "#include <string>", "#include <map>", "#include <set>", '#include "vg.h"', ""].join(NL);
const fullSrc = ["#include <bits/stdc++.h>", '#include "vg.h"', ""].join(NL);
const stdcpp = fs.readFileSync("../mine/stdc++.h", "utf8");
const common = fs.readFileSync("pch_common.pch"), full = fs.readFileSync("pch_full.pch");
const base = ["-std=c++17", "-fno-exceptions"];
const pchFlags = (f) => ["-Xclang", "-include-pch", "-Xclang", f, "-Xclang", "-fno-validate-pch"];

async function once(label, flags, extra) {
  const t = performance.now();
  const r = await compile({ source: ins.text, flags, extraFiles: { "include/vg.h": vg, "include/bits/stdc++.h": stdcpp, ...extra } });
  const ms = performance.now() - t;
  if (!r.ok) { console.log(label.padEnd(24), "✗", r.stage, r.log.split(NL).filter((l) => /error|fatal/.test(l))[0]?.slice(0, 130)); return; }
  const x = await run(r.module, inp);
  const ok = x.out.split(NL).filter((l) => !l.includes("VG{")).join("|") === "3 2 2 1|6|";
  console.log(label.padEnd(24), "編譯", String(Math.round(r.t.compile)).padStart(5), "ms  連結", String(Math.round(r.t.link)).padStart(4), "ms  載入", String(Math.round(r.t.load)).padStart(4), "ms  總", String(Math.round(ms)).padStart(5), "ms | 輸出正確:", ok);
}

await once("無 PCH（現況）", [...base, "-include", "vg.h"], {});
await once("PCH：常用 6 個標頭", [...base, ...pchFlags("common.pch")], { "common.pch": common, "pch_src.h": commonSrc });
await once("PCH：完整 stdc++.h", [...base, ...pchFlags("full.pch")], { "full.pch": full, "pch_src.h": fullSrc });
await once("無 PCH（再一次）", [...base, "-include", "vg.h"], {});
