# S2（本機瀏覽器部分）實測報告

環境：使用者的桌機 Chrome（前景分頁，`visibilityState=visible`）、16 核、8GB、`127.0.0.1`（secure context）。伺服器 `serve.mjs`：不送 COOP/COEP；各 Worker 帶自己的 CSP；資產 `immutable`。
執行方式：`node tests/engine/browser/serve.mjs 8770`（另開 `8771 --tamper`），瀏覽器開 `/browser/bench.html?auto=1`、`/browser/recdepth.html`；結果 POST 到 `/save`（`results.jsonl`，已忽略不進版本控制的暫存）。

**範圍**：本片只驗證「本機可量」的項目。**未做**（需要動正式機／部署，由使用者決定）：Flask／nginx 的 brotli、`immutable` 與 HTTPS 上線、校外實際下載時間、其他瀏覽器（Firefox／Safari／Edge）、慢筆電。

## 結果

| 項目 | 結果 |
|---|---|
| 引擎在真實 Chrome + 各 Worker CSP 下運作 | ✅ 技巧一 372 步、輸出 `3 2 2 1 / 6`，管線／執行 Worker 都在 CSP 下正常 |
| 冷啟動（首次造訪，快取全空） | 載入 2.1 s（本機磁碟，不含網路）＋ 第一次執行 3.4 s（含 PCH 建置 1.76 s） |
| 第二次造訪（資產與 PCH 皆快取） | 載入 0.34 s；第一次執行 2.2 s；之後每次約 1.05–1.25 s（AST ≈0.4 s、編譯連結 ≈0.4 s、執行 ≈0.02 s） |
| 8 秒編譯預算餘裕 | 冷編譯（AST＋編譯＋連結）約 1.4 s，約 5.7 倍餘裕（本機）；慢筆電未測 |
| 主執行緒延遲 | 第一輪最大 405 ms（5 次 >100 ms，發生在主執行緒編譯 42MB wasm 的載入階段）；第二輪最大 64 ms、0 次 >100 ms。執行期間主執行緒不被學生程式卡住 |
| 看門狗／上限（瀏覽器內） | `for(;;){}` 1.6 s 被終止；無限輸出停在 1 MiB；記憶體炸彈 `trap abort`；管線 Worker 之後仍正常 |
| 竄改資產 | ✅ 翻轉 `clang.wasm` 一個位元 → 載入失敗（fail closed，瀏覽器只回報 `Failed to fetch`；UI 需自行顯示「資產驗證失敗」） |

## 發現與處置

### F-S2-1（重要，已修）：`clang.wasm` 從沒被瀏覽器 HTTP 快取
即使有 `Cache-Control: immutable`，第二次造訪 `clang.wasm`（42.6MB）仍完整重新下載，而 23MB 的 `lld.wasm`、28.6MB 的 `sysroot.tar` 命中快取（傳輸量 0）。E6 就出現過同樣現象。推測是 Chrome 的 HTTP 快取不保存超過約 40MB 的單一項目（未從 Chrome 原始碼證實；現象與大小門檻吻合）。這代表「第一次下載、之後靠快取」對最大的檔案不成立。
處置：`browserEnv.loadAssets` 改為把**驗證過的資產位元組存進 IndexedDB**（鍵＝檔名＋manifest 的 sha256；Cache Storage 需要 secure context，而正式機目前是 HTTP，所以選 IndexedDB）。第二次造訪：只抓 manifest，四個資產都來自快取，載入 0.34 s。快取讀取時，在有 SubtleCrypto（secure context）時重新驗 SHA-256；HTTP 下只驗大小＋ `WebAssembly.compile` 的結構檢查（JS 版 SHA-256 對 42MB 要數秒；此風險屬「本機同源寫入」，與計畫 L1 同一威脅模型）。`navigator.storage.persist()` 盡力請求。新增 5 個單元測試（`assets_cache.test.mjs`：第二次不抓資產、快取被竄改則丟棄重抓、SRI 不符不寫入快取、換 manifest 不會拿舊位元組、無儲存空間仍可載入）。

