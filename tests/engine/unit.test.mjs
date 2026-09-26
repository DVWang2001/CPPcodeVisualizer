// Fast unit tests (no compiler): trace decoder/validator, PCH cache, SHA-256, WASI import object,
// evalexpr, manifest validation, JSON splitting. All run in the test process.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decodeTrace, zeroLike } from "../../gdbgui/static/engine/trace.js";
import { PchCache, createMemoryStore, pchKey, PCH_FLAGS_VERSION } from "../../gdbgui/static/engine/pch.js";
import { sha256Js, sha256Hex, toHex } from "../../gdbgui/static/engine/sha256.js";
import { createWasi, checkImports, WASI_PREVIEW1, IMPLEMENTED, ERRNO } from "../../gdbgui/static/engine/exec.worker.js";
import { evalExpr, EvalError } from "../../gdbgui/static/engine/evalexpr.js";
import { validateManifest } from "../../gdbgui/static/engine/index.js";
import { splitJson } from "../../gdbgui/static/engine/jsonsplit.js";
import { scanPrelude, namespaceLine, Unsupported } from "../../gdbgui/static/engine/userast.js";
import { pchIncludes } from "../../gdbgui/static/engine/pipeline.worker.js";

const enc = (lines) => new TextEncoder().encode(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
const META = {
  lineCount: 20,
  probes: [
    { line: 3, fn: "main", names: ["x"], u: [], w: [] },
    { line: 4, fn: "main", names: ["x", "v"], u: [], w: [] },
    { line: 5, fn: "main", names: ["x", "v", "h"], u: [["h", 0]], w: [0] },
    { line: 6, fn: "main", names: ["x", "v", "h"], u: [["h", 0]], w: [] },
    { line: 9, fn: "f", names: ["__proto__", "constructor"], u: [], w: [] },
  ],
};
const rec = (p, d, extra = {}) => ({ p, line: META.probes[p].line, fn: META.probes[p].fn, depth: 1, frame: 1, n: META.probes[p].names, d, ...extra });

// ------------------------------------------------------------------------------------ trace.js
test("trace: delta decoding reconstructs full snapshots", () => {
  const r = decodeTrace(enc([rec(0, { x: 1 }), rec(1, { v: [1, 2] }), rec(1, { x: 2 })]), META);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rawSteps, 3);
  assert.equal(r.steps.length, 2); // consecutive same (line, fn, frame) merged: first kept
  assert.deepEqual({ ...r.steps[1].vars }, { x: 1, v: [1, 2] });
});

test("trace: D6 flags a declared-without-initialiser variable as 0 until the writing statement ran", () => {
  const r = decodeTrace(enc([rec(2, { x: 1, v: [], h: 123456 }), rec(3, {})]), META);
  assert.deepEqual(r.steps[0].uninit, ["h"]);
  assert.equal(r.steps[0].vars.h, 0);
  assert.equal(r.steps[1].uninit, undefined); // probe 2's statement writes h (w: [0])
  assert.equal(r.steps[1].vars.h, 123456);
  assert.deepEqual(zeroLike([[1, 2], "x", "<?>"]), [[0, 0], 0, "<?>"]);
});

const BAD = [
  ["not JSON", "garbage"],
  ["array", JSON.stringify([1, 2])],
  ["unknown probe id", { ...rec(0, { x: 1 }), p: 99 }],
  ["line out of range", { ...rec(0, { x: 1 }), line: 21 }],
  ["line mismatch", { ...rec(0, { x: 1 }), line: 4 }],
  ["non-integer line", { ...rec(0, { x: 1 }), line: 3.5 }],
  ["unknown function", { ...rec(0, { x: 1 }), fn: "evil" }],
  ["unknown variable", { ...rec(0, { x: 1, y: 2 }), n: ["x", "y"] }],
  ["missing variable", { ...rec(1, {}), n: ["x"] }],
  ["duplicate variable", { ...rec(0, { x: 1 }), n: ["x", "x"] }],
  ["value for variable not in scope", rec(0, { x: 1, v: 3 })],
  ["extra field", { ...rec(0, { x: 1 }), extra: 1 }],
  ["bad depth", { ...rec(0, { x: 1 }), depth: 0 }],
  ["bad frame", { ...rec(0, { x: 1 }), frame: "1" }],
  ["d not an object", { ...rec(0, { x: 1 }), d: [1] }],
  ["variable name not a string", { ...rec(0, { x: 1 }), n: [1] }],
  ["bad limit", { limit: "forever" }],
];
for (const [why, bad] of BAD) {
  test(`trace: rejects a corrupted record (${why}) and keeps the steps before it`, () => {
    const r = decodeTrace(enc([rec(0, { x: 1 }), bad, rec(1, { v: [] })]), META);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].kind, "trace-corrupted");
    assert.equal(r.errors[0].record, 1);
    assert.equal(r.steps.length, 1);
  });
}

