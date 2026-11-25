# 計畫：停在第 L 行時，畫面顯示「第 L 行執行後」的狀態（方案 A）

狀態：S1–S4 已完成並在 lab-david 驗證（結果見第 6 節）；S5 檢查表已完成（`experiments/after-view/lesson-checklist.md`），教案改寫等使用者決定。未 commit、未部署。
日期：2026-11-25

## 0. 決定

| 編號 | 決定 | 來源 |
|---|---|---|
| D1 | 插樁位置不變：探針仍插在每行開頭，每筆紀錄是「該行執行前」。畫面改讀同一次函式呼叫（同一個 frame）的下一筆紀錄，也就是「該行執行後」。 | 使用者選方案 A |
| D2 | 教案在某行標了 `[step-in]`，而且這一站下一筆紀錄進入更深的函式時，這一站顯示「呼叫當下」（等於執行前）；其餘一律顯示執行後。用「跳出」（finish）回到呼叫行時，顯示整行執行後。 | 使用者選「教案標 [step-in] 的呼叫行顯示呼叫當下」 |
| D3 | 程式輸出區不再等程式結束才出現：每停一次，顯示到「這一行執行後」為止的輸出。 | 使用者選「一起改」 |

這推翻 2026-11-05 計畫 `2026-11-05-line-after-result-plan.md` 的 non-goal「不改變停駐點的位置（仍然是執行前）」中的「顯示執行前」部分：停駐位置仍不變，但顯示改為執行後。

## 1. 現況（2026-11-25 查證，正式站 af03b477）

- `instrument.js` 把探針插在敘述開頭（第 866 行 `ins(B(st), probe(...))`）；S0 實驗報告也證實停駐點在該行執行之前。
- 所有面板（容器、區域變數、程式追蹤表、指導文字的 `{變數}`、記憶體、UML）經 LocalGdb 讀「目前停駐點」的紀錄，所以都是執行前。
- 「執行後」只出現在「執行這行的結果」面板（`afterState.js`，取同一 frame 的下一筆紀錄求差）。教案的 `@layout open:X` 會關掉其他所有面板，Rails 教案從頭到尾看不到它。
- 容器面板只在「這一行的 @guide 寫了 {容器名}」時重讀，並靠每秒一次的輪詢重畫；Rails 的 stack 圖只在第 27 行更新，而且晚約 0.8 秒。
- 程式輸出（stdout/stderr）在程式結束時才一次送到前端（`session.js` 的 `deliverProgramOutput`）。

## 2. 設計

### 2.1 顯示用的紀錄（view step）

`TraceModel.nextInFrame[k]`：同一個 frame 的下一筆紀錄，沒有則 -1。frame 編號每次呼叫唯一，所以一次由後往前掃即可（O(n)；`afterState.js` 目前的 `nextInFrame` 在函式結束的站會掃到軌跡結尾，最壞 O(n²)，一併改用這個陣列）。

`ExecState.viewStep()`（只在 display = "after" 時與高亮站不同）：

1. 高亮站 d = landed ? disp : pos。
2. j = nextInFrame[d]；j < 0（函式結束、程式結束、在這一行中止）→ 顯示 d 自己。
3. 不是 landed、這一筆的下一筆紀錄進入更深的函式，而且（a）這一行在 callEntryLines（D2，教案標 `[step-in]` 的行），或（b）被呼叫的函式裡有會讓「繼續／下一步」停下來的地方（啟用中的中斷點、可繼續的執行錯誤）→ 顯示 d（呼叫當下）。（b）是 2026-11-25 實作時補的：費氏記憶化教案 main 的 `int total = fib(6);` 標的是 `[next]`，但 fib 裡有中斷點，按下一步會先停進 fib；若顯示整行執行後，旁白「記憶表現在全是負一」時畫面已經是填滿的表。
4. 其他 → 顯示 j。

landed（「跳出」回到呼叫行）時 d = 呼叫行那一筆，j = 呼叫結束後的下一筆，即整行執行後。

### 2.2 取值規則

- 行號、函式、frame 位址、`for-seg`、呼叫堆疊的結構：一律依高亮站，不變。
- 第 0 層（目前函式）的變數清單依高亮行的作用域（使用者看到哪一行，就列那一行看得到的變數）；值取 view 那一筆。同一個名字要對到同一個宣告（名字＋宣告區塊）才取 view 的值，否則用高亮站的值（避免區塊內外同名變數對錯）。
- 呼叫者各層的值、callee 經指標或參考寫回呼叫者（overlay）的時間點、全域變數：都以 view 為準。
- 中斷點條件仍以執行前判斷（停不停的規則不變）。`-vg-cell-last-write` 的索引在執行前求值，上限改成 view（顯示中已包含這一行的寫入）。