### F-S2-2（重要，部分緩解）：瀏覽器 Worker 的遞迴深度遠低於 Node 與 GDB
| 組態 | 瀏覽器（Chrome Worker）可遞迴深度 | 註 |
|---|---|---|
| 插樁 `-O0`（S1 預設） | 463（volatile 版）／835（原版）| Node 是 13,308 |
| 插樁 `-O1` | 3,734 | 提升約 8 倍 |
| 插樁 `-O2` | 4,687 | |
| 未插樁 `-O0` | 3,954 | |
| 未插樁 `-O2` | 7,909 | |
GDB（Linux 8MiB 堆疊）可到十萬層等級。限制來自 V8 的原生呼叫堆疊（Worker 約 1MB，且無法設定），不是 wasm 堆疊。
處置：新增 `opt` 選項（`O0`／`O1`／`O2`），**預設改為 `O1`**。驗證：5 份程式對 GDB 參考在 `-O1`、`-O2` 下仍是「允許差異之外零差異」（`VG_OPT=O1 node tests/engine/run_differential.mjs`）；PCH 鍵納入最佳化等級。**副作用**：`-O1` 會刪除沒人讀取的配置與死寫入，所以「配置後不使用」的測試程式行為不同（一個安全測試因此改用 `volatile`）；對學生程式這正是一般編譯器行為。
**仍未解決**：約 3,700 層以上的遞迴（例如 100×100 的 DFS、遞迴到 1e4）在瀏覽器引擎會 `stack-overflow`，而 GDB 版可以跑完。範例教案最深只有 8 層，不受影響；學生自寫程式有風險。建議：偵測到 `stack-overflow` 時提示並提供「改用 GDB 引擎」（與 D5 的退回機制同一條路）。

### F-S2-3：Worker 的 CSP 標頭實際效果（探針，含無 CSP 的對照組）
| 動作 | 對照組（無 CSP） | 管線 Worker | 執行 Worker |
|---|---|---|---|
| fetch 同源／跨源、XHR、WebSocket | 允許 | **擋** | **擋** |
| 動態 `import()` 同源 | 允許 | 允許（管線 Worker 需要載入自己的模組）| **擋** |
| 巢狀 Worker | 允許 | **擋**（加了 `worker-src 'none'` 之後；第一次只用 `default-src 'none'; script-src 'self'` 時是「允許」，這是測試找出來的） | **擋** |
| `eval`／`new Function` | 允許 | **擋** | **擋** |
| `WebAssembly.compile(bytes)` | 允許 | 允許（管線需編譯學生的輸出，`'wasm-unsafe-eval'`）| **擋** |
| `importScripts` | 擋（模組 Worker 本來就不支援） | 同 | 同 |
最終標頭（`serve.mjs`）：
- 管線：`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'`
- 執行：`default-src 'none'`
**這證明的是標頭本身的效果**（用探針 Worker，另有對照組證明探針有效），並且**真正的引擎 Worker 在這組標頭下可完整執行技巧一**。正式機的 Flask／nginx 需要對這兩個檔案送同樣的標頭（部署項目，未做）。
注意：探針不能證明學生的 wasm 無法出網——那由「wasm 沒有 JS 存取、WASI 匯入表是凍結白名單」保證（S1 已測）；CSP 是第二層防線，防範 Worker 內 JS 被入侵時的影響。

### F-S2-4：下載大小（離線量測，brotli 品質 9／gzip 9）
| 檔案 | 原始 | gzip | brotli |
|---|---|---|---|
| clang.wasm | 42.6 MB | 15.1 MB | 12.2 MB |
| lld.wasm | 23.2 MB | 8.8 MB | 7.1 MB |
| sysroot.tar | 28.6 MB | 5.8 MB | 4.6 MB |
| headers.tar | 1.5 MB | 0.1 MB | 0.1 MB |
| **合計** | **95.9 MB** | **29.8 MB** | **24.0 MB** |
在使用者給的 50–100MB 預算內，且啟用壓縮後首次下載只有約 24–30 MB。前提：伺服器要對這些檔案啟用 brotli／gzip（部署項目，未做；現在 Flask 靜態路由是否壓縮未確認）。

### 其他
- 第一輪載入時主執行緒最大延遲 405 ms：來自在主執行緒編譯 42MB wasm（`WebAssembly.compile`）。可改在 Worker 內編譯（S3 整合前再決定）。
- 竄改測試在瀏覽器只回 `Failed to fetch`，UI 要把它翻成可懂的訊息。
- 我 `compileBomb` 的樣板炸彈在瀏覽器裡被 clang 的 constexpr 深度限制在 34 ms 拒絕，沒有真正測到 8 秒編譯逾時；逾時機制已在 S1 的 Node 測試驗證，瀏覽器內未重現。
