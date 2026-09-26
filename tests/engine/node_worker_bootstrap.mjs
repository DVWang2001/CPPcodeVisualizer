// Runs an engine worker file (pipeline.worker.js / exec.worker.js) inside a Node worker_thread with a
// minimal Dedicated-Worker-like global: self/postMessage/onmessage. The worker files themselves are
// unchanged; they install their handler only when __vgNodeWorker (or WorkerGlobalScope) is present.
import { parentPort, workerData } from "node:worker_threads";

const g = globalThis;
const queue = [];
let handler = null;
g.__vgNodeWorker = true;
g.self = g;
g.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer || []);
Object.defineProperty(g, "onmessage", {
  configurable: true,
  get: () => handler,
  set: (fn) => { handler = fn; for (const d of queue.splice(0)) handler({ data: d }); },
});
parentPort.on("message", (data) => (handler ? handler({ data }) : queue.push(data)));
await import(workerData.url);