### 2.3 程式輸出（D3）

紀錄 k 的 `stepOffsets[k]` 是寫下這筆紀錄時 stdout/stderr 已有的位元組數（S2 已在每個探針前 flush）。每次停下，LocalGdb 送一個 side event `vg_program_output`，內容是「到 view 那一筆為止」的完整輸出（取代，不是附加）；程式結束時送完整輸出。前端 `Terminals.tsx` 收到就整個換掉輸出區內容。display = "before" 時維持舊行為（結束時才送 `program_pty_response`）。

### 2.4 前端

- `localEngine.ts` 建 LocalGdb 時傳 `display: "after"` 與 `callEntryLines`（原始碼中 `@tts` 任何一個版本含 `[step-in]` 的行）。`?display=before` 或 localStorage `vgdb_display=before` 可切回執行前，供對照。
- 容器面板：每一站都重讀已經畫過的容器（不再只靠該行 @guide 有 {容器名}），資料到了就立即重畫，不等每秒輪詢。
  實作：`VisualizerHelper.containers_to_refresh` 挑出「畫過、這一行指導沒提到、這一層直接問引擎求得到值」的容器，跟指導的 token 一起交給 `graphics_instruction`（文字不進指導欄）；沒有指導的行也重讀（refreshOnly，指導欄不動）。求不到值的名字不重讀，免得 token 等到逾時、拖住自動播放（自動播放最多等 4 秒）。
- 「執行這行的結果」面板：呼叫當下的站改說「這一行正在呼叫函式」，不先揭露整行結果。
- `pull:`：執行後模式下目標格已經是新值，不再疊「暫時的計算結果」，只播來源格飛入與目標格閃一下。
- 執行錯誤面板：`stepNow` 改記「畫面顯示哪一步的狀態」（`currentViewStep()`）。停在錯誤那一行時畫面已是執行後，陣列越界的記憶體排列圖直接出現；溢位的說明改成「這一行執行完，存進去的值是…」，不再叫人按「繼續」。
- `-vg-cell-last-write` 的 BEFORE 仍是「播放器停的那一站」，引擎換算成那一站顯示的狀態（view），所以這一行自己的寫入也算。

### 2.5 已知限制（照實寫進文件）

- 區塊最後一行若改了區塊內的變數，下一筆紀錄已在區塊外、沒有它的值：這種變數顯示執行前的值。最常見的是 for 迴圈最後一次 `i++`（迴圈結束時 i 不再存在）。
- 這一行執行到一半程式中止（致命的執行錯誤）：沒有執行後，顯示執行前並由「執行錯誤」面板說明。
- 教案沒標 `[step-in]` 的呼叫行，使用者自己按「進入」時，畫面會從整行執行後回到呼叫當下（使用者接受）。

## 3. 切片

| 切片 | 內容 | 驗收 |
|---|---|---|
| S1 引擎 | `model.js`（nextInFrame、visibleVarsView）、`exec.js`（viewStep）、`session.js`／`varobj.js`（取值改用 view）、`cellWrite.js`、`afterState.js`（O(n)、callEntry 標記）、`index.js` 選項 | 新測試 `tests/engine/localgdb/after_view.test.mjs` 全過；既有 localgdb 測試（display 預設 "before"）結果與基準相同 |
| S3 輸出 | `session.js` 的 `vg_program_output`；`Terminals.tsx` | 引擎測試：每站輸出等於 stdout 前綴；jest |
| S2 前端 | `localEngine.ts`、`VisualizerHelper.js`／`ContainerVisualizer.tsx`（每站重讀、立即重畫）、`LineAfterPanel`、`pull:` | jest RED→GREEN、全量 jest、tsc 5.4.5 與基準比較 |
| S4 預覽 | lab-david 5002（新）與 5003（正式版）並排：Rails、費氏記憶化、走方格、SWAP | 使用者看過效果 |
| S5 教案 | 每個停駐行的 `{token}` 執行前／後值對照表，標出旁白要改的行；改寫稿給使用者看過再寫入 | 使用者核准 |
| S6 部署 | 只在使用者要求時；引擎、前端、教案一起上 | `prod_deploy.sh` 三階段 |

## 4. 測試要點（after_view.test.mjs）

