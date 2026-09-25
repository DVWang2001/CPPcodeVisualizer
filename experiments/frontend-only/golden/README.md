# 黃金樣本 v0：正式機 GDB 事件紀錄（技巧一，教案 #23）

- 來源：正式機（`vgdb.duckdns.org:5000`，gdb 16.3，g++ 14.2，`-g -O0 -no-pie`）伺服器端錄製（`gdbgui/server/event_recorder.py`，旗標檔開關），由 UI 實際驅動：Run → `next` ×約 20 → `step` ×1 → `continue` ×數次直到程式結束。即時課堂關閉。
- `raw_events.jsonl`：558 筆，每行 `{t, dir, name, sid, data}`；`dir` 為 `C>S`／`S>C`；`sid` 是 client id 的雜湊（全檔只有一條連線）。
- 事件數：`run_gdb_command` 301、`gdb_response` 246、`user_pty_response` 7、`pty_interaction` 2、`debug_session_connection_event` 1、`program_pty_response` 1。
- 遮蔽：`run_token`／`csrf_token`／`token` 字串值在寫入時取代為 `<redacted>`（`run_token` 一開始為 `null` 的原樣保留）；不記 query string。已 grep 確認無殘留。
- 涵蓋不足：只有**一份教案、單次操作**；沒有 5 份程式的完整逐步紀錄；`step` 只有 1 次；沒有斷點命中、`finish`、反向執行、錯誤情境。S3／S4 驗收需要擴充（同一錄製方式重錄即可）。
- 錄製組態：`-list-features` 等初始化命令、`IGNORE_ERRORS` 前綴（token "1"）與 `CREATE_VAR`（"3"）都在檔內可見，即「UI 實際下的命令」。
