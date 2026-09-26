// The engine's own minimal WASI (exec.worker.js) vs the pinned reference implementation
// @bjorn3/browser_wasi_shim 0.4.2 (used here only as a test oracle; it is not loaded at runtime):
// the same compiled programs must produce the same stdout and exit code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadNodeEngine } from "./node_driver.mjs";
import { execute } from "../../gdbgui/static/engine/exec.worker.js";
import { WASI, File, OpenFile, ConsoleStdout } from "../../gdbgui/static/engine/node_modules/@bjorn3/browser_wasi_shim/dist/index.js";

let eng;
before(async () => { eng = await loadNodeEngine(); });
after(() => eng && eng.dispose());

async function viaShim(module, stdin) {
  let out = "";
  const fds = [new OpenFile(new File(new TextEncoder().encode(stdin))), new ConsoleStdout((d) => { out += new TextDecoder().decode(d); }), new ConsoleStdout(() => {}), new ConsoleStdout(() => {})];
  const wasi = new WASI(["main"], [], fds);
  const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  let code;
  try { code = wasi.start(inst); } catch (e) { code = "trap"; }
  return { out, code };
}

const PROGRAMS = [
  ["iostream + cin + getline + sort", `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n; vector<int> v(n); for (auto& x : v) cin >> x;
    sort(v.begin(), v.end()); string rest; getline(cin, rest); getline(cin, rest);
    for (int x : v) cout << x << ' '; cout << "| " << rest << "\\n";
    printf("%.3f %s\\n", 3.14159, "ok"); return v[0];
}
`, "5\n5 3 9 1 7\nhello world\n"],
  ["exit code and EOF handling", `#include <iostream>
int main() { long long s = 0, x; while (std::cin >> x) s += x; std::cout << s << std::endl; return 3; }
`, "1 2 3 4\n"],
  ["random_device, chrono and time()", `#include <bits/stdc++.h>
int main() { std::random_device rd; std::mt19937 g(42); auto t0 = std::chrono::steady_clock::now(); (void)rd; (void)time(nullptr);
  std::cout << g() % 100 << " " << (std::chrono::steady_clock::now() >= t0) << "\\n"; }
`, ""],
];

for (const [name, src, stdin] of PROGRAMS) {
  test(`WASI oracle: ${name}`, async () => {
    const r = await eng.runProgram(src, stdin, { instrument: false, returnWasm: true });
    assert.equal(r.ok, true, JSON.stringify(r.errors).slice(0, 500));
    const mod = await WebAssembly.compile(r.wasm);
    const mine = await execute(mod, { stdin });
    const ref = await viaShim(mod, stdin);
    const mineOut = new TextDecoder().decode(mine.stdout);
    assert.equal(mineOut, ref.out);
    assert.equal(mine.exit.code, ref.code);
    assert.equal(mineOut, r.stdout);
  });
}
