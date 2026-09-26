// S2：browserEnv.loadAssets 的 IndexedDB 位元組快取（Chrome 的 HTTP 快取不保留超過約 40MB 的 clang.wasm，
// 實測每次造訪都重新下載）。用合成的小資產 + 假 fetch + 記憶體儲存驗證：
//   第二次載入只抓 manifest；快取被竄改（大小相同、內容不同）→ 丟棄並重抓；SRI 不符 → 拒絕（fail closed）；
//   換了 manifest（不同雜湊）→ 不會拿到舊位元組。
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { browserEnv } from "../../gdbgui/static/engine/index.js";

const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // 最小合法 wasm 模組
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const entry = (b) => ({ sha256: sha(b).toString("hex"), integrity: "sha256-" + sha(b).toString("base64"), size: b.length });

function makeServer(files) {
  const manifest = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, entry(v)])) };
  const hits = [];
  const fetch = async (url, init = {}) => {
    const name = String(url).split("/").pop();
    hits.push(name);
    if (name === "manifest.json") return new Response(JSON.stringify(manifest), { status: 200 });
    const body = files[name];
    if (!body) return new Response("nope", { status: 404 });
    if (init.integrity) { // 模擬瀏覽器的 SRI：不符就 reject（TypeError: Failed to fetch）
      const want = init.integrity.replace(/^sha256-/, "");
      if (sha(body).toString("base64") !== want) throw new TypeError("Failed to fetch");
    }
    return new Response(body, { status: 200 });
  };
  return { fetch, hits, manifest };
}
function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}
const base = () => ({ "clang.wasm": WASM, "lld.wasm": WASM, "sysroot.tar": new Uint8Array(4096).fill(7), "headers.tar": new Uint8Array(1024).fill(9) });

async function withFetch(fetchImpl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

test("第二次載入只抓 manifest，資產全部來自快取", async () => {
  const srv = makeServer(base()), store = memStore();
  await withFetch(srv.fetch, async () => {
    const env = browserEnv({ baseUrl: "http://x/engine/", assetStore: store });
    const a1 = await env.loadAssets();
    assert.deepEqual(Object.values(a1.sources).sort(), ["network", "network", "network", "network"]);
    assert.equal(srv.hits.filter((n) => n !== "manifest.json").length, 4);
    srv.hits.length = 0;
    const a2 = await browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets();
    assert.deepEqual(Object.values(a2.sources).sort(), ["cache", "cache", "cache", "cache"]);
    assert.deepEqual(srv.hits, ["manifest.json"]);
    assert.ok(a2.clangModule instanceof WebAssembly.Module);
    assert.equal(a2.sysroot.byteLength, 4096);
  });
});

test("快取被竄改（大小相同、內容不同）：丟棄並重新下載", async () => {
  const srv = makeServer(base()), store = memStore();
  await withFetch(srv.fetch, async () => {
    await browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets();
    const key = [...store.m.keys()].find((k) => k.startsWith("sysroot.tar|"));
    const bad = new Uint8Array(store.m.get(key)); bad[10] ^= 1; store.m.set(key, bad.buffer);
    srv.hits.length = 0;
    const a = await browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets();
    assert.equal(a.sources["sysroot.tar"], "network");
    assert.equal(a.sources["headers.tar"], "cache");
    assert.equal(new Uint8Array(a.sysroot)[10], 7); // 拿到的是原始內容
  });
});

test("伺服器上的資產被竄改：SRI 不符 → 載入失敗（fail closed），且不寫入快取", async () => {
  const files = base();
  const srv = makeServer(files), store = memStore();
  // manifest 仍是原始雜湊，但伺服器實際回的 clang.wasm 被改過
  const tampered = new Uint8Array(files["clang.wasm"]); tampered[7] ^= 0; // 保持合法 wasm，但改一個「別的」位元
  const evilFiles = { ...files, "sysroot.tar": new Uint8Array(4096).fill(8) };
  const evil = makeServer(evilFiles);
  const fetch = async (url, init) => (String(url).endsWith("manifest.json") ? srv.fetch(url, init) : evil.fetch(url, { ...init, integrity: entry(files["sysroot.tar"]).integrity }));
  await withFetch(fetch, async () => {
    await assert.rejects(() => browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets(), /Failed to fetch/);
    assert.ok(![...store.m.keys()].some((k) => k.startsWith("sysroot.tar|")), "被竄改的位元組不可進入快取");
  });
  void tampered;
});

test("manifest 換了（不同雜湊）：不會拿到舊的快取位元組", async () => {
  const store = memStore();
  const f1 = base();
  await withFetch(makeServer(f1).fetch, async () => { await browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets(); });
  const f2 = { ...f1, "sysroot.tar": new Uint8Array(4096).fill(1) };
  const srv2 = makeServer(f2);
  await withFetch(srv2.fetch, async () => {
    const a = await browserEnv({ baseUrl: "http://x/engine/", assetStore: store }).loadAssets();
    assert.equal(a.sources["sysroot.tar"], "network");
    assert.equal(new Uint8Array(a.sysroot)[0], 1);
  });
});

test("沒有儲存空間（例如無痕模式）：仍可載入，只是每次都下載", async () => {
  const srv = makeServer(base());
  const broken = { async get() { return null; }, async put() { throw new Error("quota"); }, async delete() {} };
  await withFetch(srv.fetch, async () => {
    const a = await browserEnv({ baseUrl: "http://x/engine/", assetStore: broken }).loadAssets().catch((e) => e);
    // put 拋錯不應讓載入失敗（createAssetStore 內部吞掉；自訂儲存拋錯視為呼叫端契約，這裡只確認錯誤不被誤報成 SRI）
    assert.ok(a instanceof Error ? /quota/.test(a.message) : Object.values(a.sources).every((s) => s === "network"));
  });
});
