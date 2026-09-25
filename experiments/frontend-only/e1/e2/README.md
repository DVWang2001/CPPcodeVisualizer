# E2 實驗（throwaway）：原始碼插樁 vs GDB

結果見 `REPORT.md`。這個資料夾**放在 `e1/` 底下**，因為它重用 E1 的 `driver.mjs` 與 `node_modules`（先照 `../README.md` 安裝）。

```bash
cd experiments/frontend-only/e1/e2
node instrument.mjs ../../../../examples/lessons/技巧一*/tsp_uva116.cpp      # 看插樁後的程式（輸出 instrumented.cpp）
node trace.mjs <教案.cpp> <輸入檔> main[,solve]                              # 編譯、執行、收集探針 → trace_<名稱>.json
node compare.mjs trace_tsp.json ref/ref_tsp.json                             # 停駐行序列比對
node compare_values.mjs trace_tsp.json ref/ref_tsp.json '[{"name":"h","line":22},{"name":"w","line":22}]' 34,48,51,57
```

- `ref/ref_*.json` 是**正式機 GDB 16.3 ＋ g++ 14.2** 對同一份輸入擷取的參考答案（`gdbref.py`：`REF_MODE=next|step`、`REF_IN`、`REF_OUT`）。
- 沒有初值的變數（如 `int h, w;`）在賦值前 GDB 顯示垃圾值，用第 3 個參數排除。
