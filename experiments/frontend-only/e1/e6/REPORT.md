# E6：真實瀏覽器實測（Chrome、13 核心、16GB、本機 127.0.0.1）

管線：插樁 → 編譯連結（WASM 內的 clang/lld）→ 執行 Worker（可 terminate）→ 差量解碼。技巧一（5×4）。

| 項目 | 結果 |
|---|---|
| 首次下載 | sysroot 28.6MB + clang 42.6MB + lld 23.2MB ≈ 94MB（未壓縮；本機） |
| 載入（下載到就緒） | 約 0.6 秒（本機磁碟，不代表網路） |
| 正確性 | 372 步 = GDB 372 步、行序列完全相同、3,766 個值 0 不一致 |
| 暖機後一次「插樁+編譯+執行」 | 中位數 4.25 秒（插樁 ≈1.8s、編譯+連結 ≈2.2s、執行 ≈0.1s）；第 1 次 6.9 秒 |
| 不重用已編譯模組 | 中位數 5.0 秒（重用省約 0.75 秒） |
| 20×20 | 8,075 步、trace 2.8MB、總 5.3 秒（執行 1.5s、解碼 0.1s） |
| 失控 for(;;){} | 1.5 秒逾時，實測 1.516 秒被 terminate |
| 步數上限 | 200,000 步後停止，1.5 秒、trace 9.3MB |
| 記憶體 | 主執行緒 34MB（measureUserAgentSpecificMemory，可能不含 Worker 內 wasm，僅供參考） |

## 注意／未解
- 插樁佔 1.8 秒（比編譯還多）：它要先跑一次 clang AST dump，可再優化（PCH／只 dump 使用者命名空間）。
- 「主執行緒最大延遲 46.9 秒」不可信：分頁在背景（被 CDP 控制），計時器被節流；需前景分頁重測。
- 快取行為未驗證：fetch 的 transferSize 仍非 0（CDP 可能停用快取）；需在一般 Chrome、實際 HTTPS 部署後量第二次造訪。
- 網路下載時間未量（本機）；94MB 在校園網路需另測，並應開 gzip/br（wasm 壓縮率通常 3~4 倍）。
- 只測 Chrome；Safari/Firefox 未測。

## 補：優化插樁——預編譯標頭（PCH）同時用在 AST 分析與編譯
插樁慢是因為 AST 分析要把 `<algorithm>`、`<iostream>` 等標頭整個重新解析一次（跟編譯那次一樣貴）。
改成依「使用者的 #include 組合 + 標準」建一份 PCH（含 vg.h），AST 分析與編譯共用，並在 Worker 內快取。

| 階段（技巧一，暖機、Chrome） | 無 PCH | 有 PCH |
|---|---|---|
| 插樁 | ≈1.8 s | ≈0.95 s |
| 編譯＋連結 | ≈2.2 s | ≈1.0 s |
| 端到端（不含建 PCH） | ≈4.1 s | **≈2.05 s** |
| 首次（另加建 PCH 2.2 s） | 6.9 s | 6.1 s |

- 正確性：372 步行序列與 GDB 相同；唯一差異是第一步未初始化的 `h`（垃圾值，本來就不比）。
- 快取：同一份 #include 組合第二次起免建；不同組合各建一份（首次 +2.2 s）。
- 未做：PCH 位元組尚未存 IndexedDB（重新整理頁面就要重建）；`bits/stdc++.h` 的 PCH 尚未在瀏覽器測；PCH 的名稱衝突風險見 E3 報告。

## 補：PCH 存進 IndexedDB
PCH 位元組存 IndexedDB（`vgdb-pch`），鍵 = 標準 + #include 組合 + vg.h 雜湊 + clang.wasm 大小，任一改變自動失效。
實測：新 Worker（模擬重新整理）第一次 `from: "built"`（建置 3.6 s，冷）→ 第二個新 Worker `from: "indexeddb"`（建置 0 s），輸出正確。
限制：無容量上限／淘汰（ponytail）；PCH 約 15 MB／組合，若學生 include 組合很多需加 LRU；隱私模式 IndexedDB 可能不可用，此時退回每次重建（已 catch）。

## 補：前景分頁重測（一般 Chrome、視窗可見；`?only=pch&auto=1`，結果由頁面 POST 回 serve.py）
自動化控制的分頁是背景分頁（visibilityState=hidden），計時器與 CPU 被節流，先前的數字（含「主執行緒延遲 46.9 秒」）偏慢／不可信。前景重測：

| 項目 | 前景結果 |
|---|---|
| 暖機後端到端（插樁+編譯+執行，PCH 已快取） | **約 0.9 秒**（背景分頁是 2.05 秒） |
| 同一 Worker 內第 1 次（含 IndexedDB 讀 PCH） | 2.4 秒（冷 JIT） |
| 主執行緒延遲 | 848 個 50ms tick 中 3 個 >100ms、最大 950ms；編譯／執行在 Worker，主執行緒沒有被長時間卡住。兩次最大值都剛好 950ms，疑似頁面載入或結果搬運的單次停頓，未追查 |
| 載入編譯器（快取後） | 約 0.23~0.27 秒 |
| 快取 | sysroot.tar、lld.wasm：transferSize=0（命中快取）。clang.wasm 仍回報完整 transferSize（42.5MB）但只花 125~173ms，不是真的走網路；原因未查明（本機 127.0.0.1，無法代表真實網路） |
| PCH 持久快取 | 重新整理後第一次 `from: indexeddb`，之後 `memory`；建置 0 s |
| 記憶體（主執行緒） | 34~51 MB（不含 Worker 內 wasm，僅供參考） |

限制：仍是本機、單一機器（13 核、16GB）、Chrome；學生筆電較慢時數字要放大；真實網路下載與 HTTPS 部署後的快取未測。
