// A/B check: run the golden program (tsp_uva116 lesson) and print exit, errors, timings.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodeEngine } from "../../tests/engine/node_driver.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESSON = path.join(ROOT, "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.cpp");
const STDIN = path.join(ROOT, "experiments", "frontend-only", "e1", "e2", "ref", "tsp.in");
const src = fs.readFileSync(LESSON, "utf8");
const stdin = fs.readFileSync(STDIN, "utf8");
const eng = await loadNodeEngine();
const t0 = Date.now();
const r = await eng.runProgram(src, stdin, {});
console.log(`ok=${r.ok} exit=${JSON.stringify(r.exit)} errors=${JSON.stringify(r.errors).slice(0, 400)}`);
console.log(`steps=${r.steps.length} rawSteps=${r.rawSteps} stdoutBytes=${Buffer.byteLength(r.stdout)} wallMs=${Date.now() - t0} timings=${JSON.stringify(r.timings).slice(0, 300)}`);
eng.dispose();
