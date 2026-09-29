# M1 層 B 真實 UI 驗收報告（技巧一，本機 Docker，Chrome 前景）

環境：本機 `docker compose`（映像檔含本 repo 的 `gdbgui/static/engine` 與 `gdbgui/src/js/localEngine.ts`），App `127.0.0.1:5000`，登入用我建立的本機測試帳號；瀏覽器為使用者的 Chrome（前景視窗）。
驅動：`tests/engine/browser/proxy.mjs`（把驅動腳本注入 App 頁面）＋`autorun.js`（匯入技巧一 → 開自動播放 → Run → 攔截 `store.set` 記錄事件），手動單步用 `ui_drive.js`。兩個引擎用同一份腳本：`?engine=gdb`（伺服器 GDB，旗標關閉的原路徑）與 `?engine=wasm`。

## 結果

| 項目 | 結果 |
|---|---|
| wasm 引擎在真實 UI 端到端運作 | ✅ 引擎模組載入、編譯、LocalGdb、停駐、`continue` 到斷點、容器視覺化（cost／dp／nxt）、終端機輸出 |
| 手動單步 `next`（10 步，含 `for` 迴圈） | ✅ 停駐行 10/10 相同；`for_sub_step` 的 A／B／C 三段狀態 10/10 相同；位址對映修正後一致 |
| 區域變數（每步） | ✅ 除 `start`、`r`（未初始化：GDB 垃圾值、我們 0，允許差異）外完全相同 |
| 完整自動播放（前景，含 `[fast @N]`、斷點 51／57） | ✅ 兩者都跑到結束；事件序列相同（僅 GDB 多一個冗餘 `L37`）；見下方「最終驗收」 |
| 最終畫面／程式輸出 | ✅ 視覺化面板文字相同；標準輸出 `3 2 2 1 / 6` 相同 |
| 耗時 | wasm 86 s、GDB 110 s（本機） |
| 旗標關閉（`?engine=gdb`）回歸 | ✅ 走原路徑，與先前行為一致；jest 全套 686 通過 |

## 最終驗收（層 B 修完三項 P3 後、重建映像重跑；證據檔在 `evidence/`）

**手動逐步（`?mode=manual`：Run → continue 到斷點 31 → next ×70，每步等面板文字穩定 1.2 s 後取快照；71 步）**
`evidence/m1_ui_manual_steps.jsonl`（mwasm／mgdb）：
- 停駐行差異 **0**；`for_sub_step`（A／B／C）差異 **0**；
- 視覺化面板（cost／dp／nxt 的全部格子文字）差異 **0**（71 個面板全部有內容，不是空面板的空洞比對）；
- `data-*` 屬性統計（e2e 契約屬性）差異 **0**；
- 區域變數差異只出現在**尚未執行到初始化語句**的讀取（`start`、`r` 全程；`i` 在第 37 行 for 初始化前；`best`／`bestRow` 在第 38～40 行 `int best = INF, bestRow = 0;` 之前；`k` 在第 41 行前）：GDB 顯示殘留垃圾值、我們顯示 0（D6 允許差異），已逐項對照原始碼行。

**完整自動播放（前景）**`evidence/m1_ui_autoplay.jsonl`（wasm3／gdb3）：
- 事件序列（攔截 `store.set`）壓縮後 wasm 768、GDB 769，最長共同子序列 768，僅 GDB 多一個冗餘 `L37`（內層 for 結束、UI 處於虛步 B 時的同行重設；驗證者判斷為 `Threads.update_stack` 一類的晚到重設，LocalGdb 合理省略）；
- 去重後停駐行序列 323／323 **完全相同**；A／B／C 三段序列 108／108 **完全相同**；終端機輸出相同；
- 導引行快照（固定等 1.8 s）有 3 處面板文字不同，屬時序（自動播放在 wasm 較快、取快照時進度不同），已由上面「等畫面穩定」的手動逐步比對取代，該比對為 0 差異。

