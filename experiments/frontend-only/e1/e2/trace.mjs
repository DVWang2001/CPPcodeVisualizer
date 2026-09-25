// 編譯插樁後的程式、執行、收集探針輸出（stderr 中前綴 \x01VG 的行）。
import fs from "node:fs";
import { compile } from "../driver.mjs";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import { instrument } from "./instrument.mjs";

const VG_H = fs.readFileSync(new URL("./vg.h", import.meta.url), "utf8");

export async function runTrace(source, stdinText, { funcs = ["main"], std = "c++17", maxSteps = 200000 } = {}) {
  const t0 = performance.now();
  const ins = await instrument(source, { funcs, std });
  const t1 = performance.now();
  const c = await compile({ source: ins.text, flags: [`-std=${std}`, "-fno-exceptions"], extraFiles: { "include/vg.h": VG_H } });
  const t2 = performance.now();
  if (!c.ok) return { ok: false, stage: c.stage, log: c.log, instrumented: ins.text };
  let out = "", errBuf = "";
  const fds = [new OpenFile(new File(new TextEncoder().encode(stdinText))),
    new ConsoleStdout((d) => { out += new TextDecoder().decode(d); }),
    new ConsoleStdout((d) => { errBuf += new TextDecoder().decode(d); })];
  const wasi = new WASI([], [], fds);
  const inst = await WebAssembly.instantiate(c.module, { wasi_snapshot_preview1: wasi.wasiImport });
  let exit; try { exit = wasi.start(inst); } catch (e) { exit = "trap: " + e.message; }
  const t3 = performance.now();
  const steps = [], stderr = [];
  for (const line of errBuf.split("\n")) {
    if (line.startsWith("\x01VG")) steps.push(JSON.parse(line.slice(3))); else if (line) stderr.push(line);
  }
  return { ok: true, steps, stdout: out, stderr, exit, uninit: ins.uninit, ms: { instrument: t1 - t0, compile: t2 - t1, run: t3 - t2 }, instrumented: ins.text };
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, inp] = [process.argv[2], process.argv[3]];
  const r = await runTrace(fs.readFileSync(src, "utf8"), fs.readFileSync(inp, "utf8"), { funcs: (process.argv[4] || "main").split(",") });
  if (!r.ok) { console.log("✗", r.stage, r.log.split("\n").filter((l) => /error/.test(l)).slice(0, 8).join("\n")); process.exit(1); }
  console.log("✓ 步數", r.steps.length, "| exit", r.exit, "| stdout", JSON.stringify(r.stdout), "| ms", JSON.stringify(Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)]))));
  console.log("前 12 步的行號:", r.steps.slice(0, 12).map((s) => s.line).join(" "));
  fs.writeFileSync("trace_" + src.split("/").pop().replace(".cpp", "") + ".json", JSON.stringify(r.steps));
}
