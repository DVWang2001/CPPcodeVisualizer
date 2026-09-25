import fs from "node:fs";
import { compile, run } from "../driver.mjs";
const r = await compile({ source: fs.readFileSync("cases/capacity.cpp", "utf8"), flags: ["-std=c++17", "-fno-exceptions"] });
if (!r.ok) { console.log("✗", r.log.split(String.fromCharCode(10)).filter((l) => /error/.test(l))[0]); process.exit(1); }
fs.writeFileSync("cap_clang.txt", (await run(r.module, "")).out);