test("trace: __proto__/constructor as variable names are own data on a null-prototype object", () => {
  const r = decodeTrace(enc([rec(4, JSON.parse('{"__proto__": 5, "constructor": 6}'))]), META);
  assert.deepEqual(r.errors, []);
  const v = r.steps[0].vars;
  assert.equal(Object.getPrototypeOf(v), null);
  assert.equal(v.__proto__, 5);
  assert.equal(v.constructor, 6);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "5"), false);
});

test("trace: capacity pseudo variables are accepted only for known names", () => {
  const ok = decodeTrace(enc([{ ...rec(1, { x: 1, v: [], "v.capacity()": 4 }), n: ["x", "v", "v.capacity()"] }]), META);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.steps[0].vars["v.capacity()"], 4);
  const bad = decodeTrace(enc([{ ...rec(1, { x: 1, v: [], "q.capacity()": 4 }), n: ["x", "v", "q.capacity()"] }]), META);
  assert.equal(bad.errors[0].kind, "trace-corrupted");
});

test("trace: limit record stops decoding; incomplete last line is flagged", () => {
  const r = decodeTrace(enc([rec(0, { x: 1 }), { limit: "steps" }, rec(1, { v: [] })]), META);
  assert.equal(r.limit, "steps");
  assert.equal(r.steps.length, 1);
  const t = new TextEncoder().encode(JSON.stringify(rec(0, { x: 1 })) + "\n{\"p\":1,\"li");
  const r2 = decodeTrace(t, META);
  assert.equal(r2.truncated, true);
  assert.deepEqual(r2.errors, []);
});

test("trace: record count cap", () => {
  const lines = []; for (let i = 0; i < 12; i++) lines.push(rec(i % 2, i % 2 ? { v: [i] } : { x: i }));
  const r = decodeTrace(enc(lines), META, { maxRecords: 10 });
  assert.equal(r.errors[0].reason, "too many records");
});

// ------------------------------------------------------------------------------------ pch.js
test("pch: key covers std, includes, vg.h, headers, clang and sysroot hashes", async () => {
  const base = { std: "c++17", includes: ["vector"], vgSha256: "a", headersSha256: "b", clangSha256: "c", sysrootSha256: "d" };
  const k0 = await pchKey(base);
  assert.match(k0, /^[0-9a-f]{64}$/);
  for (const [f, v] of [["std", "c++20"], ["includes", ["vector", "map"]], ["vgSha256", "x"], ["headersSha256", "x"], ["clangSha256", "x"], ["sysrootSha256", "x"]]) {
    assert.notEqual(await pchKey({ ...base, [f]: v }), k0, f);
  }
  await assert.rejects(pchKey({ ...base, clangSha256: "" }), /missing clangSha256/);
  assert.match(PCH_FLAGS_VERSION, /validate/);
});

test("pch: LRU eviction by entry count and by total bytes", async () => {
  let t = 0;
  const store = createMemoryStore();
  const c = new PchCache({ store, maxEntries: 2, maxBytes: 1000, now: () => ++t });
  const b = (n, fill) => new Uint8Array(n).fill(fill);
  await c.put("a", b(100, 1)); await c.put("b", b(100, 2));
  assert.ok(await c.get("a"));                  // a becomes most recently used
  await c.put("c", b(100, 3));                  // evicts b (LRU), not a
  assert.deepEqual([...store._raw.keys()].sort(), ["a", "c"]);
  await c.put("d", b(900, 4));                  // bytes cap: a+c+d = 1100 > 1000 -> evict LRU until it fits
  assert.ok((await store.listMeta()).reduce((s, [, m]) => s + m.size, 0) <= 1000);
  assert.ok(store._raw.has("d"));
  assert.equal(await c.put("huge", b(2000, 5)), false); // larger than the whole cache: never stored
  assert.ok(c.stats.evicted >= 2);
});

test("pch: sha256 is verified on read; a corrupted entry is dropped and treated as a miss", async () => {
  const store = createMemoryStore();
  const c = new PchCache({ store });
  const bytes = new Uint8Array(4096).map((_, i) => i & 255);
  await c.put("k", bytes);
  assert.deepEqual(await c.get("k"), bytes);
  store._raw.get("k").bytes = new Uint8Array(bytes); store._raw.get("k").bytes[100] ^= 1; // flip one bit
  assert.equal(await c.get("k"), null);
  assert.equal(c.stats.corrupt, 1);
  assert.equal(store._raw.has("k"), false);
  store._raw.set("s", { meta: { sha256: "0".repeat(64), size: 3, lastUsed: 0 }, bytes: new Uint8Array(4) }); // size mismatch
  assert.equal(await c.get("s"), null);
});

