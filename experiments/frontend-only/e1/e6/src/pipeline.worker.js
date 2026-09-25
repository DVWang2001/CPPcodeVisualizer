// 編譯管線 Worker：載入編譯器 → 插樁 → 編譯連結 → 在「執行 Worker」裡跑（可逾時終止）→ 解碼差量紀錄。
// 跟正式版的分工一樣：主執行緒完全不做重活，永遠不會被編譯器或學生程式卡住。
import { state, loadAll, compile } from "./driver.js";
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
      const ins = m.instrumentOff ? { text: m.source, uninit: [] } : await instrument(m.source, { std: "c++17" });
      T.instrument = now() - t0;
      t0 = now();
      const c = await compile({ source: ins.text, flags: ["-std=c++17", "-fno-exceptions", "-include", "vg.h"], extraFiles: { "include/vg.h": vgH } });
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
