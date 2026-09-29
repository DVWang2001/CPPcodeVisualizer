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
4. **真實瀏覽器待驗收清單（2026-09-29 整理，都還沒解決，依優先度排序）**：
   - **`std::map` 容器渲染異常，根因未查出**：`has_more` 既有 bug 修好（commit `9eff55e`）後在真實瀏覽器複驗時發現，`set`/`deque` 用完全一樣的手法（單步、同一帳號、同一分頁）都正確從空的畫到有值，唯獨 `map<int,int> m; m[2]=20;` 單步跑完後畫面卡在 empty。用 `node --test` 逐位元組重現瀏覽器實際送出的整批 MI 指令，引擎端每次都正確回報變化——證明修復本身沒問題；但瀏覽器裡 APP 自己既有的 `console.log('changelist = ...')` 證實 changelist 連續 5 次輪詢都是空陣列，不是觀測錯誤。嘗試從 `varobj.js` 內部用 `BroadcastChannel` 送診斷訊息出來完全沒有任何訊息送達，沒查清楚是訊息被擋住還是那段程式碼根本沒被執行到（也還沒查清楚 `createLocalGdb` 實際跑在主執行緒還是某個 Worker）。懷疑方向：①APP 實際的 restart 指令帶 4 個怪異負數行號斷點，可能觸發 `fastForward.ts` 的快轉路徑，讓「按一次 next」不等於「走一個 trace step」——**已排除**：那 4 個負數行號斷點（`frontend_1`～`frontend_4`，`-9`/`-6`/`-3`/`0`）確實存在，是先前測試反覆換程式內容時 gutter 誤觸留下的殘留標記，清空 `store.get('breakpoints')` 重測後異常依舊，跟它們無關；②`map` 的 `displayhint:"map"` 是全新值（其他型別都用 `"array"`/無/`"string"`），可能有下游程式碼對它反應錯誤，**尚未排除**。

   **2026-09-30 查到接近根因，但沒能修好；上一輪「縮小到 ContainerVisualizer.tsx 自己的 var-object 訂閱」的結論是錯的，已推翻**：先前以為容器 widget 跟 Locals 面板讀的是不同 var-object，這次直接讀原始碼證實是錯的——`ContainerVisualizer.tsx` 的 `_pollContainers()` 只是每秒讀 `global_variable.__latest_containers`（純渲染，不重算），真正的計算在 `VisualizerHelper.js` 的 `processing_guide()`/`checkStore()`，而它讀的 `varObj` 跟 Locals 面板是**同一個** `store.get('expressions')` 陣列、**同一個** entry（用 `expression === 'main::x'` 找）。

   **這次查到的實際狀況**（`map<int,int> x; x[1]=10;`，guide 加在插入那一行的下一行，一路單步到插入後第 2、第 3 個停駐點，全程用 JS 直接讀 `store.get('expressions')` 而非螢幕截圖判斷）：
   - `x` 的 `value`／`numchild`／`has_more` 三個欄位**最終都會自己修正成對的**（`"std::map with 1 element"`／`2`／`"1"`），但 `x.children` **永遠停在 `[]`**，撐過三個以上的停駐點都不會變——不是「慢一拍」，是真的卡死。
   - 決定性線索：這整個除錯 session 裡，**每一次 `-var-update --all-values *` 的 changelist 回應都是空陣列 `[]`**（`console.log('changelist = ...')`，APP 自己既有的，不是我加的），一次都沒有例外，即使是插入剛執行完那個停駐點也一樣。這代表 `GdbVariable.tsx` 的 `handle_changelist()`（`gdbgui/src/js/GdbVariable.tsx:777`）內建的「`has_more` 從 changelist 抓到 `1` 就自動補打 `-var-list-children`」那段（`gdbgui/src/js/GdbVariable.tsx:782-792`）**對這個變數從來沒有機會執行**——不是判斷錯，是 changelist 裡根本沒有這一筆。
   - 但 `value`/`numchild` 確實有更新，所以一定是走了另一條路徑（很可能是同一批指令裡的 `-stack-list-variables --simple-values` 驅動的 Locals 同步，跟 changelist 是兩條互相獨立的路），只更新摘要值、不會觸發 has_more 驅動的子節點抓取。
   - `VisualizerHelper.js` 自己也有一條備援路徑（`numchild>0` 但 `children.length===0` 時呼叫 `GdbVariable.fetch_and_show_children_for_var()` 並重試）——實測**真的送出了** `-var-list-children --all-values "var1"`（在瀏覽器 console 看到封包送出），但回應回來之後 `children` 還是沒被填上。往下查到 `GdbVariable.tsx` 的 `gdb_created_children_variables()`（458 行）：它靠模組層級的單一共用變數 `ChildVarFetcher.expr_gdb_parent_var_currently_fetching_children` 記住「現在這個回應是哪個 var 的」，對不上（`parent_obj` 找不到）就靜默吞掉、只呼叫 `fetch_complete()` 解鎖佇列，不寫入任何資料，程式碼自己的註解寫「likely another tab interacting w/ the same gdb instance created this」——**懷疑這就是最後一段斷點**，但受限於這次找到答案前先修過一版（後來驗證無效、已 revert）用掉的時間，**沒有走到底確認 `parent_name` 在回應抵達時到底是什麼**。
   - 已經試過、確認無效並 revert 的修法：在 `checkStore()` 判定「空容器」之前，同一個 `_cv` 版本內強制多等一輪再下結論（想賭「numchild 還沒自我修正完成」這個時間差）——實測完全沒用，因為真正卡住的不是這個時間差，是上面 `children` 永遠抓不回來這件事，跟「判定空容器」的時機無關。
   - **下次接手的具體切入點**：在 `gdb_created_children_variables()`（`GdbVariable.tsx:457`）加一行 `console.log`，印出 `parent_name`／`r.payload.name`／`parent_obj` 是否找到，重跑一次 `map<int,int> x; x[1]=10;` 插入後的單步，直接看是「回應對不上任何已知 var」還是「對上了但沒寫入成功」——這會直接把問題鎖死在 `ChildVarFetcher` 的單一佇列/單一共用 parent-name 追蹤機制（`GdbVariable.tsx:21-51`），或是引擎端 `-var-list-children` 回應本身的 `name` 欄位有問題兩者之一。這次沒有動 `GdbVariable.tsx`／`ChildVarFetcher` 的任何程式碼，純粹是讀原始碼＋瀏覽器 console 交叉比對。**優先度最高**——map 是這次新增功能的核心，這個沒解開，map/set/priority_queue 那整塊都不能算驗證通過。**這個過程中也發現 `set` 用完全一樣的手法（同樣沒有再次引用 `{y}` guide token 的後續行）一樣卡住**——上一輪「set 已確認在容器 widget 正確」的結論同樣是誤判（那次其實是在 Locals 面板手動展開測的，不是容器 widget），所以這不是 map 專屬缺口，是整個動態容器家族（set/map/deque/stack/queue/pqueue）在容器 widget 這一層共通的問題。
   - **幽靈呼叫樹 5 份教案未在真實瀏覽器驗證**：協定層已修好（commit `2412182`），quicksort 驗證過確實能畫，但 DP課4、DP課5、技巧二、硬幣所有解析法、SWAP 這 5 份都還沒在瀏覽器裡實際跑過確認畫面對不對。
   - **走迷宮 `std::queue` 容器渲染未驗證**：容器支援已在協定層修好（commit `9b2c5e4`），但走迷宮這份教案本身（含 BFS 用到的 `std::queue` 畫面）還沒在瀏覽器裡重新跑過確認。
   - **Rails `std::stack` 不畫，根因未修**：已證實不是 wasm 專屬缺口（`?engine=gdb` 一樣不畫），根因鎖定在 `VisualizerHelper.js` 的 `train` varobj 從未被建立（guide 綁在第 27 行、一個迴圈條件式），但依使用者指示暫停，沒有查完。下次要用瀏覽器 DevTools 斷點單步 `processing_guide`/`graphics_instruction`，不要用黑箱外部觀察（這輪查 map 異常時吃過同樣的虧，教訓一致）。
   - **`std::list` 走訪異常，未查完**：`list_walkthrough.json`（`push_front`/`push_back` 之後應有 5 個元素）兩個引擎都顯示空/數量不對，但比對方法不夠嚴謹（單步時機可能沒讓兩引擎真的停在同一行），沒有下結論，需要更嚴謹的同行比對方法重測才能判斷是不是真的缺口。
