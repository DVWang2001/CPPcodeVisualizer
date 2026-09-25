"""E6 瀏覽器實測用的本機伺服器：
- COOP/COEP：讓頁面「跨來源隔離」，才能用 performance.measureUserAgentSpecificMemory() 量含 wasm 的總記憶體。
- /node_modules/ 用永久快取（immutable），模擬正式版「檔名帶雜湊、第二次不再下載」。
- 其餘不快取，方便改程式。
只綁 127.0.0.1。
"""
import http.server, socketserver, sys, os

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".h": "text/plain; charset=utf-8", ".cpp": "text/plain; charset=utf-8", ".json": "application/json"}
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if self.path.startswith("/node_modules/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def do_POST(self):  # 結果回收：POST /save 存成 e6_result.json（附加一行）
        n = int(self.headers.get("Content-Length", 0))
        with open("e6_results.jsonl", "ab") as f: f.write(self.rfile.read(n) + bytes([10]))
        self.send_response(204); self.end_headers()
    def log_message(self, fmt, *args):
        pass

os.chdir(sys.argv[1])
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[2])), H) as s:
    s.serve_forever()
