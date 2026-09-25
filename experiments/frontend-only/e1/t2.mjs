import fs from "node:fs";
import { compile, run } from "./driver.mjs";
const NE = "-fno-exceptions";
const tests = [
 ["c++20 -fno-exceptions", ["-std=c++20", NE], "cases/cxx20.cpp", ""],
 ["c++23 -fno-exceptions", ["-std=c++23", NE], "cases/cxx23.cpp", ""],
 ["bits/stdc++.h c++17", ["-std=c++17", NE], "cases/stdcpp.cpp", ""],
 ["bits/stdc++.h c++20", ["-std=c++20", NE], "cases/stdcpp.cpp", ""],
 ["bits/extc++.h（pb_ds）c++17", ["-std=c++17", NE], "cases/extcpp.cpp", ""],
];
for (const [name, flags, file, input] of tests) {
  const r = await compile({ source: fs.readFileSync(file, "utf8"), flags });
  if (!r.ok) { console.log("✗", name, "階段:", r.stage, "| ms compile", r.t.compile.toFixed(0), "\n  ", r.log.split("\n").filter(l=>/error|fatal/.test(l)).slice(0,3).join("\n   ")); continue; }
  const x = await run(r.module, input);
  console.log("✓", name, "| 輸出:", JSON.stringify(x.out), "exit", x.exit, "| wasm", (r.size/1024).toFixed(0)+"KB", "| ms: compile", r.t.compile.toFixed(0), "link", r.t.link.toFixed(0));
}