**修掉的 P3**（驗證者發現）：連按兩次 Run 不再讓 UI 停在編輯模式；引擎載入暫時失敗後下一次 Run 可恢復（LocalSocket 可重開）；LocalGdb 對 `kill` 回 `^done`，不再在切換編輯模式時印出假的錯誤行。

## 過程中找到並修正的缺陷

1. **偽位址語意（層 A）**：UI 的 `for` 三段式虛步用 `frame.addr` 判斷初始化段（A）或遞增段（C），假設 A 位址 < C 位址；LocalGdb 對同一行的所有停駐給同一位址，導致每個停駐都被當成 A，多出虛步。黃金樣本重放把位址列為允許差異，所以只有真實 UI 看得出來。已修：位址依行號單調、同一 `for` 行的遞增停駐位址高於初始化停駐、不同呼叫點的返回位址相異，並新增測試（含逐字複製 UI 的 `decideForSegment` 對照黃金樣本的分類）。

## 方法上的限制（誠實揭露）

- 自動化控制的分頁是**背景分頁**：計時器與 TTS 被節流，自動播放近乎停擺。所以自動播放驗收改用代理注入、在使用者的前景視窗執行。
- 一秒一次的取樣會漏掉快速轉換並抓到暫態，兩引擎的取樣序列因此有 15 處假差異；改為攔截 `store.set` 才得到事件層級的可靠比對。
- 手動單步的「面板文字」在前幾步有渲染時序差異（容器由非同步輪詢建立，wasm 回應較快所以出現時機不同），穩定後相同；最終畫面比對為穩定後的結果。
- 只驗證了技巧一這一份教案；快速題（課堂題目）、隨機測資、UML、TTS 音質、其他 22 份教案、Firefox／Safari、慢筆電**均未測**。
- 冷啟動：第一次載入需下載約 95MB 資產並編譯（本機 localhost 約 7～10 s 到停在 main）；第二次由 IndexedDB 快取。
- 使用者的即時課堂功能（QR、熱區）依賴伺服器 session，本次關閉「即時課堂」未測。

## 尚待處理／已知缺口

- 伺服器沒有對 `.wasm`／`.tar` 壓縮（首次載入傳 42MB+ 未壓縮）；`static` 目錄不需登入即可讀；`assets/` 被 git 忽略，Dockerfile 只靠本機檔案，乾淨 clone 建出的映像檔會 404。均為部署項目，未處理。
- 原始碼視圖（舊 gdbgui 檢視）在 wasm 模式沒有語法顏色（Pygments 只在伺服器）。
- 不支援互動輸入；`for` 行的斷點每次迭代都停；map／set／deque 等型別回明確的「不支援」。

## 教案覆蓋掃描（22 份，真實 UI，兩個引擎逐份比對）

方法：隔離的 Chrome 執行個體（自己的暫存設定檔、關閉背景節流、靜音；`proxy.mjs` 注入 `autorun.js`），每份教案「Run →（教案有斷點才先 continue）→ next ×30，每步等面板穩定再取快照 → continue 到結束」，wasm 與伺服器 GDB 各跑一次。固定亂數種子讓內建隨機測資一致。GDB 基準因伺服器對「同一帳號連續快速換教案」不穩，改成每份教案前重啟本機測試容器單獨跑。分類腳本：`node tests/engine/browser/report_lessons.mjs`；原始資料：`evidence/`。

| 結果 | 份數 | 教案 |
|---|---|---|
| 行序列、輸出、區域變數、容器畫面全相同 | 10 | DP課3、deque BrokenKeyboard、因數抽血、迴文判斷、矩陣轉置、考拉斯猜想、貪婪找零、技巧一、走方格 AtCoder、走方格 DP 推導 |
| 行為相同，但有功能缺口 | 7 | **幽靈呼叫樹**（wasm 無）：DP課4、DP課5、快速排序、技巧二、硬幣解析、SWAP；**`std::stack` 不畫**：Rails |
| 有行為差異 | 1 | 走迷宮 BFS：`if` 條件跨兩行（第 35～36 行），GDB 依編譯後的行表在兩行之間來回停駐，引擎的插樁只在條件起點停一次（已知精度差距）；另外 `std::queue` 不畫 |
| GDB 基準無效（wasm 正常跑完） | 4 | DP課1、DP課2、串列走訪（`std::list` 不畫）、氣泡排序 |

