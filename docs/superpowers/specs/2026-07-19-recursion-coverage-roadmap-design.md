# 遞迴覆蓋路線圖 — 論文實作 Spec

**Date:** 2026-07-19
**Status:** Draft, pending user review
**Builds on:** `2026-06-23-callgraph-recursion-design.md`（已實作的 per-invocation 呼叫樹）
**Affects:** `gdbgui/src/js/CallGraph.tsx`, `Threads.tsx`（callTree 資料模型）, `LessonGenPanel.tsx`（prompt）, Monaco 整合, `examples/`（教案程式碼）

## 論文主張（這份 spec 存在的理由）

本系統對遞迴的**每一種型態**產生**可區辨的視覺簽名**，覆蓋完整的遞迴分類學
（taxonomy），並以「呼叫樹 × 資料結構同框動畫」提供文獻中現有系統
（SRec、Python Tutor、VisuAlgo）沒有的表徵。論證方式是覆蓋矩陣 +
2–3 個深度評估案例，不是範例數量。

對 SRec 的差異化：(1) GDB 驅動真實 C++ 執行，無需原始碼插樁；
(2) 呼叫樹與 STL 容器／BST 動畫同框；(3) `//@` 教案註解 + AI 教案生成管線。

## 遞迴分類學 × 教案 × 功能對應

| # | 型態 | 教案（examples/） | 視覺簽名 | 需要功能 |
|---|------|------------------|----------|----------|
| 1 | 線性遞迴 | `rec_sum.cpp` — `sum(4)` | 垂直鏈，回傳值逐層上冒 | F1 |
| 2 | 尾遞迴 | `rec_sum_tail.cpp` — `sumTail(4, acc)` | 同一值直通到頂（與 #1 對照） | F1 |
| 3 | 樹狀／多重 | `rec_fib.cpp` — `fib(4)` | 分叉樹 + 重複子問題標記 | F1 F2 |
| 4 | 互遞迴 | `rec_even_odd.cpp` — `isEven/isOdd(3)` | 兩函式名交替的鏈 | 無 |
| 5 | 巢狀遞迴 | `rec_ackermann.cpp` — `ack(1,3)` | 參數位置出現遞迴呼叫 | 無 |
| 6 | 結構遞迴 | `rec_bst_inorder.cpp` — 7 節點 BST | 呼叫樹形狀 ≅ 資料樹形狀 | F6 |
| 7 | 分治 | `rec_mergesort.cpp` — 4 元素 | 樹 + 容器切半動畫同步 | F1 F5 |
| 8 | 回溯 | `rec_maze.cpp` — 4×4 迷宮 DFS | 變淡分支 = 死路 | 無（@maze 已有） |
| 9 | 副作用型 void | `rec_hanoi.cpp` — `hanoi(3)` | 樹 + 三柱容器動畫 | F5 |
| 10 | 記憶化 | `rec_fib_memo.cpp` | 綠色 memo 取值節點，樹縮小 | F1 F2 F3 |

每個教案 ≤ 30 次呼叫（符合現有 CallGraph scope），並附完整 `//@`
註解（@guide/@tts/@layout），可直接作為課堂教材與論文附錄。

## 功能單元

### F1 — 回傳值上樹（demo 方案 B）

節點返回時顯示 `fib(2) ⇒ 1`（值以綠色粗體綴於函式名後）；返回發生的那一步，
父邊中點短暫顯示 `↑1`。

**取值機制（已決）：教案約定 result 變數。** 教學程式碼一律寫
`int result = ...; return result;`，呼叫樹在 invocation 從 live 轉
returned 時，讀取該層**最後一次 locals 快照**中的 `result`。

- `Threads.tsx` 的樹節點增加 `lastLocals` 緩存（僅 top frame 需要，
  每快照一筆，覆寫式，無歷史）。
- 約定寫入 `AUTHORING_GUIDE.md` 與 `LessonGenPanel` 的生成 prompt，
  AI 生成的教案自動遵守。
- 無 `result` 變數的節點退回現行為（只變淡）— 向下相容，非教案程式碼不受影響。

