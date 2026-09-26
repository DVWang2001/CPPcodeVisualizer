// 探針 Worker（control）：邏輯在 probe-net.js，CSP 由伺服器依檔名附加（serve.mjs）。
import { probe } from "./probe-net.js";
self.onmessage = async (e) => { const [origin, other, ws] = e.data; self.postMessage(await probe(origin, other, ws)); };
