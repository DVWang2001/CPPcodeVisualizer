// Supply chain & integrity (plan §6 H2 as far as S1 goes; requirement 5), PCH IndexedDB adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, ASSETS, readVerified } from "./node_driver.mjs";
import { browserEnv } from "../../gdbgui/static/engine/index.js";
import { headerEntries } from "../../gdbgui/static/engine/scripts/build-assets.mjs";
import { parseTar } from "../../gdbgui/static/engine/driver.js";
import { PchCache, createIdbStore } from "../../gdbgui/static/engine/pch.js";
import { makeFakeIndexedDB } from "./fake_indexeddb.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const manifest = readJson(path.join(ASSETS, "manifest.json"));

test("dependencies are pinned to exact versions with lockfile integrity", () => {
  const pkg = readJson(path.join(ENGINE, "package.json"));
  const lock = readJson(path.join(ENGINE, "package-lock.json"));
  for (const [name, ver] of Object.entries(pkg.dependencies)) {
    assert.match(ver, /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
    const entry = lock.packages["node_modules/" + name];
    assert.equal(entry.version, ver);
    assert.match(entry.integrity, /^sha512-/);
    assert.equal(readJson(path.join(ENGINE, "node_modules", name, "package.json")).version, ver, "installed version");
  }
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@bjorn3/browser_wasi_shim", "browsercc"]);
});

test("vendored emscripten glue is byte-identical to the pinned package and listed in SHA256SUMS", () => {
  const sums = fs.readFileSync(path.join(ENGINE, "vendor", "browsercc", "SHA256SUMS"), "utf8").trim().split("\n")
    .map((l) => l.trim().split(/\s+\*?/)).map(([h, f]) => [f.replace(/^\*/, ""), h]);
  assert.deepEqual(sums.map(([f]) => f).sort(), ["LICENSE", "clang.js", "lld.js"]);
  for (const [file, h] of sums) {
    const vend = fs.readFileSync(path.join(ENGINE, "vendor", "browsercc", file));
    assert.equal(sha(vend), h, file);
    const src = file === "LICENSE" ? path.join(ENGINE, "node_modules", "browsercc", "LICENSE") : path.join(ENGINE, "node_modules", "browsercc", "dist", file);
    assert.equal(sha(fs.readFileSync(src)), h, file + " differs from node_modules");
  }
});

test("assets/manifest.json matches every asset (sha256, SRI integrity, size); binaries equal the pinned package", () => {
  for (const [name, m] of Object.entries(manifest.files)) {
    const b = fs.readFileSync(path.join(ASSETS, name));
    assert.equal(b.length, m.size, name);
    assert.equal(sha(b), m.sha256, name);
    assert.equal(m.integrity, "sha256-" + crypto.createHash("sha256").update(b).digest("base64"), name);
    if (name !== "headers.tar") assert.equal(sha(fs.readFileSync(path.join(ENGINE, "node_modules", "browsercc", "dist", name))), m.sha256, name);
  }
});

test("headers.tar is reproducible from include/ + vg.h and contains the compat layer", () => {
  const entries = headerEntries();
  const tar = parseTar(fs.readFileSync(path.join(ASSETS, "headers.tar")));
  assert.deepEqual(tar.map((f) => f.name), entries.map(([n]) => n));
  for (let i = 0; i < tar.length; i++) assert.equal(sha(tar[i].content), sha(entries[i][1]), tar[i].name);
  const names = new Set(tar.map((f) => f.name));
  for (const n of ["include/vg.h", "include/vgcompat.h", "include/bits/stdc++.h", "include/bits/extc++.h", "include/ext/pb_ds/assoc_container.hpp"]) assert.ok(names.has(n), n);
});

test("Node loader fails closed on a single flipped byte", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-assets-"));
  try {
    const b = fs.readFileSync(path.join(ASSETS, "headers.tar"));
    b[1000] ^= 1;
    fs.writeFileSync(path.join(dir, "headers.tar"), b);
    assert.throws(() => readVerified("headers.tar", manifest, dir), /integrity check failed/);
    assert.ok(readVerified("headers.tar", manifest)); // the untouched original passes
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("browser loader: manifest fetched no-cache, every asset fetched with its SRI integrity; SRI failure fails closed", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const small = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // empty wasm module
  const mkResponse = (body, type) => new Response(body, { status: 200, headers: { "content-type": type } });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); calls.push({ u, opts });
    if (u.endsWith("manifest.json")) return mkResponse(JSON.stringify(manifest), "application/json");
    const name = u.split("/").pop();
    if (opts.integrity !== manifest.files[name].integrity) throw new TypeError("SRI mismatch (simulated)");
    return name.endsWith(".wasm") ? mkResponse(small, "application/wasm") : mkResponse(new Uint8Array(4), "application/x-tar");
  };
  try {
    const env = browserEnv({ baseUrl: "https://vgdb.example/static/engine/" });
    const a = await env.loadAssets();
    assert.ok(a.clangModule instanceof WebAssembly.Module);
    assert.equal(a.hashes.clang, manifest.files["clang.wasm"].sha256);
    const m = calls.find((c) => c.u.endsWith("manifest.json"));
    assert.equal(m.opts.cache, "no-cache");
    for (const n of ["clang.wasm", "lld.wasm", "sysroot.tar", "headers.tar"]) {
      const c = calls.find((x) => x.u === "https://vgdb.example/static/engine/assets/" + n);
      assert.equal(c.opts.integrity, manifest.files[n].integrity, n);
    }
    // tampered manifest entry (as if an asset changed): the SRI check rejects and loading fails
    const bad = structuredClone(manifest);
    bad.files["lld.wasm"].integrity = "sha256-" + "A".repeat(43) + "=";
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.endsWith("manifest.json")) return mkResponse(JSON.stringify(bad), "application/json");
      const name = u.split("/").pop();
      if (opts.integrity !== manifest.files[name].integrity) throw new TypeError("SRI mismatch (simulated)");
      return name.endsWith(".wasm") ? mkResponse(small, "application/wasm") : mkResponse(new Uint8Array(4), "application/x-tar");
    };
    await assert.rejects(env.loadAssets(), /SRI mismatch/);
  } finally { globalThis.fetch = realFetch; }
});