**否決替代案：** GDB 攔截回傳值（`-exec-finish` 的 result-var 或返回點讀暫存器）
— 可用於任意程式碼，但與 step/AnimScheduler 流程整合複雜、跨平台 ABI 邊界情況多。
論文場景全部是自控教案，約定即可。列為 future work。

### F2 — 重複子問題配對（demo 方案 C）

- 以 `func + 正規化 args` 建索引；同鍵可見節點 ≥ 2 時，各掛 `×N` 徽章（紅底白字）。
- hover 任一節點 → 同鍵節點加虛線琥珀框（`.twin`）。
- 對已返回的同鍵參數再次發生 call 時，舊節點紅框脈衝兩次
  （`prefers-reduced-motion` 時不脈衝，只上紅框一拍）。
- args 正規化：直接用 GDB 回傳的 args 字串（教案皆為 int 參數，字串相等即值相等）。

### F3 — memo 取值節點（demo 方案 D）

僅在教案以 `//@memo` 註解宣告時啟用（一行註解，掛在函式定義行；避免
naive 教案的重複 base case 被誤標）。啟用後，一個 invocation 若
**(a) 已返回、(b) 無子呼叫、(c) 存在同鍵且早於它返回的節點**，
即渲染為 memo-hit：綠框綠底、`memo` 徽章、顯示 `⇒ 值`。

- 同鍵節點中**第一個**返回且無子呼叫者視為 base case（正常渲染），
  之後的才標 memo-hit。`fib(1)` 第一次是 base case，第二次起是取值。

### F4 — 碼對應三件套

1. **點節點跳行**：click 呼叫樹節點 → Monaco `revealLineInCenter` +
   該行短暫高亮（沿用現有行高亮樣式）。節點已存 `line`，改動極小。
2. **呼叫點標示**：邊上綴小字標明來源呼叫點。資料來源：子 frame 的
   caller `line`（frames 已帶）；同一行多個呼叫點時（fib 的 `n-1`/`n-2`），
   以同行出現順序編號 `L3 ①` / `L3 ②`（addr 排序 = 呼叫指令順序）。
   不做反組譯、不解析原始碼運算式。
3. **Gutter 深度徽章**：Monaco gutter 於「目前停駐行」顯示遞迴深度
   `d=3`（decoration，一個，跟著執行點走）。不做全檔標注。

### F5 — 容器同步展示（hanoi / mergeSort）

無新引擎 — 現有 ContainerVisualizer + AnimScheduler 已能動畫容器。
本單元只做教案層整合：

- `rec_hanoi.cpp` 以三個 `std::vector<int>` 為柱，`//@layout` 指定
  呼叫樹與容器面板並排。
- `rec_mergesort.cpp` 以 `std::vector` 顯示切半／合併。
- 驗收：單一畫面同時看到呼叫樹步進與容器動畫，兩者由同一次 step 驅動。

### F6 — BST 同框（獨門，深度評估案例）

- **Phase 1（本 spec）：** `//@layout` 讓 CallGraph 與 BSTPlugin 並排；
  教案 `rec_bst_inorder.cpp` 的走訪順序使兩樹形狀對應可肉眼比對。
- **Phase 2（列入 spec、排程最後）：** 走訪函式的指標參數（`node*` 位址）
  對映 BSTPlugin 既有的節點位址 → 遞迴走到哪，資料樹的該節點同步亮琥珀。
  需要 CallGraph 將 args 中的位址值傳給 BSTPlugin 查表；BSTPlugin 已以
  位址識別節點，介面為單向「highlight(addr)」。

## 實作順序（論文路線圖）

| 階段 | 內容 | 產出 |
|------|------|------|
| P1 | F1 + F4-1（回傳值 + 點跳行） | 教案 #1 #2 立即可用 |
| P2 | F2 + F4-2/3 | 教案 #3（fib 核心課） |
| P3 | 教案 #4 #5 #8（零新功能，純教案） | 覆蓋矩陣過半 |
| P4 | F5 | 教案 #7 #9 |
| P5 | F3 | 教案 #10 |
| P6 | F6 Phase 1 → Phase 2 | 教案 #6（深度案例壓軸） |

