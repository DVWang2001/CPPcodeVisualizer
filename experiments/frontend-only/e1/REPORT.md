# E1 實驗報告：瀏覽器端 C++ 編譯器（clang → WebAssembly）

日期：2026-09-25　狀態：**E1 在 Node 環境完成，瀏覽器實測尚未做**　性質：throwaway 實驗，不進正式服務路徑

## 結論（一句話）

**Go（附條件）**：候選 `browsercc`（clang 20.1.2 → WebAssembly）在 Node 裡能編譯並正確執行四份真實教案，C++17／20／23、自備的 `bits/stdc++.h`、pb_ds 常用子集都通過，且輸出與正式機 GCC 14.2 **逐行相同**；傳輸量遠低於門檻。條件是：(1) 瀏覽器內的冷啟動、快取、記憶體還沒實測；(2) `try`／`throw`／`catch` 無法使用；(3) 授權與維護風險要處理。

## 候選方案

| 方案 | 授權 | 狀態 | 本次是否實測 |
| --- | --- | --- | --- |
| **browsercc**（BertalanD） | MIT | npm 0.1.1，2025-04-19 發布，10 個 commit，單一作者 | ✅ 全部實驗用它 |
| Emception（jprendes） | MIT／Apache-2.0 | 92 個 commit，日期未確認 | ❌ 沒測（見「後續」） |
| binji/wasm-clang | Apache-2.0 等 | 作者自稱「alpha demoware」，來自 2019 | ❌ 不建議 |
| xeus-cpp | — | 未評估 | ❌ |

編譯器實測版本：**Clang 20.1.2**，目標 `wasm32-unknown-wasi`，用 libc++。

## E1a 基本編譯與大小

| 標準 | 結果 |
| --- | --- |
| C++17（optional、結構化綁定、`if constexpr`） | ✅ |
| C++20（concepts、ranges、views） | ✅ |
| C++23（`std::expected`） | ✅ |

- **必須加 `-fno-exceptions`**：C++20／23 的部分標頭引用了例外處理函式，不加會在連結階段失敗（`__cxa_allocate_exception`）。
- **編譯時間（Node，冷，每次重新實例化編譯器）**：編譯 1.6～3.2 秒、連結約 0.27 秒；四份教案都在 2.4 秒內。
- **傳輸大小**：未壓縮 95.6 MB → gzip-9 **29.8 MB** → brotli-11 **20.6 MB**（含我們額外加入的 pb_ds 與自備標頭約 0.1 MB）。門檻是 ≤ 100 MB、目標 ≤ 60 MB，✅。
- **記憶體**：編譯一次教案，Node 行程增加約 293 MB。
- 授權：browsercc 是 MIT；LLVM／libc++／wasi-libc 底層是 Apache-2.0 附 LLVM 例外（以及 wasi-libc 的 MIT／BSD 部分），**套件內沒有附授權文件**，正式使用前要補上。

## E1b `<bits/stdc++.h>`

browsercc 自帶的版本只有 22 個 `#include`，不完整（`stringstream`、`setw` 找不到）。我改寫成完整版（`mine/stdc++.h`）：照 GCC 的分組與 `-std` 版本判斷。

- 110 個標準標頭逐一測過，C++17 與 C++20 都是 **102 個通過、8 個失敗**：`csetjmp`、`csignal`（WASI 限制）、`cstdalign`，以及這版 libc++ 還沒有的 C++23 標頭 `spanstream`、`stacktrace`、`generator`、`flat_map`、`flat_set`。
- 自備的 `stdc++.h` 排除了這幾個。用同時使用 `vector`、`map`、`set`、`deque`、`unordered_map`、`priority_queue`、`bitset`、`stringstream`、`iomanip`、`accumulate`、`mt19937` 的程式驗證，C++17／20／23 **輸出全部正確**。
- 不需要預編譯標頭，編譯約 2.5～3.2 秒。

## E1c `<bits/extc++.h>`（常用子集）

