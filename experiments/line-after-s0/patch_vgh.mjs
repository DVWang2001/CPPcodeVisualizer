// Experiment-only patch (applied to a temp COPY of the engine on lab-david, never to the repo):
// flush stdout at the start of every probe, before the trace record is written to fd 3.
import fs from "node:fs";
const file = process.argv[2];
let s = fs.readFileSync(file, "utf8");
const anchor = "inline void step(int probe, int line, const char* fn, std::initializer_list<Var> vars) {";
if (!s.includes(anchor)) throw new Error("anchor not found");
if (s.includes("std::fflush(stdout);")) throw new Error("already patched");
s = s.replace(anchor, anchor + " std::fflush(stdout);");
fs.writeFileSync(file, s);
console.log("patched " + file);