每階段結束 = 對應教案可完整跑通 + e2e 快照。深度評估案例（論文）：
#6 BST 同框、#10 memoization、#8 回溯。

## 測試

- 單元：F1 result 提取（有/無 result 變數）、F2 配對索引、F3 heuristic
  （memo 版標對、naive 版 + 無 @memo 不誤標）。
- e2e：每教案一條 spec — 步進到指定步數，斷言節點狀態
  （沿用現有 e2e contract attrs；新狀態補 `data-` 屬性）。
- 手動驗收：demo artifact 的四個方案畫面為視覺基準。

## Out of scope

- SRec 式 DP 依賴圖／表格視圖（future work，論文可提）。
- 任意（非教案）程式碼的回傳值攔截。
- 呼叫數 > 30 的場景（八皇后、大 Ackermann）；permutations（與 #8 概念重複）。
- 樹的摺疊／縮放／拖曳。

## 修正紀錄（2026-07-19，P1 實測後）

- **F4-3 修正**：遞迴深度徽章改繪於**呼叫樹目前節點**（「第 N 層」小字），不做
  Monaco gutter 標注（後者依 Monaco 版本而定，列為 future work）。
- **F1 約定強化**：`result` 必須在函式最外層宣告一次（區塊內宣告在右大括號停駐點
  已出 scope，會凍到未初始化值）。
- **教案守則新增**（AUTHORING_GUIDE §1.3、§2.2）：全自動播放硬標準；賦值行不得
  自引用 `{變數}`；main 呼叫行必停兩次、用 `@2` 門檻分出發/返回。
- **多分支教案寫法（P2 起適用）**：每個遞迴呼叫獨立成行存入具名變數；斷點設函式
  入口；呼叫行一律 `[step-in]`（入口斷點攔下降、回程時等同 next）；呼叫行訊息
  寫方向中性（去程回程交錯無法用門檻區分）。

## F7 — 幽靈預跑（Ghost Pre-run，2026-07-20 新增）

**問題**：呼叫樹增量成長 + 置中佈局 → 新分支出現時祖先鏈平移跳動；置中佈局
需要「事先知道分支數」，執行中不可知。

**解**：教案是決定性的全自動程式 — Run 時後端先用 `gdb --batch` + Python 腳本
隱形快跑一次（rbreak 使用者原始檔的所有函式、每停一次記錄完整堆疊快照），
回傳快照序列；前端用**同一套** `ingestStack` 重建完整「幽靈樹」，以最終樹形
一次算好佈局。正式播放時每個 live 節點按 sig 對號入座 — **位置從頭到尾不變**，
未實現的節點以極淡虛線空框預告（不顯示內容，不爆雷值）。

要點：
- **Sig 對齊**：容器內 gdb 預設關 ASLR → 兩次執行位址一致；sig 中的位址先
  正規化（去 0x 後前導零）以消除 MI 與 gdb Python 的格式差。
- **安全**：endpoint 只讀 session（`uploaded_binary`/`real_src_path`/
  `exec_wrapper`/`uploaded_input`），完全不接受 client 參數；沿用 exec-wrapper
  jail（ulimit）；subprocess timeout + 快照數/輸出大小上限。
- **優雅降級**：預跑失敗／超時／教案吃 stdin 但無輸入 → 前端收不到幽靈樹，
  回退現行 live 佈局；live sig 與幽靈 sig 匹配率過低（發散）→ 忽略幽靈樹。
- 佈局函式從 CallGraph 抽出為純函式，live 與 ghost 共用。

## 風險

- **result 約定被教案違反** → 該節點退回變淡，不壞畫面；lesson-gen prompt
  加驗證規則。
- **同行呼叫點排序**依 addr 假設「位址序 = 原始碼序」— 同一行內編譯器不重排
  呼叫指令（C++ 求值序自 C++17 起 `+` 兩側仍 unsequenced，但 call 指令位址
  順序穩定；標籤只求可區辨，順序錯置不影響正確性語意）。
- **F6 Phase 2** 依賴 BSTPlugin 位址表的可查性 — Phase 1 先行，Phase 2
  可獨立砍掉而不影響覆蓋主張（同框並排已成立）。
