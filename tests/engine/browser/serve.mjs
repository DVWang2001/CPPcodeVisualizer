// S2 本機瀏覽器實測用的靜態伺服器（只綁 127.0.0.1）。
//   node tests/engine/browser/serve.mjs <port> [--tamper]
// - /static/engine/**  ← gdbgui/static/engine（assets 用 immutable 長期快取；worker 各帶自己的 CSP）
// - /browser/**        ← tests/engine/browser（測試頁與探針 worker）
// - /data/**           ← 測試程式（教案 tsp）
// - POST /save         ← 把結果附加到 tests/engine/browser/results.jsonl
// - --tamper：把 clang.wasm 回應的第一個位元翻轉，用來驗證「載入必須失敗（fail closed）」
// 刻意「不」送 COOP/COEP（計畫 §1.4：正式版不需要，也避免影響外部嵌入）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ENGINE = path.join(ROOT, "gdbgui/static/engine");
const DATA_FILES = {
  "tsp.cpp": path.join(ROOT, "examples/lessons/技巧一_環狀最小成本_UVA116/tsp_uva116.cpp"),
  "tsp.in": path.join(ROOT, "experiments/frontend-only/e1/e2/ref/tsp.in"),
};
const port = Number(process.argv[2] || 8770);
const tamper = process.argv.includes("--tamper");

// 各 Worker 檔自己的 CSP（計畫 §1.5(c)）。管線 Worker 要編譯學生的輸出，所以需要 wasm-unsafe-eval；
// 它的資產由主執行緒驗證後以 Module 傳入，所以 connect-src 'none'。執行 Worker 完全沒有網路需求。
const CSP = {
  "pipeline.worker.js": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'",
  "exec.worker.js": "default-src 'none'",
  "probe-pipeline.worker.js": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'",
  "probe-exec.worker.js": "default-src 'none'",
  // 對照組：不帶 CSP，證明探針本身是有效的（同樣的動作在沒有 CSP 時會成功）
  "probe-control.worker.js": null,
};
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".tar": "application/x-tar", ".h": "text/plain; charset=utf-8", ".cpp": "text/plain; charset=utf-8", ".in": "text/plain; charset=utf-8", ".ref": "text/plain; charset=utf-8" };

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/save") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { fs.appendFileSync(path.join(HERE, "results.jsonl"), Buffer.concat(chunks).toString("utf8") + "\n"); res.writeHead(204); res.end(); });
    return;
  }
  let file = null;
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith("/static/engine/")) file = safeJoin(ENGINE, p.slice("/static/engine/".length));
  else if (p.startsWith("/browser/")) file = safeJoin(HERE, p.slice("/browser/".length));
  else if (p.startsWith("/data/")) file = DATA_FILES[p.slice("/data/".length)] || null;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || file.includes(path.sep + "node_modules" + path.sep)) { res.writeHead(404); res.end("not found"); return; }
  const name = path.basename(file);
  const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" };
  // assets 以雜湊比對，可長期快取；其餘每次驗證（manifest 需最新）
  headers["Cache-Control"] = p.startsWith("/static/engine/assets/") && name !== "manifest.json" ? "public, max-age=31536000, immutable" : "no-cache";
  if (Object.prototype.hasOwnProperty.call(CSP, name) && CSP[name]) headers["Content-Security-Policy"] = CSP[name];
  let body = fs.readFileSync(file);
  if (tamper && name === "clang.wasm") { body = Buffer.from(body); body[body.length >> 1] ^= 1; }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
});
// 最小 WebSocket 握手（只為了讓探針分辨「被 CSP 擋」與「伺服器拒絕」：能升級成功就代表沒被擋）
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + accept, "", ""].join("\r\n"));
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1", () => console.log("listening", port, tamper ? "(tamper)" : ""));
