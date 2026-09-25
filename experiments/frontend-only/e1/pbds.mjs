import fs from "node:fs";
import path from "node:path";
const ROOT = "gcc-src/libstdc++-v3/include/";
export function pbdsFiles() {
  const out = {};
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else out["include/" + path.relative(ROOT, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8"); } };
  walk(ROOT + "ext/pb_ds");
  return out;
}