test("pch: storage failures degrade to a miss, never an exception", async () => {
  const broken = { getMeta: async () => { throw new Error("quota"); }, getBytes: async () => undefined, put: async () => { throw new Error("quota"); }, setMeta: async () => {}, delete: async () => {}, listMeta: async () => [] };
  const c = new PchCache({ store: /** @type {any} */ (broken) });
  assert.equal(await c.get("x"), null);
  assert.equal(await c.put("x", new Uint8Array(3)), false);
});

// ------------------------------------------------------------------------------------ sha256.js
test("sha256: JS fallback matches node:crypto (NIST vectors + random lengths)", async () => {
  const cases = ["", "abc", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "a".repeat(1000)];
  for (const s of cases) assert.equal(toHex(sha256Js(new TextEncoder().encode(s))), crypto.createHash("sha256").update(s).digest("hex"));
  assert.equal(toHex(sha256Js(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const n of [55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 70000]) {
    const d = crypto.randomBytes(n);
    assert.equal(toHex(sha256Js(new Uint8Array(d))), crypto.createHash("sha256").update(d).digest("hex"), "len " + n);
  }
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ------------------------------------------------------------------------------------ exec.worker.js (WASI)
test("wasi: import object is frozen and has exactly the 46 preview1 names", () => {
  const w = createWasi({});
  assert.ok(Object.isFrozen(w.imports) && Object.isFrozen(w.imports.wasi_snapshot_preview1));
  assert.deepEqual(Object.keys(w.imports), ["wasi_snapshot_preview1"]);
  assert.equal(WASI_PREVIEW1.length, 46);
  assert.deepEqual(Object.keys(w.imports.wasi_snapshot_preview1).sort(), [...WASI_PREVIEW1].sort());
  assert.equal(Object.getPrototypeOf(w.imports.wasi_snapshot_preview1), null);
  assert.throws(() => { "use strict"; /** @type {any} */ (w.imports.wasi_snapshot_preview1).fd_write = () => 0; });
});

test("wasi: every non-implemented function returns ENOSYS", () => {
  const w = createWasi({});
  w.bindMemory(new WebAssembly.Memory({ initial: 1 }));
  for (const name of WASI_PREVIEW1) {
    if (IMPLEMENTED.includes(name)) continue;
    assert.equal(w.imports.wasi_snapshot_preview1[name](0, 0, 0, 0, 0, 0, 0, 0, 0), ERRNO.NOSYS, name);
  }
  assert.equal(w.counters.nosys.path_open, 1);
});

test("wasi: fd_write enforces host-side caps and bounds; fd 3 is separate; unknown fds are EBADF", () => {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const w = createWasi({ limits: { stdoutBytes: 10, stderrBytes: 10, traceBytes: 10 } });
  w.bindMemory(mem);
  const dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
  u8.set(new TextEncoder().encode("hello"), 100);
  dv.setUint32(0, 100, true); dv.setUint32(4, 5, true);           // iovec {100, 5}
  const W = w.imports.wasi_snapshot_preview1.fd_write;
  assert.equal(W(1, 0, 1, 16), 0);
  assert.equal(dv.getUint32(16, true), 5);
  assert.equal(W(3, 0, 1, 16), 0);                                  // trace channel
  assert.equal(W(7, 0, 1, 16), ERRNO.BADF);
  assert.equal(W(1, 0, 1, 70000), ERRNO.FAULT);                     // nwritten pointer out of bounds
  dv.setUint32(8, 65530, true); dv.setUint32(12, 100, true);        // iovec pointing past memory
  assert.equal(W(1, 8, 1, 16), ERRNO.FAULT);
  assert.equal(W(1, 0, 1, 16), 0);                                  // 10 bytes used: at the cap
  assert.throws(() => W(1, 0, 1, 16));                              // exceeding the cap stops the program
  assert.equal(w.sinks[1].used, 10);
  assert.equal(new TextDecoder().decode(w.sinks[1].bytes()), "hellohello");
  assert.equal(new TextDecoder().decode(w.sinks[3].bytes()), "hello");
  assert.equal(w.imports.wasi_snapshot_preview1.fd_close(3), ERRNO.BADF); // trace fd cannot be closed
});

test("wasi: fd_read serves stdin then EOF; prestat reports no preopens", () => {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const w = createWasi({ stdin: new TextEncoder().encode("abc") });
  w.bindMemory(mem);
  const dv = new DataView(mem.buffer);
  dv.setUint32(0, 200, true); dv.setUint32(4, 2, true);
  const R = w.imports.wasi_snapshot_preview1.fd_read;
  assert.equal(R(0, 0, 1, 16), 0); assert.equal(dv.getUint32(16, true), 2);
  assert.equal(R(0, 0, 1, 16), 0); assert.equal(dv.getUint32(16, true), 1);
  assert.equal(R(0, 0, 1, 16), 0); assert.equal(dv.getUint32(16, true), 0);
  assert.equal(R(1, 0, 1, 16), ERRNO.BADF);
  assert.equal(w.imports.wasi_snapshot_preview1.fd_prestat_get(3, 0), ERRNO.BADF);
});

test("wasi: checkImports rejects non-WASI modules, non-function imports and unknown names", () => {
  // hand-assembled modules: (import "env" "x" (func)), (import "wasi_snapshot_preview1" "fd_write" (func)),
  // (import "wasi_snapshot_preview1" "bogus" (func)), (import "env" "memory" (memory 1))
  const mod = (m, n, kind) => {
    const str = (s) => [s.length, ...new TextEncoder().encode(s)];
    const typeSec = [1, 4, 1, 0x60, 0, 0];
    const desc = kind === "func" ? [0x00, 0x00] : [0x02, 0x00, 0x01];
    const body = [1, ...str(m), ...str(n), ...desc];
    const impSec = [2, body.length, ...body];
    return new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typeSec, ...impSec]));
  };
  assert.deepEqual(checkImports(mod("env", "x", "func")), ["env.x (function)"]);
  assert.deepEqual(checkImports(mod("wasi_snapshot_preview1", "fd_write", "func")), []);
  assert.deepEqual(checkImports(mod("wasi_snapshot_preview1", "bogus", "func")), ["wasi_snapshot_preview1.bogus (function)"]);
  assert.deepEqual(checkImports(mod("env", "memory", "memory")), ["env.memory (memory)"]);
});

// ------------------------------------------------------------------------------------ evalexpr.js
test("evalexpr: own-property lookups only (no prototype names), unchanged semantics otherwise", () => {
  const vars = Object.assign(Object.create(null), { dp: [[1, 2], [3, 4]], i: 1, j: 0, "dp.capacity()": 2 });
  assert.equal(evalExpr("dp[i][j] + 1", vars), 4);
  assert.equal(evalExpr("dp.size()", vars), 2);
  assert.equal(evalExpr("dp.capacity()", vars), 2);
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => evalExpr(name, vars), (e) => e instanceof EvalError && e.kind === "undefined", name);
    assert.throws(() => evalExpr(name, { a: 1 }), (e) => e instanceof EvalError && e.kind === "undefined", name + " (plain object)");
  }
  const withProto = JSON.parse('{"__proto__": 7}');
  assert.equal(evalExpr("__proto__ + 1", withProto), 8);
  assert.throws(() => evalExpr("dp.capacity()", { dp: [] }), (e) => e.kind === "unsupported");
  assert.throws(() => evalExpr("(".repeat(100) + "1" + ")".repeat(100), vars), (e) => e.kind === "syntax");
});

