# E1 實驗（throwaway）：瀏覽器端 C++ 編譯器

**這是可行性實驗，不進正式服務路徑。** 結果見 `REPORT.md`。

## 重現

```bash
cd experiments/frontend-only/e1
npm init -y && npm i browsercc @bjorn3/browser_wasi_shim      # 編譯器與 WASI 執行環境（約 114 MB）
git clone --depth 1 --filter=blob:none --sparse https://github.com/gcc-mirror/gcc gcc-src
git -C gcc-src sparse-checkout set libstdc++-v3/include/ext libstdc++-v3/include/bits libstdc++-v3/include/std
```

- `driver.mjs`：照 browsercc 的 `compile()` 改成讀本機檔案（Node 20 的 `fetch` 不支援 `file://`），再用 WASI 執行。
- `mine/`：自備的 `bits/stdc++.h`、`bits/extc++.h`，以及 pb_ds 需要的相容層（`compat/`、`overrides/`）。
- `pbds.mjs` + `t6.mjs`：把 GCC 的 pb_ds 放進 sysroot，缺哪個 GCC 標頭就自動補哪個。
- `t2`（C++ 標準）、`t4`（stdc++.h）、`t6`（pb_ds）、`t8`（四份教案對照）、`t9`（大小／記憶體／例外）。
- `cases/`：測試程式；`cases/pbds_full.gcc-ref.txt` 與 `lessons/*.ref` 是**正式機 GCC 14.2** 產生的參考輸出。
- `t8` 需要 `lessons/<名稱>.cpp` 與 `.in`：來自 `examples/lessons/*` 各教案的 `.cpp` 與 `.json` 的 `program_input`。

不包含（太大或可重新取得）：`node_modules/`、`gcc-src/`。
