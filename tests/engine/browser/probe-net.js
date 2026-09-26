// 探針：在 Worker 內嘗試各種「出網／載入程式碼」的動作，回報每一項是被擋、被允許還是其他錯誤。
// 三個探針 Worker（probe-pipeline / probe-exec / probe-control）共用這份邏輯，差別只在伺服器對各自腳本送的 CSP。
// 這驗證的是「該 CSP 標頭本身能擋住什麼」；真正的引擎 Worker 也用同一組標頭提供，並在 bench.html 用實際程式驗證不被誤傷。
export async function probe(origin, otherOrigin, wsUrl) {
  const out = {};
  const attempt = async (name, fn) => {
    try { const v = await fn(); out[name] = "allowed" + (v === undefined ? "" : ": " + String(v).slice(0, 60)); }
    catch (e) { out[name] = "blocked: " + (e && e.name ? e.name : "error") + (e && e.message ? " - " + String(e.message).slice(0, 60) : ""); }
  };
  await attempt("fetch same-origin", async () => (await fetch(origin + "/static/engine/assets/manifest.json", { cache: "no-store" })).status);
  await attempt("fetch cross-origin", async () => { const r = await fetch(otherOrigin + "/static/engine/assets/manifest.json", { mode: "no-cors", cache: "no-store" }); return r.type; });
  await attempt("XMLHttpRequest", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", origin + "/static/engine/assets/manifest.json"); x.onload = () => res(x.status); x.onerror = () => rej(new Error("xhr error")); x.send(); }));
  await attempt("WebSocket", () => new Promise((res, rej) => { const w = new WebSocket(wsUrl); const t = setTimeout(() => { try { w.close(); } catch (e) { /* ignore */ } rej(new Error("no open within 1.5s (refused or blocked)")); }, 1500); w.onopen = () => { clearTimeout(t); w.close(); res("open"); }; w.onerror = () => { clearTimeout(t); rej(new Error("ws error")); }; }));
  await attempt("EventSource", () => new Promise((res, rej) => { if (typeof EventSource === "undefined") return rej(new Error("EventSource unavailable in workers")); const e = new EventSource(origin + "/static/engine/assets/manifest.json"); e.onopen = () => { e.close(); res("open"); }; e.onerror = () => { e.close(); rej(new Error("es error")); }; }));
  await attempt("importScripts", () => { importScripts(origin + "/static/engine/sha256.js"); }); // 模組 Worker 本來就不支援 → TypeError
  await attempt("dynamic import same-origin", async () => { await import(origin + "/static/engine/sha256.js"); });
  await attempt("dynamic import cross-origin", async () => { await import(otherOrigin + "/static/engine/sha256.js"); });
  // 巢狀 Worker 被 CSP 擋下時不會同步丟例外，而是非同步的 error 事件，所以要等「hi」或 error
  await attempt("nested Worker", () => new Promise((res, rej) => { const w = new Worker(origin + "/browser/nested-hello.js", { type: "module" }); const t = setTimeout(() => { w.terminate(); rej(new Error("no message within 3s")); }, 3000); w.onmessage = (e) => { clearTimeout(t); w.terminate(); res(e.data); }; w.onerror = () => { clearTimeout(t); w.terminate(); rej(new Error("worker error event")); }; }));
  await attempt("eval", () => (0, eval)("1+1"));
  await attempt("new Function", () => new Function("return 2")());
  await attempt("WebAssembly.compile(bytes)", async () => { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return "ok"; });
  return out;
}
