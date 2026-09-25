import fs from "node:fs";
import { compile, run } from "./driver.mjs";
const mine = fs.readFileSync("mine/stdc++.h", "utf8");
const extra = { "include/bits/stdc++.h": mine };
for (const std of ["c++17", "c++20", "c++23"]) {
  const r = await compile({ source: fs.readFileSync("cases/stdcpp.cpp", "utf8"), flags: [`-std=${std}`, "-fno-exceptions"], extraFiles: extra });
  if (!r.ok) { console.log("✗", std, r.stage, "\n ", r.log.split("\n").filter(l=>/error|fatal/.test(l)).slice(0,4).join("\n  ")); continue; }
  const x = await run(r.module, "");
  console.log("✓ bits/stdc++.h", std, "| 輸出:", JSON.stringify(x.out), "| wasm", (r.size/1024).toFixed(0)+"KB", "| ms: compile", r.t.compile.toFixed(0), "link", r.t.link.toFixed(0));
}
