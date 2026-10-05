# localEngine（vgdb M1 層 B：UI 接線）

契約：`docs/superpowers/plans/2026-09-26-S3S4-M1-contract.md` §2 層 B。引擎：`gdbgui/static/engine/`；LocalGdb：`gdbgui/static/engine/localgdb/`。

## 唯一引擎

wasm 瀏覽器引擎是**唯一**引擎：已沒有伺服器 GDB，也沒有 `?engine=` / localStorage `vgdb_engine` 之類的開關或退路；每個接線點無條件走 `localEngine`。舊連結上殘留的 `?engine=…` 參數會被忽略。

## 引擎載入（不進 webpack bundle）

`loadModules()` 注入一個 inline `<script type="module">`，內容只有兩行 `import`（`<base>index.js`、`<base>localgdb/index.js`）＋把模組掛到 `window.__vgdbEngine` 後發 `vgdb-engine-ready` 事件；讀到後即刪除該全域。`<base>` 由頁面自己的 `static/js/main.js` `<script>` 推得（`../engine/`），找不到就用 `/static/engine/`；**非同源一律拒絕**。失敗：script `error` 事件或 30 秒逾時。編譯器資產（`assets/*.wasm/.tar`）由引擎自己在第一次 Run 時 `loadEngine()` 下載（SRI 驗證、IndexedDB 快取）。

## LocalSocket（`GdbApi.init()` 的 socket）

- 頁面載入就存在；`connected=false` 直到模組載入、建立「尚未 Run」的 LocalGdb session（空軌跡：`steps:[]`、`source:""`），然後依伺服器順序送 `connect` → `debug_session_connection_event {ok:true, started_new_gdb_process:true, pid, message}`，UI 因而照常執行 `run_initial_commands`。在這之前 UI 自己把命令放進 `queuedGdbCommands`（與真 socket 相同）；`emit` 進來的 `run_gdb_command` / `pty_interaction` 另有緩衝，attach 時依到達順序（FIFO）送出。
- **Run 之前的命令**（`-list-features`、`-list-target-features`、點行下斷點、`-break-list` …）由那個空 session 以真的 LocalGdb 回答：features 含 `reverse`；`-break-insert -f` 變 pending（和尚未載入符號的 GDB 一樣）；`-exec-run` 直接 `exited-normally`。不會觸發 10 秒看門狗。
- Run 成功後 `attach(新 session)`：之後的命令只進新 session；舊 session 答完它手上的命令（`idle()`）才關閉。`request_id` / `packet_seq_num` / `run_token` 由 LocalGdb 負責（規格 §4、§12 N4）。
- 轉給 UI 的事件：`gdb_response`、`program_pty_response`、`user_pty_response`、`error_running_gdb_command`。session 自己的 `connect` 類事件不轉（只宣告一次）。
- 模組載入或初始化失敗：`connect` 後送 `ok:false` 的連線事件（UI 印訊息並關閉 socket）。

## 模擬端點

| 端點 | 接線點 | 行為 |
|---|---|---|
| `POST /create_and_upload` | `GdbApi.click_run_button` | `localEngine.ajax(同一組設定)` → `createAndUpload`：載入引擎（第一次）→ `runProgram(code, stdin)` → `createLocalGdb` → `setRunToken` → attach；回 `{status:"success", binary_path:"/vgdb-wasm/main.wasm", source_path:"/workspace/main.cpp", gdb_source_path:"/vgdb-wasm/main.cpp", exec_wrapper:"", gdb_subst_cmd:"", sandbox_warnings, run_token}` 給原本的 `success` 回呼；錯誤以 `{message, stderr}` 走原本的 `error(xhr)` 回呼（同一條 CompileErrors 路徑） |
| `POST /api/prerun_calltree` | `click_run_button` | `{ok:false}`：不顯示幽靈呼叫樹 |
| `GET /get_last_modified_unix_sec` | `GdbApi.get_inferior_binary_last_modified_unix_sec` | 固定 mtime（與 `/read_file` 相同，所以不會跳「原始碼比執行檔新」） |
| `GET /read_file` | `FileOps` `FileFetcher._fetch` | 由除錯中的原始碼（尚未 Run 時用編輯器內容）產生，形狀同 `http_routes.read_file` 的不上色分支；**每行以 Python `html.escape` 相同規則跳脫**（`& < > " '`）；只認 `/workspace/main.cpp` 與 `/vgdb-wasm/main.cpp`，其他路徑回伺服器的「File not found or not accessible」 |
| `POST /send_signal` | `Actions.send_signal` | 編譯／執行中：放棄這次 Run（回「已中斷」）、`dispose` 引擎；除錯中 `SIGINT`→inferior：無事可做（執行是預先完成的）；其他訊號或 target `gdb`：結束 session，回到「尚未 Run」 |

stdin：與 UI 的 PTY 注入一致——`program_input`（空則 localStorage `gdbgui_program_input`）＋`"\n"`，在 `runProgram` 時一次給；之後 UI 的 `pty_interaction write` 只被 LocalGdb 確認。

錯誤對映（`mapRunError`）：`compile`（stderr 的 `main.cpp:` 換成 `/workspace/main.cpp:`）、`unsupported`（「瀏覽器引擎不支援此語法（X，第 N 行）」＋一行 `file:N:1: error:` 讓 CompileErrors 標行）、`compile-timeout`、`link`、`forbidden-import`、`instrumentation-failed`、其他內部錯誤；另外 `exit.reason` 為 `stack-overflow`、`step-limit`、`trace-limit` 也走錯誤路徑（無法完整重現 GDB 的執行）。`timeout`、`output-limit`、`nosys`、`trace-truncated` 只進 `sandbox_warnings`。

進度：`click_run_button` 原有的「正在編譯並上傳程式碼……」之外，加兩行主控台訊息（載入編譯器／編譯執行中）並在期間設 `waiting_for_response`。

## 資安

不讀、不轉送 CSRF token 或 cookie（`beforeSend` 從不被呼叫、`data.csrf_token` 從不被讀），不連網（引擎自己只抓同源 `/static/engine/assets`），不 eval 學生資料（注入的 script 只含兩個 JSON 字串化的同源網址），`/api/lessons*` 等其他端點不動。

## 測試

`tests/localEngine.jest.ts`（LocalSocket、模擬端點、`/read_file` 跳脫、真的 LocalGdb 回答 Run 前命令、「wasm 是唯一引擎」守門測試）、`tests/localEngineWiring.jest.ts`（GdbApi / FileOps 接線）、`tests/localEngineSignal.jest.ts`（Actions.send_signal）。
