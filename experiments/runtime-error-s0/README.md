# runtime-error S0：執行時期錯誤偵測的量測

規劃：`docs/superpowers/plans/2026-11-23-runtime-error-viz-plan.md`。這個目錄只放量測腳本，不改引擎，也不進 git。

依使用者規定，**只在 lab-david 執行**（一次性 node 容器、`--cpus 2 -m 3g --network none`，跑完刪除 image 與暫存目錄）。

## 檔案

| 檔案 | 用途 |
|---|---|
| `cases.mjs`、`cases_v2.mjs` | 41 個小程式（每個一種典型錯誤，另有 `sort_user_cmp` 這個正確程式）；`spike3.mjs` 另外讀入 `examples/cpp/errors/` 的 7 個程式 |
| `vgerr.h` | 程式內實作的 UBSan 處理函式（`__ubsan_handle_*`），以及 `__vg_libcxx_assert`、`__libcpp_verbose_abort`、`__assert_fail` 的覆寫；每次回報在 stderr 寫一行 `{"vgerr":...}` |
| `assertion_handler.h` | 替換 libc++ 19 的 `include/c++/v1/__assertion_handler`：EXTENSIVE 模式的檢查失敗時帶著訊息呼叫 `__vg_libcxx_assert` |
| `spike3.mjs` | 量測主程式，設定見檔頭（cur、o0、plain、san、sanrec、sandebug、plainpch、sanpch、depth、fidelity） |
| `run_s0.sh` | lab-david 上的完整流程：等教室沒人、worktree 切到 42b297e9、建 frontend-builder image、逐一跑所有設定、刪 image、打包結果 |
| `traces.mjs`、`run_traces.sh`、`kill_traces.sh` | 設計稿用的完整軌跡（san、sanrec）。`run_traces.sh now` 與主流程並行（1 CPU） |
| `fid2.mjs`、`run_fid2.sh` | fidelity 的補充實驗：CC-2607A/B 的原因（插樁後的原始碼、正式機流程、帶檔名的回報），以及 42 個有差異的程式逐步比完整軌跡，加一組只移動記憶體位置的對照組。結果在 `results-20261123/results-fid2.json`，摘要在規劃文件 §9 |
| `mockup/` | 錯誤圖解設計稿：`build_mockup.py` 從 `results-20261123/` 產生 `runtime-error-viz-v1.html`。規劃文件 §0 三個待決定事項的對照圖：`build_decisions.py` 套 `decisions-template.html` 產生 `decisions-v1.html`；使用者的選擇記在 `decisions-choices.json`（例如 `{"1": "A"}`），重跑就會標出 |
| `local-smoke-2026-11-23/` | 2026-11-23 在本機誤跑的 2 個案例（違反「測試一律在 lab-david」的規定）。只當可行性線索。當時的 `spike.mjs` 跑完後又加了 `plain` 分支，`san` 設定的行為沒有變；當時用的是 libc++ DEBUG 模式 |

## 在 lab-david 執行

```bash
# 本機（Git Bash）
D="C:/碩士/研究/papper/CPPcodeVisualizer/experiments/runtime-error-s0"
ssh lab-david 'mkdir -p ~/iris-a-tests/errspike'
scp "$D"/{cases.mjs,cases_v2.mjs,vgerr.h,assertion_handler.h,spike3.mjs,run_s0.sh} lab-david:iris-a-tests/errspike/
sha256sum "$D"/{cases.mjs,cases_v2.mjs,vgerr.h,assertion_handler.h,spike3.mjs,run_s0.sh} | cut -c1-12
ssh lab-david 'cd ~/iris-a-tests/errspike && sha256sum cases.mjs cases_v2.mjs vgerr.h assertion_handler.h spike3.mjs run_s0.sh | cut -c1-12'
# 兩邊的 sha256 一致後再啟動
ssh lab-david 'nohup bash ~/iris-a-tests/errspike/run_s0.sh > /dev/null 2>&1 < /dev/null &'
# 之後另開一次 ssh 讀結果：最後一行是 EXIT=<code>
ssh lab-david 'tail -n 20 ~/iris-a-tests/errspike/run.log'
```

完成後把 `s0-results-*.tgz` 拉回 `results-<日期>/`，再刪除 `~/iris-a-tests/errspike`。`run_s0.sh` 會記錄正式容器 `cppcodevisualizer-gdbgui-1` 執行前後的 StartedAt，以及 `/login` 的狀態碼，用來確認正式服務沒有被動到。

## 每個設定回答的問題

| 設定 | 問題 |
|---|---|
| cur / o0 | 現在的引擎（-O1）與改用 -O0，各能讓哪些錯誤被看到、怎麼被分類 |
| plain / san | 同一條管線不用 PCH，加檢查後哪些錯誤會被抓到、位置與運算元是否正確；編譯時間、wasm 大小、執行時間 |
| sanrec | 可繼續模式：溢位、C 陣列越界之後，程式是否照原生方式繼續、後果是否出現在軌跡 |
| sandebug | libc++ DEBUG 模式是否讓 `sort_user_cmp` 多出停點（預期會） |
| plainpch / sanpch | 用 PCH 時的實際編譯時間（引擎的預算是 8 秒） |
| depth | 1 MB 與 4 MB worker 棧下，加檢查前後的最大遞迴深度 |
| fidelity | 22 個 E3 程式＋`examples/` 中所有教案：加檢查前後的停點與輸出是否完全相同；列出本來就含 UB 的教案 |
