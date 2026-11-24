// @ts-check
// Site-wide background warm-up (無感加載) for the pages outside the IDE: everything built on templates/_auth_base.html
// (login, register, lesson library, profile, logout). When the browser is idle it loads the compiler — downloaded and
// verified into IndexedDB on the first visit, only read back afterwards — and compiles the warm-up programs of
// WARM_PRELUDES, which builds their PCH into the shared IndexedDB PCH cache. The IDE page then has nothing to
// download and, for the common lesson preludes, no PCH to build; it warms its own compiler worker itself
// (gdbgui/src/js/localEngine.ts prewarm()), because a worker does not outlive its page.
// Best effort and silent: skipped with Save-Data and on touch-only devices (the phone pages never run the compiler),
// one tab at a time (Web Locks), errors ignored, the worker ends when the page goes away. Progress is visible only as
// <html data-vgdb-warmup> (loading, warming, done, busy, failed, skipped) for e2e tests and measurements.
import { loadEngine } from "./index.js";

/** @param {string} state */
const mark = (state) => { try { document.documentElement.setAttribute("data-vgdb-warmup", state); } catch { /* no DOM */ } };

/** @returns {boolean} */
function skip() {
  try {
    const nav = /** @type {any} */ (navigator);
    if (nav.connection && nav.connection.saveData) return true;
    if (typeof matchMedia === "function" && !matchMedia("(any-pointer: fine)").matches) return true;
  } catch { /* unknown: warm up */ }
  return typeof Worker === "undefined" || typeof WebAssembly === "undefined" || typeof indexedDB === "undefined";
}

async function warm() {
  mark("loading");
  const engine = await loadEngine();
  try {
    mark("warming");
    const res = await engine.warmUp();
    console.info("[IRIS] 瀏覽器引擎預先載入完成", engine.assets && engine.assets.sources, res); // asset sources (cache/network), warm-up programs
    mark("done");
  } finally {
    engine.dispose();
  }
}

function start() {
  const locks = /** @type {any} */ (navigator).locks;
  const run = () => warm().catch(() => mark("failed"));
  if (locks && typeof locks.request === "function") {
    // another tab already warming: nothing to add
    locks.request("vgdb-prewarm", { ifAvailable: true }, (/** @type {any} */ lock) => (lock ? run() : mark("busy"))).catch(() => mark("failed"));
  } else {
    run();
  }
}

if (skip()) mark("skipped");
else {
  const idle = () => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 10000 });
    else setTimeout(start, 0);
  };
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}