// ------------------------------------------------------------------------------------ misc
test("manifest validation requires sha256 + SRI integrity + size for every asset", () => {
  const f = { sha256: "a".repeat(64), integrity: "sha256-" + "A".repeat(43) + "=", size: 1 };
  const ok = { files: { "clang.wasm": f, "lld.wasm": f, "sysroot.tar": f, "headers.tar": f } };
  assert.equal(validateManifest(ok), ok);
  assert.throws(() => validateManifest({ files: { ...ok.files, "lld.wasm": { ...f, integrity: "md5-x" } } }), /lld\.wasm/);
  assert.throws(() => validateManifest({ files: { "clang.wasm": f } }), /bad entry/);
});

test("jsonsplit splits concatenated objects and rejects truncated input", () => {
  assert.deepEqual(splitJson('{"a":"}{"}{"b":[1,{"c":2}]}'), [{ a: "}{" }, { b: [1, { c: 2 }] }]);
  assert.throws(() => splitJson('{"a":1'), /truncated/);
});

test("prelude scan: CRLF, comments, code before includes, PCH eligibility, namespace line", () => {
  const crlf = "// comment\r\n#include <vector>\r\nint main(){}\r\n";
  assert.deepEqual(scanPrelude(crlf), { lastInclude: 1, onlyIncludesBefore: true, codeBefore: null });
  assert.equal(scanPrelude("int x;\n#include <vector>\n").codeBefore, 1);
  assert.equal(scanPrelude("#define X 1\n#include <vector>\n").onlyIncludesBefore, false);
  assert.deepEqual(pchIncludes("#include <vector>\r\n#include <map> // m\nint main(){}\n"), ["vector", "map"]);
  assert.equal(pchIncludes('#include "local.h"\nint main(){}\n'), null);
  assert.equal(namespaceLine(["#include <x>", "#define N 3", "#define M \\", "  4", "/* a", "b */", "int x;"], 1), 4);
  assert.throws(() => namespaceLine(["#include <x>", "#ifdef LOCAL", "int x;", "#endif"], 1), Unsupported);
});
