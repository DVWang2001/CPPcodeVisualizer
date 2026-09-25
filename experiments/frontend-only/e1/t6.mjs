import fs from "node:fs";
import { compile, run } from "./driver.mjs";
import { pbdsFiles } from "./pbds.mjs";
const GCC = "gcc-src/libstdc++-v3/include/";
const extra = { "include/bits/stdc++.h": fs.readFileSync("mine/stdc++.h", "utf8"), "include/bits/c++config.h": fs.readFileSync("mine/compat/bits/c++config.h", "utf8"), "include/bits/extc++.h": fs.readFileSync("mine/extc++.h", "utf8"), ...pbdsFiles() };
for (const f of fs.existsSync("mine/overrides") ? fs.readdirSync("mine/overrides", { recursive: true }) : []) {
  const p = "mine/overrides/" + f; if (fs.statSync(p).isFile()) extra["include/" + f.split("\\").join("/")] = fs.readFileSync(p, "utf8");
}
const srcFile = process.argv[2] || "cases/extcpp.cpp";
const src = fs.readFileSync(srcFile, "utf8");
const added = [];
for (let i = 0; i < 40; i++) {
  const r = await compile({ source: src, flags: [`-std=${process.argv[3] || "c++17"}`, "-fno-exceptions"], extraFiles: extra });
  if (r.ok) { const x = await run(r.module, ""); if (process.env.OUT) fs.writeFileSync(process.env.OUT, x.out); console.log("✓ 編譯成功", "自動補入的 GCC 標頭:", added.join(" ") || "(無)", "\n  執行 exit", x.exit, JSON.stringify(x.out), "| compile ms", r.t.compile.toFixed(0), "wasm KB", (r.size/1024).toFixed(0)); process.exit(0); }
  const errs = r.log.split("\n").filter(l => /error|fatal/.test(l));
  const nf = errs.map(l => l.match(/'([^']+)' file not found/)?.[1]).find(Boolean);
  if (nf && fs.existsSync(GCC + nf) && !("include/" + nf in extra)) { extra["include/" + nf] = fs.readFileSync(GCC + nf, "utf8"); added.push(nf); continue; }
  console.log("✗ 停在第", i, "輪；補入:", added.join(" ") || "(無)", "\n錯誤數", errs.length);
  console.log(errs.slice(0, 16).map(l => l.replace(/^.*?(include\/|main\.cpp)/, "$1")).join("\n"));
  process.exit(1);
}
