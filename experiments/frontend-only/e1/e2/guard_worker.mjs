// 在 Worker 裡執行 wasm 程式（瀏覽器也是這樣做：主執行緒不會被學生的程式卡住，逾時就 terminate）。
import { parentPort, workerData } from "node:worker_threads";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

const { module, stdin } = workerData;
let out = "", err = "";
const fds = [new OpenFile(new File(new TextEncoder().encode(stdin))),
  new ConsoleStdout((d) => { out += new TextDecoder().decode(d); }),
  new ConsoleStdout((d) => { err += new TextDecoder().decode(d); })];
const wasi = new WASI([], [], fds);
const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
let exit;
try { exit = wasi.start(inst); } catch (e) { exit = "trap: " + e.message; }
parentPort.postMessage({ out, err, exit });
