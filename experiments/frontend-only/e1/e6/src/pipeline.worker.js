// 編譯管線 Worker：載入編譯器 → 插樁 → 編譯連結 → 在「執行 Worker」裡跑（可逾時終止）→ 解碼差量紀錄。
// 跟正式版的分工一樣：主執行緒完全不做重活，永遠不會被編譯器或學生程式卡住。
import { state, loadAll, compile, buildPch } from "./driver.js";
import { instrument } from "./instrument.js";

let vgH = null;
const now = () => performance.now();
const post = (m) => self.postMessage(m);

function runExec(module, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = now();
    const w = new Worker(new URL("./exec.worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => { w.terminate(); resolve({ killed: true, wallMs: now() - t0 }); }, timeoutMs);
    w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve({ ...e.data, wallMs: now() - t0 }); };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: String(e.message), wallMs: now() - t0 }); };
    w.postMessage({ module, stdin });
  });
}

// 差量解碼：state[(函式, 變數名)] = 最後一次輸出的值；每一步的 vars = 「n」列出的名字對應到 state。
function decode(errText) {
  const steps = [], other = [], st = new Map();
  let limit = false;
  for (const line of errText.split("\n")) {
    if (line.startsWith("\x01VGLIMIT")) { limit = true; continue; }
    if (line.startsWith("\x01VG")) {
      const e = JSON.parse(line.slice(3));
      for (const [k, v] of Object.entries(e.d)) st.set(e.fn + "\x1f" + k, v);
      const vars = {};
      for (const n of e.n) vars[n] = st.get(e.fn + "\x1f" + n);
      steps.push({ line: e.line, fn: e.fn, vars });
    } else if (line) other.push(line);
  }
  return { steps, other, limit };
}

// 預編譯標頭：依「使用者的 #include 組合 + 標準」各建一份並快取（同一份標頭第二次起不用再建）。
const pchCache = new Map();
const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("vgdb-pch", 1); r.onupgradeneeded = () => r.result.createObjectStore("pch"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction("pch").objectStore("pch").get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } };
const idbPut = async (k, v) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("pch", "readwrite"); t.objectStore("pch").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
async function getPch(source, std) {
  const NL = "\n";
  const incs = source.split(NL).filter((l) => /^\s*#\s*include\b/.test(l)).map((l) => l.trim());
  const key = std + "|" + incs.join("|");
  let hit = pchCache.get(key), built = 0;
  const src = incs.join(NL) + NL + '#include "vg.h"' + NL;
  let from = "memory";
  if (!hit) {
    // 持久快取：鍵含 vg.h 內容雜湊與編譯器大小，任一改變就自動失效（PCH 綁死編譯器版本）。
    const dbKey = key + "|vg" + hashStr(vgH) + "|clang" + state.clangSize;
    let bytes = await idbGet(dbKey);
    if (bytes) from = "indexeddb";
    else {
      const b = await buildPch(src, { std, extraFiles: { "include/vg.h": vgH } });
      bytes = b.bytes; built = b.ms; from = "built";
      idbPut(dbKey, bytes).catch(() => {}); // ponytail: 沒有容量上限／淘汰，鍵很多時再加 LRU
    }
    hit = { files: { "vg.pch": bytes, "pch_src.h": src, "include/vg.h": vgH }, mb: bytes.length / 1e6 };
    pchCache.set(key, hit);
  }
  return { ...hit, built, from, flags: ["-Xclang", "-include-pch", "-Xclang", "vg.pch", "-Xclang", "-fno-validate-pch"] };
}

function dedupe(steps) {
  const out = [];
  for (const s of steps) { const p = out[out.length - 1]; if (!p || p.line !== s.line || p.fn !== s.fn) out.push(s); }
  return out;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      state.reuse = m.reuse ?? true;
      const t = await loadAll();
      vgH = await (await fetch("/e2/vg.h")).text();
      const res = performance.getEntriesByType("resource").filter((x) => /clang|lld|sysroot/.test(x.name)).map((x) => ({ name: x.name.split("/").pop(), transfer: x.transferSize, encoded: x.encodedBodySize, decoded: x.decodedBodySize, ms: Math.round(x.duration) }));
      post({ type: "loaded", t, res });
    } else if (m.type === "run") {
      state.reuse = m.reuse ?? true;
      const T = {};
      let t0 = now();
      const pch = m.pch ? await getPch(m.source, "c++17") : null;
      T.pchBuild = pch ? pch.built : 0; T.pchFrom = pch ? pch.from : null;
      t0 = now();
      const ins = m.instrumentOff ? { text: m.source, uninit: [] } : await instrument(m.source, { std: "c++17", astOpts: pch ? { extraFiles: pch.files, flags: pch.flags } : {} });
      T.instrument = now() - t0;
      t0 = now();
      const c = await compile({ source: ins.text, flags: ["-std=c++17", "-fno-exceptions", ...(pch ? pch.flags : ["-include", "vg.h"])], extraFiles: pch ? pch.files : { "include/vg.h": vgH } });
      T.compile = now() - t0;
      T.compileDetail = c.t;
      if (!c.ok) { post({ type: "result", ok: false, stage: c.stage, log: c.log.slice(0, 600), T }); return; }
      t0 = now();
      const r = await runExec(c.module, m.stdin || "", m.timeoutMs ?? 5000);
      T.exec = now() - t0;
      let res = { type: "result", ok: true, T, killed: !!r.killed, killWallMs: r.killed ? r.wallMs : null, exit: r.exit ?? null, stdout: r.out ?? "", wasmBytes: c.wasmBytes };
      if (!r.killed && r.err != null) {
        t0 = now();
        const d = decode(r.err);
        T.decode = now() - t0;
        const dd = dedupe(d.steps);
        res = { ...res, rawSteps: d.steps.length, steps: dd.length, traceBytes: r.err.length, limit: d.limit, lines: dd.map((s) => s.line).join(","), firstVars: dd.slice(0, 3).map((s) => s.vars) };
        if (m.returnSteps) res.stepList = dd;
      }
      post(res);
    }
  } catch (err) {
    post({ type: "error", error: String(err && err.stack || err) });
  }
};
