// PCH decision (requirement 4): `-fno-validate-pch` is REMOVED. The PCH is built with
// -fno-pch-timestamp and consumed with -fpch-validate-input-files-content +
// -fmodules-validate-system-headers, so clang re-validates every input by content and rejects
// language-option mismatches. This test shows why: with -fno-validate-pch a -std mismatch and a
// modified vg.h are silently accepted; with our flags both are hard errors. It also checks the
// engine really uses the PCH (built once, then served from the in-worker cache).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ASSETS, readVerified, loadNodeEngine } from "./node_driver.mjs";
import { Driver } from "../../gdbgui/static/engine/driver.js";

const USE = ["-Xclang", "-include-pch", "-Xclang", "/vg.pch", "-fpch-validate-input-files-content", "-Xclang", "-fmodules-validate-system-headers"];
let d, pch, src, vgH;
before(async () => {
  const m = JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8"));
  d = new Driver({
    clangModule: await WebAssembly.compile(readVerified("clang.wasm", m)), lldModule: await WebAssembly.compile(readVerified("lld.wasm", m)),
    sysroot: readVerified("sysroot.tar", m), headers: readVerified("headers.tar", m),
  });
  vgH = d.vgH;
  src = "#include <vg.h>\n#include <vector>\n";
  pch = await d.buildPch(src, ["-std=c++17", "-fno-exceptions", "-O0"]);
});

// emscripten's Node glue sets process.exitCode to clang's exit status (1 for the intentionally
// failing compiles below) when clang runs on the test's main thread; the test runner sets its own
// exit code for real failures.
after(() => { process.exitCode = 0; });

const prog = "#include <vector>\nint main() { std::vector<int> v{1}; return v[0] - 1; }\n";
const check = (std, flags, files) => d.syntaxCheck(prog, { flags: [`-std=${std}`, "-fno-exceptions", "-O0", ...flags], files });

test("PCH with content validation: identical inputs are accepted", async () => {
  const r = await check("c++17", USE, { "vg.pch": pch, "pch_src.h": src });
  assert.equal(r.code, 0, r.err);
});

test("PCH with content validation: -std mismatch is rejected (it is silently accepted with -fno-validate-pch)", async () => {
  const ours = await check("c++20", USE, { "vg.pch": pch, "pch_src.h": src });
  assert.notEqual(ours.code, 0);
  assert.match(ours.err, /C\+\+20 was disabled in AST file/);
  const unsafe = await check("c++20", ["-Xclang", "-include-pch", "-Xclang", "/vg.pch", "-Xclang", "-fno-validate-pch"], { "vg.pch": pch, "pch_src.h": src });
  assert.equal(unsafe.code, 0, "documented reason for removing -fno-validate-pch");
});

test("PCH with content validation: a modified system header (vg.h) or pch_src.h is rejected", async () => {
  const vg = await check("c++17", USE, { "vg.pch": pch, "pch_src.h": src, "include/vg.h": vgH + "\n// changed\n" });
  assert.notEqual(vg.code, 0);
  assert.match(vg.err, /vg\.h' has been modified since the precompiled header/);
  const ps = await check("c++17", USE, { "vg.pch": pch, "pch_src.h": src + "\n" });
  assert.notEqual(ps.code, 0);
  assert.match(ps.err, /pch_src\.h' has been modified/);
});

test("engine: PCH built once per include set, then reused; outputs identical with and without PCH", async () => {
  const eng = await loadNodeEngine();
  try {
    const p = "#include <iostream>\n#include <vector>\nint main() {\n    std::vector<int> v = {1, 2, 3};\n    int s = 0;\n    for (int x : v) s += x;\n    std::cout << s << \"\\n\";\n    return 0;\n}\n";
    const a = await eng.runProgram(p, "");
    const b = await eng.runProgram(p, "");
    const c = await eng.runProgram(p, "", { pch: false });
    assert.equal(a.pchFrom, "built");
    assert.equal(b.pchFrom, "memory");
    assert.equal(c.pchFrom, null);
    for (const r of [a, b, c]) { assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.equal(r.stdout, "6\n"); }
    assert.deepEqual(a.steps, c.steps);
  } finally { eng.dispose(); }
});
