// E3：失控程式的安全上限——探針層的步數／輸出量上限，以及 Worker 逾時強制終止。
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { compile } from "../driver.mjs";
import { instrument } from "./instrument.mjs";

const NL = String.fromCharCode(10);
const vg = fs.readFileSync("vg.h", "utf8");

function runGuarded(module, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const t = performance.now();
    const w = new Worker(new URL("./guard_worker.mjs", import.meta.url), { workerData: { module, stdin } });
    const timer = setTimeout(() => { w.terminate(); resolve({ killed: true, ms: performance.now() - t }); }, timeoutMs);
    w.on("message", (m) => { clearTimeout(timer); w.terminate(); resolve({ ...m, ms: performance.now() - t }); });
    w.on("error", (e) => { clearTimeout(timer); resolve({ error: String(e.message).slice(0, 80), ms: performance.now() - t }); });
  });
}

const cases = [
  ["while(true) 有探針", "int main() { int x = 0; while (true) { x++; } return 0; }"],
  ["for(;;){} 完全沒有探針", "int main() { for (;;) {} return 0; }"],
  ["無窮遞迴（每層有探針）", "int f(int n) { int a = n + 1; return f(a) + 1; } int main() { return f(0); }"],
  ["長時間但合法的迴圈 10 億次", "int main() { long long s = 0; for (int i = 0; i < 1000000000; i++) { s += i; } return (int)s; }"],
  ["一次配置 40 億個 int", "#include <vector>" + NL + "int main() { std::vector<int> v(4000000000ULL); v[0] = 1; return v[0]; }"],
  ["正常程式（對照）", "#include <iostream>" + NL + "int main() { int s = 0; for (int i = 0; i < 100; i++) s += i; std::cout << s << std::endl; return 0; }"],
];
console.log("案例".padEnd(28), "結果".padEnd(20), "耗時(ms)", "| 說明");
for (const [name, src] of cases) {
  const ins = await instrument(src);
  const c = await compile({ source: ins.text, flags: ["-std=c++17", "-fno-exceptions", "-include", "vg.h"], extraFiles: { "include/vg.h": vg } });
  if (!c.ok) { console.log(name.padEnd(28), "✗ 編譯失敗", c.log.split(NL).filter((l) => /error/.test(l))[0]?.slice(0, 80)); continue; }
  const r = await runGuarded(c.module, "", 2000);
  let verdict, note = "";
  if (r.killed) verdict = "Worker 逾時被終止";
  else if (r.error) { verdict = "Worker 錯誤"; note = r.error; }
  else if ((r.err || "").includes("VGLIMIT")) { verdict = "探針上限中止"; note = "exit " + r.exit + "，紀錄 " + (r.err.length / 1024).toFixed(0) + " KB"; }
  else { verdict = "正常結束 exit=" + String(r.exit).slice(0, 40); note = "stdout=" + JSON.stringify((r.out || "").slice(0, 20)); }
  console.log(name.padEnd(28), verdict.padEnd(20), String(Math.round(r.ms)).padStart(7), "|", note);
}
process.exit(0);