賦值、`push`／`pop`、宣告、`cin >>`、for 的初始化與遞增站、while／if 條件、迴圈結束站、呼叫行（next 跳過、step 進入、finish 跳出）、`[step-in]` 呼叫行、return 與 `}`、全域變數、遞迴＋全域記憶表、指標與參考（SWAP）、未初始化旗標、可恢復與致命的執行錯誤、`-vg-seek-step`、反向單步、`-vg-cell-last-write`、`vg_program_output` 前綴。display = "before" 時每個查詢的結果與修改前逐字相同。

所有測試在 lab-david 的 builder 映像內執行（`experiments/after-view/`），不在本機跑。

## 5. 不做的事

- 不改插樁、不改軌跡格式、不改停駐序列（停幾次、停在哪一行都不變），所以教案的 `@2`、`@5` 次數與 `[next]`／`[continue]` 走法不受影響。
- 不在沒有使用者要求下 commit 或部署。

## 6. 結果（2026-11-25，lab-david，基準 af03b477）

原始紀錄：`experiments/after-view/results-2026-11-25/`（測試紀錄、教案檢查原始資料、截圖、執行腳本）。

- 引擎（node --test，localgdb 全部加 s1／s2／s3，共 24 個檔）：改後 291 個測試，248 過、34 失敗、9 略過。34 個失敗在基準上也失敗：33 個是映像裡沒有 `experiments/frontend-only/...` 檔案（addresses、replay），1 個是 lessons_corpus 的 quick_sort 錄製基準。改後新增的失敗：0。新加的 10 個測試（after_view 9 個、cell last write 1 個）全過。之後再補一個指標測試（經指標寫回呼叫者、指標的子變數 `*a`），after_view.test.mjs 共 11 個，連同 pointers.test.mjs 22／22 過（`log-node-green2.txt`）。基準那一輪另有 14 個 containers 測試失敗，原因是編譯超過 9.5 秒預算（當時我同時在跑瀏覽器預覽）；單獨重跑基準的 containers.test.mjs：20／20 過。
- 實作中補的一點：呼叫行顯示「整行執行後」時，「執行這行的結果」的輸出也改成整行（含被呼叫函式印出的部分），測試 `a call line's printed output includes what its callee printed`。
- 前端：全量 jest（序列）91 個檔、1156 過、1 略過；tsc 5.4.5 基準 10 個錯誤、改後 10 個，沒有新錯誤；預覽的 main.js 含 4 個標記。
- 預覽（5002 新版、5003 正式版映像，同一份教案、同樣的按鍵）：
  - Rails 第 26 行第三台車：新版 stack 1 2 3，正式版 1 2。第 28 行兩次 pop：新版 1 2 3 4、1 2 3，正式版兩次都是 1 2 3 4 5。第 33 行：新版輸出窗已有 No，正式版空白。
  - 費氏記憶化第一次停在第 22 行：新版 memo[2] = 1，正式版 -1。第 19、20 行（`[step-in]`）顯示呼叫當下。
  - 走方格 Grid1 第 33 行 (i=1, j=1)：新版 dp[1][1] = 1，正式版 0；新版沒有疊暫時結果。
  - `?display=before` 可切回執行前（Rails 第 26 行第三台車顯示 1 2）。
  - SWAP 沒有在預覽上操作；指標的取值改由上面那個引擎測試涵蓋。
- 教案（S5）：正式站 69 份教案，419 個有旁白的停駐行；7 行一定要改、5 處建議改措辭、50 行新版反而變對。清單在 `experiments/after-view/lesson-checklist.md`。
- 正式站容器 StartedAt 全程未變（2026-11-24T19:32:10Z）；預覽與映像已移除，~/iris-preview 回到 af03b477 且乾淨。
- 部署（2026-11-25）：c34bd92d（引擎與前端）、0677fdc1（撰寫規則、檢查器、AI 產生器提示、教學頁）、5d1ca051（repo 教案）推上 Develop；正式站 08:50:24Z 換成映像 fff03ef6eff4（約 1.7 秒停機，切換時 0 人在線），verify 全過，公開網址的 main.js 與映像相同。部署前在 lab-david 補跑：pytest 475 個測試只有既有的 test_routes_swap 失敗；check_lesson 對 54 份教案結果不變；gen_tutorial 重新產生與 repo 相同。部署後在正式站開 Rails（v6）：第 26 行第三台車 stack 1 2 3。
- 教案寫回：正式站 9 份（清單第七節），每份寫前確認版本與內容、寫後讀回比對。舊的 pre-deploy-20261124-1900 備份映像已刪，保留 20261124-1930 與 20261125-0848。