pb_ds 是 libstdc++ 專有，直接用會失敗。做法 (a)：搬入 GCC 的 pb_ds 原始碼（243 個檔案，1.6 MB，GPLv3＋GCC Runtime Library Exception），加一層很薄的相容層：

- `bits/c++config.h`：`_GLIBCXX_*` 巨集，以及 `-fno-exceptions` 下的 `__try`／`__catch`／`__N`。
- `tr1/type_traits`、`tr1/functional`：指向 C++11 標準版本。
- `debug/debug.h`：斷言巨集關閉。
- 另外自動帶入 GCC 的 `ext/typelist.h`、`ext/type_traits.h`、`ext/numeric_traits.h`、`bits/cpp_type_traits.h`、`bits/version.h`。

**測試（`cases/pbds_full.cpp`，16 行輸出）在 C++17／20／23 下與正式機 GCC 14.2 逐行相同**，涵蓋：
- `tree`：`find_by_order`、`order_of_key`、`erase`、`lower_bound`／`upper_bound`、pair 當鍵、`less_equal` 當可重複集合、預設 tag 當 map 用。
- `gp_hash_table`／`cc_hash_table`：`operator[]`、`find`、`erase`、迭代。
- `priority_queue`：`pairing_heap_tag`（預設）、`binomial_heap_tag`、`thin_heap_tag`，`push` 回傳迭代器、`modify`、`join`、`pop`。

**尚未涵蓋**：`bits/extc++.h` 裡其餘的 `ext/` 標頭（`rope`、`slist`、各種 allocator、`vstring`…）沒有測，也沒有放進我們的 `extc++.h`；`trie_policy`、`list_update_policy` 只被 `#include` 而沒有使用測試。

## 真實教案對照（四份，C++17 與 C++20）

| 教案 | 輸出 | 與正式機 GCC 14.2 |
| --- | --- | --- |
| 技巧一 | `3 2 2 1` ／ `6` | ✅ 相同 |
| 技巧二 | `7` | ✅ 相同 |
| 走方格_AtCoder_Grid1 | `3` | ✅ 相同 |
| 走方格_DP推導 | `3` | ✅ 相同 |

## 已知限制（WASI）

- **`try`／`throw`／`catch` 無法編譯**（`cannot use 'throw' with exceptions disabled`）。現有 23 份教案的 `.cpp` 沒有任何一份使用。
- **例外變成中止**：`vector::at` 越界不會拋 `std::out_of_range`，而是印出訊息並 trap（GCC 會 `terminate called after throwing…`）。行為不同，但都會終止。
- `<csetjmp>`、`<csignal>` 不可用。
- 現有 23 份教案沒有 GCC 專有語法（`__builtin_*`、`__int128`、`#pragma GCC`）；`__builtin_*` clang 支援，`__int128` 在 wasm32 上待測。

## 沒做／沒驗證的（重要）

1. **所有時間與記憶體都是 Node 量的**，不是瀏覽器。瀏覽器的冷啟動（下載＋編譯 43 MB 的 clang.wasm）、第二次從快取啟動 ≤ 3 秒、Web Worker 內的表現、Firefox／Safari 都還沒測。
2. Emception（Emscripten，**支援 C++ 例外**）沒有實測，作為 browsercc 的備案。
3. 學生實際的筆電（較舊、記憶體較小）還沒量。
4. 授權需人工複核：套件沒附授權文件；pb_ds 的 GPLv3＋Runtime Library Exception 要確認散佈方式（我們散佈的是標頭原始碼，並保留原授權標頭）。

## 風險

- **維護風險**：browsercc 最後發布是 2025-04，單一作者、10 個 commit。緩解：我們只依賴它的編譯產物；它附有 Docker 建置腳本，必要時可以自己重建（LLVM 20.1.2）。
- **相容層風險**：pb_ds 是搬入 GCC 的原始碼並補相容層，之後升級 libc++ 可能要重測。

## 如何重現

見 `README.md`（同資料夾）。腳本：`t2`（C++ 標準）、`t4`（stdc++.h）、`t6`（pb_ds 自動補標頭）、`t8`（四份教案對照）、`t9`（大小、記憶體、例外）。
