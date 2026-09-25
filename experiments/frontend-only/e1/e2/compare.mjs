import fs from "node:fs";
import { dedupeSameLine } from "./dedupe.mjs";
const ours = dedupeSameLine(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
const ref = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const useFn = ref.length && ref[0].fn !== undefined;
const key = (s) => (useFn ? s.fn + ":" : "") + s.line;
const a = ours.map(key), b = ref.map(key);
console.log("我們", a.length, "步 | GDB", b.length, "步");
let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
console.log("行序列第一個分歧點: 第", i, "步（0 起算）");
if (i < Math.min(a.length, b.length)) {
  console.log("  我們:", a.slice(Math.max(0, i - 6), i + 8).join(" "));
  console.log("  GDB :", b.slice(Math.max(0, i - 6), i + 8).join(" "));
} else console.log("  較短的一邊的所有步都相同；較長者多出:", (a.length > b.length ? a : b).slice(i).join(" "));