test("browser worker adapter uses static same-origin module-worker URLs (never blob:)", () => {
  const made = [];
  const realWorker = globalThis.Worker;
  globalThis.Worker = class { constructor(url, opts) { made.push({ url: String(url), opts }); } };
  try {
    const env = browserEnv({ baseUrl: "https://vgdb.example/static/engine/" });
    env.createWorker("pipeline"); env.createWorker("exec");
    assert.deepEqual(made.map((m) => m.url), ["https://vgdb.example/static/engine/pipeline.worker.js", "https://vgdb.example/static/engine/exec.worker.js"]);
    assert.ok(made.every((m) => m.opts.type === "module" && !m.url.startsWith("blob:")));
  } finally { globalThis.Worker = realWorker; }
});

test("PCH IndexedDB adapter (fake IndexedDB): round trip, LRU, corrupted bytes rejected", async () => {
  const realIdb = globalThis.indexedDB;
  globalThis.indexedDB = makeFakeIndexedDB();
  try {
    let t = 0;
    const store = createIdbStore("test-db");
    const c = new PchCache({ store, maxEntries: 2, now: () => ++t });
    const b = (n) => new Uint8Array(n).fill(n & 255);
    await c.put("a", b(10)); await c.put("b", b(20));
    assert.deepEqual(await c.get("a"), b(10));
    await c.put("c", b(30));
    assert.deepEqual((await store.listMeta()).map(([k]) => k).sort(), ["a", "c"]);
    globalThis.indexedDB._stores.get("test-db").bytes.set("a", b(11)); // corrupt the stored bytes
    assert.equal(await c.get("a"), null);
    assert.equal(await store.getMeta("a"), undefined);
  } finally { globalThis.indexedDB = realIdb; }
});
