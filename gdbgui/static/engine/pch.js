// @ts-check
// Persistent precompiled-header cache (plan §6 L1).
//
//  * Key: sha256 over a canonical JSON of everything the PCH depends on: C++ standard, the exact
//    list of the program's system #include lines, the sha256 of vg.h, of the whole headers.tar
//    (vgcompat.h, bits/stdc++.h, pb_ds...), of clang.wasm and of sysroot.tar (asset hashes come from
//    the integrity-checked manifest, never from Content-Length), plus the PCH flag set version.
//  * Every entry stores the sha256 of its bytes; get() recomputes it and drops the entry on mismatch
//    (a corrupted or tampered IndexedDB entry is rebuilt, never used).
//  * LRU with caps on entry count and total bytes (default 6 entries / 120 MB; one PCH is ~14-21 MB).
//  * Defence in depth: the consumer does NOT pass -fno-validate-pch. The PCH is built with
//    -fno-pch-timestamp and used with -fpch-validate-input-files-content and
//    -fmodules-validate-system-headers, so clang itself re-checks every input header by content and
//    rejects language-option mismatches (measured: with -fno-validate-pch a -std mismatch is
//    silently accepted; with validation it is a hard error).
import { sha256Hex } from "./sha256.js";

/** Bump when the PCH build/consume flags change. */
export const PCH_FLAGS_VERSION = "pch-v1:-fno-pch-timestamp;content+system-validate";

/**
 * @param {{ std: string, includes: string[], vgSha256: string, headersSha256: string, clangSha256: string, sysrootSha256: string }} k
 */
export async function pchKey(k) {
  for (const f of ["std", "vgSha256", "headersSha256", "clangSha256", "sysrootSha256"]) {
    if (typeof /** @type {any} */ (k)[f] !== "string" || !/** @type {any} */ (k)[f]) throw new Error("pchKey: missing " + f);
  }
  const canon = JSON.stringify([PCH_FLAGS_VERSION, k.std, k.includes, k.vgSha256, k.headersSha256, k.clangSha256, k.sysrootSha256]);
  return sha256Hex(canon);
}

/**
 * Storage adapter interface (all async):
 *   getMeta(key) -> {sha256, size, lastUsed} | undefined
 *   getBytes(key) -> Uint8Array | undefined
 *   put(key, meta, bytes)
 *   setMeta(key, meta)
 *   delete(key)
 *   listMeta() -> Array<[key, meta]>
 * @typedef {{ sha256: string, size: number, lastUsed: number }} PchMeta
 */

/** In-memory store (Node tests, private windows without IndexedDB). */
export function createMemoryStore() {
  /** @type {Map<string, { meta: PchMeta, bytes: Uint8Array }>} */
  const m = new Map();
  return {
    async getMeta(/** @type {string} */ k) { const e = m.get(k); return e && { ...e.meta }; },
    async getBytes(/** @type {string} */ k) { const e = m.get(k); return e && e.bytes; },
    async put(/** @type {string} */ k, /** @type {PchMeta} */ meta, /** @type {Uint8Array} */ bytes) { m.set(k, { meta: { ...meta }, bytes }); },
    async setMeta(/** @type {string} */ k, /** @type {PchMeta} */ meta) { const e = m.get(k); if (e) e.meta = { ...meta }; },
    async delete(/** @type {string} */ k) { m.delete(k); },
    async listMeta() { return [...m].map(([k, e]) => /** @type {[string, PchMeta]} */ ([k, { ...e.meta }])); },
    /** test hook */ _raw: m,
  };
}

/**
 * IndexedDB store: object store "meta" (small records, scanned for LRU) and "bytes" (the PCH).
 * @param {string} [dbName]
 */
export function createIdbStore(dbName = "vgdb-pch-v2") {
  /** @type {Promise<IDBDatabase> | null} */
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("meta"); r.result.createObjectStore("bytes"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  /** @param {"meta" | "bytes"} store @param {IDBTransactionMode} mode @param {(s: IDBObjectStore) => IDBRequest | void} fn */
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    getMeta: (/** @type {string} */ k) => tx("meta", "readonly", (s) => s.get(k)),
    getBytes: (/** @type {string} */ k) => tx("bytes", "readonly", (s) => s.get(k)),
    async put(/** @type {string} */ k, /** @type {PchMeta} */ meta, /** @type {Uint8Array} */ bytes) {
      await tx("bytes", "readwrite", (s) => { s.put(bytes, k); });
      await tx("meta", "readwrite", (s) => { s.put(meta, k); });
    },
    setMeta: (/** @type {string} */ k, /** @type {PchMeta} */ meta) => tx("meta", "readwrite", (s) => { s.put(meta, k); }),
    async delete(/** @type {string} */ k) {
      await tx("meta", "readwrite", (s) => { s.delete(k); });
      await tx("bytes", "readwrite", (s) => { s.delete(k); });
    },
    async listMeta() {
      const db = await open();
      return new Promise((res, rej) => {
        /** @type {Array<[string, PchMeta]>} */
        const out = [];
        const t = db.transaction("meta", "readonly");
        const cur = t.objectStore("meta").openCursor();
        cur.onsuccess = () => { const c = cur.result; if (c) { out.push([String(c.key), c.value]); c.continue(); } };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
      });
    },
  };
}

export class PchCache {
  /**
   * @param {{ store: ReturnType<typeof createMemoryStore> | ReturnType<typeof createIdbStore>, maxEntries?: number, maxBytes?: number, now?: () => number }} o
   */
  constructor({ store, maxEntries = 6, maxBytes = 120e6, now = () => Date.now() }) {
    this.store = store;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.stats = { hits: 0, misses: 0, corrupt: 0, evicted: 0, errors: 0 };
  }

  /** @param {string} key @returns {Promise<Uint8Array | null>} */
  async get(key) {
    try {
      const meta = await this.store.getMeta(key);
      if (!meta) { this.stats.misses++; return null; }
      const bytes = await this.store.getBytes(key);
      const ok = bytes instanceof Uint8Array && bytes.length === meta.size && (await sha256Hex(bytes)) === meta.sha256;
      if (!ok) { this.stats.corrupt++; await this.store.delete(key); return null; }
      await this.store.setMeta(key, { ...meta, lastUsed: this.now() });
      this.stats.hits++;
      return bytes;
    } catch {
      this.stats.errors++;   // storage unavailable (private mode, quota...): behave as a miss
      return null;
    }
  }

  /** @param {string} key @param {Uint8Array} bytes */
  async put(key, bytes) {
    if (bytes.length > this.maxBytes) return false;
    try {
      const meta = { sha256: await sha256Hex(bytes), size: bytes.length, lastUsed: this.now() };
      await this.store.put(key, meta, bytes);
      await this.evict(key);
      return true;
    } catch {
      this.stats.errors++;
      return false;
    }
  }

  /** Drop least-recently-used entries until both caps hold (never the entry just written). @param {string} keep */
  async evict(keep) {
    const all = (await this.store.listMeta()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let count = all.length, bytes = all.reduce((s, [, m]) => s + m.size, 0);
    for (const [k, m] of all) {
      if (count <= this.maxEntries && bytes <= this.maxBytes) break;
      if (k === keep) continue;
      await this.store.delete(k);
      count--; bytes -= m.size; this.stats.evicted++;
    }
  }
}
