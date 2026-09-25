// 執行學生程式的 Worker：一次性，主控端可以隨時 terminate()。
import { WASI, File, OpenFile, ConsoleStdout } from "/node_modules/@bjorn3/browser_wasi_shim/dist/index.js";

self.onmessage = async (e) => {
  const { module, stdin } = e.data;
  let out = "", err = "";
  const fds = [new OpenFile(new File(new TextEncoder().encode(stdin))),
    new ConsoleStdout((d) => { out += new TextDecoder().decode(d); }),
    new ConsoleStdout((d) => { err += new TextDecoder().decode(d); })];
  const wasi = new WASI([], [], fds);
  const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const t0 = performance.now();
  let exit;
  try { exit = wasi.start(inst); } catch (ex) { exit = "trap: " + ex.message; }
  self.postMessage({ out, err, exit, ms: performance.now() - t0 });
};
