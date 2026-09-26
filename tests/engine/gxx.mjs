// Local g++ reference runner (native build of the ORIGINAL, uninstrumented program).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function gxxVersion() {
  const r = spawnSync("g++", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n")[0].trim() : null;
}

// On Windows (MinGW) stdin/stdout default to text mode (CRLF translation), unlike Linux where the
// GDB reference runs. A separate translation unit switches fds 0/1/2 to binary before main(); the
// student's source file itself is compiled unchanged.
const BINMODE_TU = `#include <fcntl.h>
#include <io.h>
__attribute__((constructor(101))) static void vg_binary_stdio() { _setmode(0, _O_BINARY); _setmode(1, _O_BINARY); _setmode(2, _O_BINARY); }
`;
/** @param {string} dir */
function binmodeObject(dir) {
  if (process.platform !== "win32") return [];
  const p = path.join(dir, "vg_binmode.cpp");
  fs.writeFileSync(p, BINMODE_TU);
  return [p];
}

/** Compile `source` with g++ -std=c++17 -O0 and run it on `stdin` (binary stdio, Linux semantics). */
export function gxxRun(source, stdin, { std = "c++17", extraFlags = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-gxx-"));
  const tag = crypto.createHash("sha1").update(source).digest("hex").slice(0, 10);
  const src = path.join(dir, tag + ".cpp"), exe = path.join(dir, tag + ".exe");
  try {
    fs.writeFileSync(src, source);
    const c = spawnSync("g++", [`-std=${std}`, "-O0", ...extraFlags, src, ...binmodeObject(dir), "-o", exe], { encoding: "utf8" });
    if (c.status !== 0) return { ok: false, log: c.stderr };
    const r = spawnSync(exe, [], { input: stdin, encoding: "utf8", timeout: 20000 });
    return { ok: true, stdout: r.stdout || "", status: r.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
