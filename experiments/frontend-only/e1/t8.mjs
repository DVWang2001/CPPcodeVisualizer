import fs from "node:fs";
import { compile, run } from "./driver.mjs";
const extra = { "include/bits/stdc++.h": fs.readFileSync("mine/stdc++.h", "utf8") };
let allOk = true;
for (const n of ["tsp", "run", "grid1", "deriv"]) {
  const ref = fs.readFileSync(`lessons/${n}.ref`, "utf8").replace(/\r/g, "");
  for (const std of ["c++17", "c++20"]) {
    const r = await compile({ source: fs.readFileSync(`lessons/${n}.cpp`, "utf8"), flags: [`-std=${std}`, "-fno-exceptions"], extraFiles: extra });
    if (!r.ok) { allOk = false; console.log("✗", n, std, r.stage, r.log.split("\n").filter(l => /error/.test(l)).slice(0, 3).join(" | ")); continue; }
    const x = await run(r.module, fs.readFileSync(`lessons/${n}.in`, "utf8"));
    const same = x.out.replace(/\r/g, "") === ref;
    if (!same) allOk = false;
    console.log(same ? "✓" : "✗", n.padEnd(5), std, "輸出", JSON.stringify(x.out), same ? "= GCC" : "≠ GCC " + JSON.stringify(ref), "| ms compile", r.t.compile.toFixed(0), "link", r.t.link.toFixed(0), "| wasm KB", (r.size / 1024).toFixed(0));
  }
}
console.log(allOk ? "\n四份教案全部與 GCC 輸出一致" : "\n有不一致");