**過程中找到並修掉的行為缺陷（LocalGdb）**
1. `next`／`step` 在「呼叫子函式之後、同一行又出現一次」時多停一次（迴文判斷：GDB `18→22→23`、我們原本 `18→23→22→23`）。已修，迴文判斷現在與 GDB 相同。
2. 放在 `for`／`while` 標頭行的斷點原本每次迭代都命中，改成只在進入迴圈時命中（依據：Rails 教案 bundle 內記錄的真實 GDB 命中次數 `times:5`）；Rails 現在與 GDB 一致。
3. 新增「全教案語料回歸測試」`tests/engine/localgdb/lessons_corpus.test.mjs`：13 份有效 GDB 基準的教案，LocalGdb 的行序列與錄到的真實 GDB 序列逐一相同，wasm 錄到的序列也相同（迴文判斷除外，已記錄為修復前的差異）。

**換測資重跑（快速題／隨機測資會做的事）**：技巧一走 3 步 → 用固定種子按 🎲 → 再按 Run（LocalSocket 取代舊 session）→ 走到結束。兩個引擎得到同一份新輸入，重跑後的停駐行序列相同，容器顯示新資料。

**尚未驗證**：即時課堂／快速題的完整流程（老師出題、學生作答、收卷、熱區）依賴伺服器 session，本次只驗證了它依賴的兩個前端條件（容器內容相同、換測資重跑）；課堂中途學生斷線、多人同時作答等未測。

**已知功能缺口（依影響排序）**
1. ~~幽靈呼叫樹~~：**2026-09-28 已完成**（commit `2412182`）。從軌跡直接推導 `/api/prerun_calltree` 的 snapshots 形狀；第一輪驗證抓到 addr 配方不對（幽靈樹跟真人除錯的位址對不起來，踩第一步後就被判定失配而消失，所有既有測試卻是綠的），已修正（改用 `model.retAddr`，跟真人除錯用的同一個函式），第二輪驗證 CONFIRMED，補了「真的跑一次 session 拿即時簽章去對照幽靈樹簽章」這種能抓到此類問題的回歸測試。DP課4、DP課5、快速排序、技巧二、硬幣解析、SWAP 這 6 份的呼叫樹疊圖應該能顯示了——**尚未在真實 UI 上重新跑這幾份教案確認**（跟容器視覺化那項一樣，只驗證到 LocalGdb 協定/MI 層，沒有走瀏覽器）。
2. ~~`std::queue`／`std::stack`／`std::list`／`std::deque` 容器的視覺化~~：**2026-09-28 已完成**（commit `9b2c5e4`）。對照正式機真實 GDB 的 pretty-printer 輸出逐位元組核對；新增 `tests/engine/localgdb/containers.test.mjs`。Rails、走迷宮（容器部分）、串列走訪現在應該能畫了——**尚未在真實 UI 上重跑這三份教案確認**（本項只做了 LocalGdb 協定層的單元/整合測試，沒有走瀏覽器）。
   - ~~`std::map`／`std::set`／`std::priority_queue`／`std::unordered_*`~~：**2026-09-29 已完成（簡化版）**。原本完全不支援（wasm 引擎連 varobj 都建不起來）；用意選了「排序後的鍵值清單」而非完整紅黑樹動畫（`ContainerVisualizer.tsx` 蓋到一半晾著的 `fetchRBTreeData`/`__rbtree_data` 死碼已一併清掉）。`LocalGdb`（`types.js`/`varobj.js`）新增 set/map/priority_queue 的 varobj 支援，對照正式機真實 GDB 逐欄位核對（`-var-create`/`-var-list-children`/`-var-update`）；`LinearPlugin.tsx` 新增 set/map/unordered_map 渲染。已知簡化：①priority_queue 的子項是我們自己 top()/pop() 抽出的優先序，不是 GDB 顯示的原始 heap 陣列排列（vg.h 沒有能力讀原始 heap 記憶體，只能走訪）；②unordered_* 走 wasm sysroot 自己的雜湊桶順序，不保證跟原生 GDB 對同一組輸入一致；③set/map/multiset/multimap/unordered_set/unordered_multiset/unordered_map/unordered_multimap 的「N elements」值文字全部共用同一句（不逐一分辨變體），因為這串只會被 regex 抓數量，UI 不會顯示。**尚未在真實 UI 上跑過用到 map/set/priority_queue 的教案確認**（同上，只做了協定層測試）。
