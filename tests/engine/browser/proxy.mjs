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
  if (!/\.(js|css|wasm|tar|png|svg|ico|woff2?|map)(\?|$)/.test(req.url) && !req.url.startsWith("/socket.io")) fs.appendFileSync(path.join(HERE, "proxy_access.log"), new Date().toISOString().slice(11, 19) + " " + req.method + " " + req.url.slice(0, 120) + String.fromCharCode(10));
  // 同一帳號只有一個 GDB session、run_token 是 session 層級單一值：兩個視窗同時連線會互相蓋掉回應的章。
  // 啟動代理時加 ISO_ONLY=1，只放行「網址或 Referer 帶 iso=1」的請求（隔離的測試視窗），其餘一律 410，舊視窗因此斷線。
  if (process.env.ISO_ONLY === "1" && !url.pathname.startsWith("/__drive/") && !url.pathname.startsWith("/static/") && !url.pathname.startsWith("/login") && !/iso=1/.test(req.url + " " + String(req.headers.referer || ""))) {
    res.writeHead(410, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("blocked: not the isolated test window"); return;
  }
  if (url.pathname.startsWith("/__drive/")) {
    const name = url.pathname.slice("/__drive/".length);
    if (req.method === "POST" && name === "save") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { fs.appendFileSync(OUT, Buffer.concat(chunks).toString("utf8") + "\n"); res.writeHead(204); res.end(); });
      return;
    }
    if (name === "lessons.json" || /^lesson\/\d+\.json$/.test(name)) {
      // 批次驗收：examples/lessons 底下所有含 source_code 的 .json 教案 bundle（依資料夾名排序）
      const root = path.join(HERE, "..", "..", "..", "examples", "lessons");
      const list = [];
      for (const d of fs.readdirSync(root).sort()) for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith(".json")).sort()) {
        try { const b = JSON.parse(fs.readFileSync(path.join(root, d, f), "utf8")); if (typeof b.source_code === "string") list.push({ name: d + "/" + f, file: path.join(root, d, f) }); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      if (name === "lessons.json") res.end(JSON.stringify(list.map((x, i) => ({ idx: i, name: x.name }))));
      else { const i = Number(name.match(/\d+/)[0]); res.end(list[i] ? fs.readFileSync(list[i].file) : "{}"); }
      return;
    }
    if (name === "autorun.js" && fs.existsSync(path.join(HERE, "STOP")) && !/iso=1|vgnext/.test(String(req.headers.referer || ""))) { // 緊急停止：讓已開啟的視窗下一次載入時什麼都不做
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); res.end("/* stopped */"); return;
    }
    if (name === "cred") { // 本機測試帳號（讀環境變數指定的檔案，不在 repo 內）；只給 127.0.0.1 代理用
      const f2 = process.env.VG_CRED; res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end(f2 && fs.existsSync(f2) ? fs.readFileSync(f2, "utf8") : ""); return;
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
