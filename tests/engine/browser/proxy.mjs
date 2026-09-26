// 前景 UI 驗收用的本機代理（只綁 127.0.0.1）：
//   node tests/engine/browser/proxy.mjs [listenPort=9180] [target=127.0.0.1:5000]
// 把請求原樣轉給本機 App，並在 HTML 回應注入驅動腳本（ui_drive.js + autorun.js）。
// 為什麼需要：自動化控制的分頁是背景分頁，計時器與 TTS 會被節流到近乎停擺；要驗證自動播放，
// 必須在使用者的前景 Chrome 視窗跑。代理讓頁面在前景自己驅動自己，並把進度 POST 到 /__drive/save。
// - 改寫 Host／Origin／Referer 成目標位址，讓 App 的同源檢查照常通過（cookie 對埠不分，登入狀態沿用）。
// - 不支援 WebSocket 升級（socket.io 會退回長輪詢，本測試不受影響）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LISTEN = Number(process.argv[2] || 9180);
const [THOST, TPORT] = (process.argv[3] || "127.0.0.1:5000").split(":");
const INJECT = '<script src="/__drive/ui_drive.js"></script><script src="/__drive/autorun.js"></script>';
const OUT = path.join(HERE, "autorun_results.jsonl");

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/__drive/")) {
    const name = url.pathname.slice("/__drive/".length);
    if (req.method === "POST" && name === "save") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { fs.appendFileSync(OUT, Buffer.concat(chunks).toString("utf8") + "\n"); res.writeHead(204); res.end(); });
      return;
    }
    const f = { "ui_drive.js": "ui_drive.js", "autorun.js": "autorun.js", "lesson.json": path.join("..", "..", "..", "examples", "lessons", "技巧一_環狀最小成本_UVA116", "tsp_uva116.json") }[name];
    if (!f) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "text/javascript", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(HERE, f)));
    return;
  }
  const headers = { ...req.headers, host: `${THOST}:${TPORT}` };
  if (headers.origin) headers.origin = `http://${THOST}:${TPORT}`;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, `http://${THOST}:${TPORT}`);
  delete headers["accept-encoding"]; // 要改寫 HTML，請上游不要壓縮
  const up = http.request({ host: THOST, port: Number(TPORT), path: req.url, method: req.method, headers }, (ur) => {
    const ct = String(ur.headers["content-type"] || "");
    const h = { ...ur.headers };
    if (ct.includes("text/html")) {
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = body.includes("</body>") ? body.replace("</body>", INJECT + "</body>") : body + INJECT;
        delete h["content-length"]; delete h["content-security-policy"];
        res.writeHead(ur.statusCode, h); res.end(body);
      });
    } else { res.writeHead(ur.statusCode, h); ur.pipe(res); }
  });
  up.on("error", (e) => { res.writeHead(502); res.end("proxy error: " + e.message); });
  req.pipe(up);
}).listen(LISTEN, "127.0.0.1", () => console.log("proxy on", LISTEN, "->", THOST + ":" + TPORT));