3. ~~跨行條件的停駐精度（走迷宮）~~：**2026-09-29 查證後決定不修**。原本以為是「GDB 在第 35、36 行各乾淨停一次，引擎只停一次」這種可修的語意缺口，實測（`docker exec` 起真實 GDB、`gdb -batch -x` 逐 `next` 單步）發現不是——同一次條件判斷（d=0、`nr=nc=0`、`maze[0][0]=1` 導致整個 if 為假）GDB 的停駐序列是 **35→36→35→36→35→33**，來回跳了 5 次，是 GCC `-O0` 把短路 `&&` 的跳轉目標分配到哪一行的編譯器內部細節，不是一條乾淨、可用位址或語法判定的規則（不像 for 迴圈 A/B/C 三段式那樣），換一版 GCC 或換一組 maze 輸入停駐次數很可能就不同，等於要逐位元組模擬特定 GCC 版本的 codegen，成本與可驗證性都不合理。掃過全部 22 份教案的跨行 if/while 條件續行，**沒有任何一份掛了 guide/TTS/layout 內容**——目前這個差異對學生完全不可見，只是 debug 高亮在兩行之間會不會閃一下的視覺細節，而且真實 GDB 自己的閃法還比較亂。故意不修，維持現狀；若未來有教案真的在續行掛內容再重新評估。
4. **真實瀏覽器待驗收清單（2026-09-30 更新，依優先度排序）**：
   - ~~`std::map`／`std::set` 容器 widget 卡在空的~~：**2026-09-30 已修好，commit 見下**。根因追到底：容器視覺化面板（`ContainerVisualizer.tsx`）讀的 `__latest_containers` 是 `VisualizerHelper.js` 的 `processing_guide()`/`checkStore()` 算出來的，而那段邏輯是**逐行 token 驅動、只算一次**——只有「目前這一行的 `@guide` 文字剛好引用 `{容器名}`」時才會重算。has_more 修好之後，`numchild`/`children` 常常是插入那一行**之後**才非同步到位；如果教案沒有在後面每一行都重複寫 `{容器名}`，widget 就會永遠卡在插入當下讀到的空狀態，即使底層 var-object（`store.get('expressions')`，跟區域變數面板共用同一份）早就正確補齊了子節點。這不是 map 專屬缺口，`set` 用容器 widget 一樣卡住（上一輪「set 沒問題」的結論其實是拿 Locals 面板手動展開測的，不是容器 widget，是誤判）——整個動態容器家族（set/map/deque/stack/queue/pqueue）共通。
     修法：`ContainerVisualizer.tsx` 的 `_pollContainers()`（本來就每秒跑一次）新增 `_healStaleEmptyContainers()`——輪詢時對照一次快取是不是空的、但底層 var-object 已經有跟 `numchild` 對得上的完整 `children`，有的話直接用跟 `VisualizerHelper.js` 相同的 parser（`containerParsers/index.js` 的 `resolveChildValues`）重新解析、蓋掉舊值，不必等下一次剛好有 guide token 命中同一個容器。刻意只處理「快取是空的、底層已經完整」這個已知會卡死的模式，不去動「已經非空的容器繼續變化」這種原本 guide-token 路徑通常還是追得上的情況，把改動範圍鎖到最小。
     驗證：`ContainerVisualizerStaleEmpty.jest.ts` 三個案例（快取空+底層完整→補上、底層還沒載完→不誤補、容器本來就非空→不去動它）；真實瀏覽器重現原本的卡死案例（`{x}` guide 只掛在插入那一行、後面完全沒有再引用），map 跟 set 都確認從卡死變成正確畫出（map 顯示 `size 1 / KEY 1 VALUE 10`，set 顯示 `size 1 / {5}`）。
   - ~~幽靈呼叫樹 5 份教案未在真實瀏覽器驗證~~：**2026-09-30 全部 5 份確認完畢**。協定層已修好（commit `2412182`），quicksort 早就驗證過。DP課4、DP課5、硬幣所有解析法（用 `gv.__ghost.nodes.length`/`data-ghost="1"` DOM 數量確認正確，硬幣解析法有一個不相關的小 cosmetic bug——某個呼叫樹節點標題殘留未解析的 `{expr}` 佔位符，未追）；技巧二（`examples/lessons/技巧二_記憶化搜尋_UVA10285`，先前在 `verify_test` 帳號教案庫找不到，這次用 `scripts/import_lessons.py 81` 補匯入全部 22 份範例教案才找到，lesson id 134）跟 SWAP（`函式_SWAP寫法`，lesson id 132，先前多次卡在 restart 後 `inferior_program` 停在 `unknown`/`running` 不動——這次用乾淨的 `ref` 點擊＋夠長的等待〔8 秒〕成功重現，不確定是環境偶發還是之前用了不穩定的 raw pixel 座標，總之這次順利成功）這 2 份這次補測，`gv.__ghost` 都正確產生 `main→目標函式` 的節點/邊，畫面上的呼叫歷史圖/TTS 旁白也對得上。
   - **走迷宮 `std::queue` 容器渲染——過程中挖到一個真的 crash，已修好；容器畫面本身沒能在真實瀏覽器完整驗證**：容器支援已在協定層修好（commit `9b2c5e4`）。這次實測（`queue經典_老鼠走迷宮`，lesson id 124）在 `solveMaze()` 第 20/21 行（`{q}{maze}` 的 guide）時，瀏覽器 console 直接丟出 uncaught `TypeError: Cannot set properties of undefined (setting 'show_children_in_ui')`，整個 processing_guide 任務中斷（跟其他容器 bug 不一樣——這個是提早在抓子節點那一步就當掉，根本沒走到判斷空/非空那一步）。
     根因：`GdbVariable.tsx` 的 `fetch_and_show_children_for_var()` 是檔案裡**唯一**一個呼叫 `get_obj_from_gdb_var_name()` 卻沒有檢查回傳值是否為 `undefined` 就直接寫入欄位的地方（其他四處呼叫都有 `if (obj) {...}` 守門）。`maze` 是 11×11 的大 2D vector，好幾行的 `@guide` 都同時引用 `{maze}`，短時間內同一個表達式被多個 guide token 各自觸發 delete+recreate，晚到的 `-var-create` 回應對應到已經被刪除的舊 var 時就會炸掉。
     修法：補上跟其他四處一致的 `if (!obj) return;` 守門，安靜跳過（比照 `gdb_created_children_variables()` 對同一種情境的既有處理方式），不擋住畫面上已經指向新 var 的資料。新增 `GdbVariableQueue.jest.ts` 兩個案例（var 不存在時不拋例外、var 存在時行為不變）；`npx jest` 699 全過。
     **容器渲染本身（BFS 過程中 queue 的即時內容）這次沒能在真實瀏覽器完整跑完確認**——找到並修好這個 crash 之後，這一輪的瀏覽器環境（開了大量分頁做其他項目的驗證，累積下來疑似資源吃緊）反覆卡在「restart 之後 `inferior_program` 停在 unknown，怎麼點都沒用」，換了 4、5 個全新分頁都一樣，跟今天稍早 SWAP 教案遇到的那種偶發性 restart 卡住不是同一種——那種通常點兩三次就會好，這次是持續性的。修復本身有把握是對的（原因見上，且有回歸測試鎖住），但「BFS 主迴圈跑起來之後 queue 波浪式展開的畫面對不對」這件事還沒能親眼在瀏覽器裡看到，下次接手建議先確認瀏覽器分頁數量降到個位數、必要時重開一個乾淨的 Chrome profile 再測。
   - ~~`queue<pair<int,int>>`（走迷宮 BFS 隊列本身）在引擎層被整組拒絕，`-var-create` 直接回傳「type 不支援」~~：**2026-09-30 已修好**。追根結果是另一個獨立缺口，跟上面那個 crash 不是同一件事——`types.js` 的 `classify()`/`isSupported()` 完全沒有處理「`std::pair` 作為容器元素型別」這個 case（`queue<pair<int,int>>`、`vector<pair<int,int>>` 等全部中槍；map 的 key/value pair 是另一條路徑，不受影響）。對照真實 GDB（`gdb --interpreter=mi -q ./binary`，MI 指令走 stdin、必須手動送 `-enable-pretty-printing`，不能用 `-ex` 批次模式，那個是走 CLI 直譯器不認得 MI 指令）：裸 pair 是葉節點（`numchild="0"`），值是 `{first = X, second = Y}`，不是聚合展開。`vg.h` 的原生序列化不用改（`is_pair<T>` 已經是通用遞迴處理）。修法：`types.js` 的 `classify()`/`isSupported()` 補上 `"pair"` case；`model.js` 的 `valueOf()`（給 `-var-create`/`-var-update` 用）跟 `types.js` 的 `printValue()`（給 `-data-evaluate-expression` 用，一開始漏了這條路徑，補測試時才抓到）都補上對應的 `{first = ..., second = ...}` 格式化。新增/更新測試：`containers.test.mjs`、`types_scopes.test.mjs`、`commands.test.mjs`（`m` 這個裸 `pair<int,int>` fixture 變數從「應該被拒絕」改成「應該成功，值是 `{first = 2, second = 0}`」）。
     驗證：`node --test --test-concurrency=1 tests/engine`（356 pass / 0 fail）＋ `npx jest`（699 pass）。真實瀏覽器這輪再度卡在「Auto 播放後 `inferior_program` 停在 running、怎麼等都沒有 stop event」（換了全新分頁、確認不是 beforeunload 對話框殘留造成，`window.store` 查詢正常回應，只有除錯執行本身卡住），懷疑跟上面幾項同一種環境問題，非這次改動引入——改用**直接從正式資料庫撈這份教案真正的 `source_code`／`program_input`／中斷點**（`sqlite3` 讀 `lesson_versions.bundle_json`，lesson id 124 對應 version 129），寫一支一次性 Node 腳本（`eng.runProgram(SRC, STDIN)` + `newGdb` + 在第 40 行斷點上重複 `-var-update`/`-var-list-children`/`-exec-continue`）直接跑同一份真實教案，6 秒內編譯＋追蹤完成、BFS 迴圈跑起來後 `q` 正確從 1 個元素長到 2 個、每個 pair 元素正確顯示 `{first = X, second = Y}`（例如 `{first = 1, second = 1}` → `{first = 1, second = 2}` → … → 長出 `{first = 2, second = 3}`），`has_more`/`new_num_children` 都對——這條路徑繞開了瀏覽器環境問題，但用的是跟瀏覽器完全相同的引擎程式碼（`gdbgui/static/engine/localgdb/*.js`）跑同一份真實課堂教案的真實輸入，可信度視同瀏覽器驗證。
   - **Rails `std::stack` 不畫，根因未修**：已證實不是 wasm 專屬缺口（`?engine=gdb` 一樣不畫），根因鎖定在 `VisualizerHelper.js` 的 `train` varobj 從未被建立（guide 綁在第 27 行、一個迴圈條件式），但依使用者指示暫停，沒有查完。下次要用瀏覽器 DevTools 斷點單步 `processing_guide`/`graphics_instruction`，不要用黑箱外部觀察（這輪查 map 異常時吃過同樣的虧，教訓一致）。
   - **`std::list` 走訪異常，未查完**：`list_walkthrough.json`（`push_front`/`push_back` 之後應有 5 個元素）兩個引擎都顯示空/數量不對，但比對方法不夠嚴謹（單步時機可能沒讓兩引擎真的停在同一行），沒有下結論，需要更嚴謹的同行比對方法重測才能判斷是不是真的缺口。
