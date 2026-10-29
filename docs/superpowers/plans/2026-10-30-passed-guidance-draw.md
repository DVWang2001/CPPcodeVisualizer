# 經過的指導行一律畫出來 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自動播放執行 `[continue]`、`[next]`、`[step-out]` 時，途中經過的指導行（字幕/TTS/圖形/容器）都要畫出來，但不播 TTS、零延遲、計入造訪次數、不設步數上限。

**Architecture:** 前端在自動播放續行前，對教案所有帶指導的行插入臨時斷點（`-break-insert -f`），每次靜默停駐時執行畫面更新但跳過 `play_tts`，再依原指令的深度規則續行；結束時刪除臨時斷點。引擎是預錄軌跡的 LocalGdb MI 模擬（`gdbgui/static/engine/localgdb/`），所以續行與斷點命中都在本地計算，沒有真實 GDB 往返。

**Tech Stack:** TypeScript / TSX（gdbgui 前端）、JavaScript（VisualizerHelper.js、LocalGdb）、Jest（`gdbgui/src/js/tests/`）、Node 測試（`tests/engine/localgdb/`）、Playwright e2e（`e2e/tests/zz_*.spec.ts`）

**Spec:** `docs/superpowers/specs/2026-10-30-passed-guidance-draw-design.md`

## Global Constraints

- 不播 TTS 於靜默停駐；使用者斷點所在行必須正常停下並照常播 TTS。
- 靜默期間動畫零延遲（沿用 `fast-forward` 的全域旗標），動畫流程仍執行。
- 靜默經過的指導行計入 `__line_visit_count`。
- 不設步數上限。
- 所有結束路徑（正常、暫停、關閉自動播放、程式結束、出題閘門）都要刪除臨時斷點，不留殘骸。
- `[fast @N]` 程式碼不改；靜默停駐不觸發快轉武裝。
- 伺服器端、TTS 模組、教案 JSON 格式不改。

## Review Focus

1. 自動播放中，使用者斷點所在行被靜默吃掉（應該正常停下）。→ Task 2 測試
2. 靜默通過途中使用者按暫停/關閉自動播放，仍一路續跑。→ Task 4 測試
3. `[next]` 跨過的函式內指導行未畫，或續行衝過 origin 的下一行。→ Task 3 測試
4. 出題閘門行被靜默吃掉，題目沒有觸發。→ Task 4 測試
5. 程式結束或 `inferior_program_exited` 後臨時斷點殘留，下次執行時多出停駐。→ Task 1 與 Task 4 測試

---

### Task 0: 技術 spike（只讀與跑既有測試，不改程式）

**Files:**
- Read: `gdbgui/static/engine/localgdb/session.js`（`breakInsert` line ~380、`execMove` line ~440）、`gdbgui/static/engine/localgdb/exec.js`（depth 規則 line 1–10、`next` / `finish` / `continue` 停駐）
- Read: `gdbgui/src/js/GdbApi.tsx`（`-break-insert -f` 命令形式 line ~1047）

**Interfaces:**
- Consumes: 無
- Produces: 一段 spike 結論，寫進本計畫檔的 `## Spike 結論` 小節（新增，不另開檔）

- [ ] **Step 1: 確認臨時斷點命令的回應格式**
  讀 `session.js` 的 `breakInsert`，記下 `-break-insert -f "<fullname>:<line>"` 回傳的 `bkpt.number` 欄位形狀，以及 pending 斷點的行為。
- [ ] **Step 2: 確認續行規則**
  讀 `exec.js` 的 `continue` / `next` / `finish` 停駐條件，記下：(a) `next` 跨過呼叫時遇到斷點是否會停在深層框架；(b) 從深層 `next` 返回時是否落在 origin 的下一行；(c) `finish` 落點是否為呼叫行中段。
- [ ] **Step 3: 跑既有 LocalGdb 測試作為基準**
  Run: `node --test tests/engine/localgdb/` （若失敗，記錄失敗清單，不得在本任務修正）
  Expected: 記錄通過/失敗數量作為基準。
- [ ] **Step 4: 寫入 `## Spike 結論`**
  列出 Step 1–3 的事實，任何與設計文件不符的地方要標為「需回到核准」，不得自行改設計。

---

### Task 1: 純決策與命令產生模組

**Files:**
- Create: `gdbgui/src/js/silentPass.ts`
- Test: `gdbgui/src/js/tests/silentPass.jest.ts`

**Interfaces:**
- Consumes: 無（純函式，不依賴 store 或 socket）
- Produces:
  - `guideLineNumbers(lineMaps: { line?: Record<string|number,string>; tts?: Record<string|number,string>; layout?: Record<string|number,string> }): number[]` — 任一欄有內容的行號，升冪
  - `insertGuideBreakpointCmds(fullname: string, lines: number[], userLines: Set<number>): string[]` — 對非使用者斷點的行產生 `-break-insert -f "<fullname>:<line>"`
  - `deleteBreakpointCmd(numbers: string[]): string` — `-break-delete <n1> <n2> …`，空陣列回傳空字串
  - `classifyStop(args: { bkptno: string | null; line: number; userBreakpointNumbers: Set<string>; guideBreakpointNumbers: Set<string>; quizMatched: boolean }): "normal" | "silent"` — 若 `quizMatched` 或 `bkptno` 屬於使用者斷點 → `normal`；其餘 → `silent`
  - `nextResume(kind: "continue" | "next" | "finish", originDepth: number, stopDepth: number): "continue" | "next" | "finish" | "done"` — 見 Step 3 的規則

- [ ] **Step 1: Write the failing test**

```ts
import { guideLineNumbers, insertGuideBreakpointCmds, deleteBreakpointCmd, classifyStop, nextResume } from "../silentPass";

test("guideLineNumbers unions guide/tts/layout keys", () => {
  expect(guideLineNumbers({ line: { 5: "a" }, tts: { 9: "b" }, layout: {} })).toEqual([5, 9]);
});

test("insert skips user breakpoint lines", () => {
  expect(insertGuideBreakpointCmds("/w/main.cpp", [3, 7], new Set([7]))).toEqual([
    '-break-insert -f "/w/main.cpp:3"',
  ]);
});

test("delete with no numbers is empty", () => {
  expect(deleteBreakpointCmd([])).toBe("");
});

test("user breakpoint or quiz match is normal", () => {
  expect(classifyStop({ bkptno: "4", line: 7, userBreakpointNumbers: new Set(["4"]), guideBreakpointNumbers: new Set(), quizMatched: false })).toBe("normal");
  expect(classifyStop({ bkptno: "9", line: 7, userBreakpointNumbers: new Set(), guideBreakpointNumbers: new Set(["9"]), quizMatched: true })).toBe("normal");
  expect(classifyStop({ bkptno: "9", line: 7, userBreakpointNumbers: new Set(), guideBreakpointNumbers: new Set(["9"]), quizMatched: false })).toBe("silent");
});

test("next resumes with next while deeper, done at origin depth", () => {
  expect(nextResume("next", 2, 3)).toBe("next");
  expect(nextResume("next", 2, 2)).toBe("done");
});

test("finish keeps finishing while at or below origin depth", () => {
  expect(nextResume("finish", 2, 3)).toBe("finish");
  expect(nextResume("finish", 2, 2)).toBe("finish");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest gdbgui/src/js/tests/silentPass.jest.ts`
Expected: FAIL with "Cannot find module '../silentPass'"

- [ ] **Step 3: Implement `silentPass.ts`**

依 Task 0 的 spike 結論實作。`nextResume` 規則：
- `continue`：恆回 `"continue"`（續行到下一個指導行或使用者斷點）。
- `next`：`stopDepth > originDepth` → `"next"`；否則 `"done"`。
- `finish`：`stopDepth >= originDepth` → `"finish"`；否則 `"done"`。

若 spike 發現 `finish` 規則與 GDB 不符，回到設計核准，不得自行改寫。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest gdbgui/src/js/tests/silentPass.jest.ts`
Expected: PASS

---

### Task 2: 靜默通過狀態機與臨時斷點生命週期

**Files:**
- Create: `gdbgui/src/js/silentPassRunner.ts`
- Test: `gdbgui/src/js/tests/silentPassRunner.jest.ts`

**Interfaces:**
- Consumes: Task 1 全部 export
- Produces:
  - `startSilentPass(kind, originDepth, fullname, guideLines, userLines): string[]` — 回傳要送出的 `-break-insert` 命令；並記錄狀態
  - `recordInsertedNumber(n: string): void`
  - `isSilentPassActive(): boolean`
  - `finishSilentPass(): string` — 回傳 `deleteBreakpointCmd(...)`，並清空狀態；未啟用時回傳空字串
  - `onSilentStop(stopDepth: number, args: Parameters<typeof classifyStop>[0]): { action: "normal" } | { action: "silent"; resume: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { startSilentPass, recordInsertedNumber, finishSilentPass, onSilentStop, isSilentPassActive } from "../silentPassRunner";

beforeEach(() => { finishSilentPass(); });

test("start returns insert commands and finish deletes recorded numbers", () => {
  const cmds = startSilentPass("continue", 1, "/w/main.cpp", [3, 5], new Set());
  expect(cmds).toHaveLength(2);
  recordInsertedNumber("11");
  recordInsertedNumber("12");
  expect(isSilentPassActive()).toBe(true);
  expect(finishSilentPass()).toBe("-break-delete 11 12");
  expect(isSilentPassActive()).toBe(false);
  expect(finishSilentPass()).toBe("");
});

test("silent stop on guide line asks for continue", () => {
  startSilentPass("continue", 1, "/w/main.cpp", [3], new Set());
  recordInsertedNumber("11");
  expect(onSilentStop(1, { bkptno: "11", line: 3, userBreakpointNumbers: new Set(), guideBreakpointNumbers: new Set(["11"]), quizMatched: false }))
    .toEqual({ action: "silent", resume: "continue" });
});

test("user breakpoint stop is normal and keeps pass state until finish", () => {
  startSilentPass("continue", 1, "/w/main.cpp", [3], new Set());
  recordInsertedNumber("11");
  expect(onSilentStop(1, { bkptno: "2", line: 8, userBreakpointNumbers: new Set(["2"]), guideBreakpointNumbers: new Set(["11"]), quizMatched: false }))
    .toEqual({ action: "normal" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest gdbgui/src/js/tests/silentPassRunner.jest.ts`
Expected: FAIL with "Cannot find module '../silentPassRunner'"

- [ ] **Step 3: Implement `silentPassRunner.ts`**

模組層級的單一狀態物件（kind、originDepth、insertedNumbers）。`onSilentStop` 呼叫 `classifyStop`，若為 `silent` 則以 `nextResume(kind, originDepth, stopDepth)` 決定續行；若 `done`，回傳 `{action:"normal"}`。`normal` 時由呼叫端負責 `finishSilentPass()`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest gdbgui/src/js/tests/silentPassRunner.jest.ts`
Expected: PASS

---

### Task 3: 接上 Actions（停駐分派與續行）

**Files:**
- Modify: `gdbgui/src/js/Actions.ts`（`inferior_program_paused` 約 line 150–215；`inferior_program_exited` 約 line 218）
- Modify: `gdbgui/src/js/GdbApi.tsx`（自動播放續行的入口，`gdbgui_execute_autoplay_command` 所在處；送出 `startSilentPass` 的命令）
- Test: `gdbgui/src/js/tests/silentPassIntegration.jest.ts`

**Interfaces:**
- Consumes: Task 2 全部 export；`global_variable.__line` / `__tts` / `__layout`；`store.get("autoplay_enabled")`
- Produces: 無新 export；行為變更如下

- [ ] **Step 1: Write the failing test**

Jest 測試模擬一連串 stop：第一次 `continue` 啟動靜默、中間兩次靜默停駐、一次使用者斷點停駐。斷言：中間兩次不呼叫 `play_tts`，但呼叫 `processing_guide`、`refresh_state_for_gdb_pause`；使用者斷點那次呼叫 `play_tts`；最後送出 `-break-delete` 清除。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest gdbgui/src/js/tests/silentPassIntegration.jest.ts`
Expected: FAIL（目前沒有靜默分支，`play_tts` 會在每次停駐被呼叫）

- [ ] **Step 3: Implement**

- `inferior_program_paused`：在 `__line_visit_count` 遞增之後、`processing_guide` 之前，若 `isSilentPassActive()`，呼叫 `onSilentStop`。`silent` → 執行畫面更新（`processing_guide`、`detect_container_op`、`detect_swap_call`、`recompute_for_sub_step`、`refresh_state_for_gdb_pause`），**跳過** `play_tts`，並送出 `resume` 對應的 GDB 命令。`normal` → `finishSilentPass()` 送出刪除命令，然後照現有流程（含 `play_tts`）。
- 續行命令用既有的 `GdbApi.run_gdb_command` 送出 `-exec-continue` / `-exec-next` / `-exec-finish`。
- 自動播放 `[continue]`/`[next]`/`[step-out]` 的入口呼叫 `startSilentPass`，把 insert 命令逐條送出並以回應的 `bkpt.number` 呼叫 `recordInsertedNumber`。
- `inferior_program_exited`：呼叫 `finishSilentPass()`，若有刪除命令則送出（程式已結束時刪除命令可能失敗，失敗不影響狀態重設）。
- 使用者按暫停或關閉自動播放時，同樣呼叫 `finishSilentPass()` 並送出刪除命令。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest gdbgui/src/js/tests/silentPassIntegration.jest.ts`
Expected: PASS

---

### Task 4: 結束路徑與出題閘門

**Files:**
- Modify: `gdbgui/src/js/Actions.ts`（`quizMatched` 分支，約 line 165–182；`ControlButtons.tsx` 暫停處，約 line 205 與 232）
- Test: `gdbgui/src/js/tests/silentPassEnds.jest.ts`

**Interfaces:**
- Consumes: Task 2 `finishSilentPass`；`lessonQuizRuntime.onGdbPause` 回傳的 `quizMatched`
- Produces: 無

- [ ] **Step 1: Write the failing test**

三個案例：(a) 靜默途中 `quizMatched=true` → 結束靜默、正常處理；(b) 靜默途中使用者暫停 → 呼叫 `finishSilentPass` 並送刪除命令；(c) `inferior_program_exited` → 狀態清空。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest gdbgui/src/js/tests/silentPassEnds.jest.ts`
Expected: FAIL

- [ ] **Step 3: Implement** 依 Task 3 的結構補上三條結束路徑。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest gdbgui/src/js/tests/silentPassEnds.jest.ts`
Expected: PASS

---

### Task 5: 端到端驗證與回歸

**Files:**
- Create: `e2e/tests/zz_passed_guidance_draw.spec.ts`（依現有 `zz_*.spec.ts` 慣例）
- Create（測試用教案）: `examples/lessons/…/passed_guidance.json`（名稱在實作時定案，只放在測試專用資料夾；需含 `[continue]` 與 `[next]` 跨過函式內指導行的情境）

**Interfaces:**
- Consumes: Task 3、Task 4 的行為
- Produces: 無

- [ ] **Step 1: 寫 e2e 測試**
  斷言：(a) 自動播放 `[continue]` 經過的指導行，其圖形/容器在畫面上出現；(b) 最終停駐狀態與逐行 `[next]` 走到同一位置的狀態一致；(c) 結束後 `-break-list` 只剩使用者原本的斷點；(d) `__line_visit_count` 包含靜默經過的行（決定 B）。
- [ ] **Step 2: 跑 e2e 確認失敗**
  Run: `npx playwright test e2e/tests/zz_passed_guidance_draw.spec.ts`
  Expected: FAIL（功能尚未接上前）
- [ ] **Step 3: 全部實作完成後跑回歸**
  Run: `npx jest` 與 `npx playwright test e2e/tests/zz_fast_forward.spec.ts e2e/tests/zz_annotations_modal_playmode.spec.ts`
  Expected: 全數通過；既有 `[fast @N]` 與出題測試不變。
- [ ] **Step 4: 交由 fresh-context verifier 驗收**
  Verifier 收到的 claim：「自動播放 [continue]/[next]/[step-out] 經過的指導行會靜默畫出、不播 TTS、結束後斷點清單還原、終態與逐行一致」，附本計畫與 diff 路徑。

---

## Spike 結論

依 `gdbgui/static/engine/localgdb/session.js` 與 `exec.js` 讀取（2026-10-30）：

1. **臨時斷點**：`-break-insert -f "<fullname>:<line>"` 受支援；回應為 `bkpt` 物件，含 `number`。`-break-delete N M …` 受支援。
2. **停駐回報只帶第一個命中的 `bkptno`**（`session.js` `stopItems` 的 `info.hits[0]`）。分類時以「使用者斷點行不插入臨時斷點」來避免同行衝突，不依賴多重命中。
3. **`next`（`exec.js` `forward`）**：從起點往後，第一個深度 ≤ 起點深度的步驟即停。因此靜默停在深度 ≤ 起點的位置時，**那就是 `next` 的目標**，必須以正常流程處理（播 TTS），不能靜默續行。深度 > 起點的停駐才是靜默。
4. **`finish`**：`forward` 以 `_landInCaller` 落在呼叫者的呼叫行中段。靜默停在深度 ≥ 起點（被結束的框架或更深）時，應再次 `-exec-finish`；落在深度 < 起點即為目標。
5. **`continue`**：只在斷點命中時停，無深度條件，任何靜默停駐都續行。
6. **基準測試**：`node --test --test-concurrency=1 tests/engine/localgdb/` → 253 項中 241 通過、3 失敗、9 略過（失敗為開工前既有，不是本次造成）。`node --test` 不加並行限制會產生假失敗，不可作為基準。

**Task 3 前的新發現（會改變計畫，尚未實作）：**
- `process_gdb_response.tsx` 第 102–131 行：每個 `^done` 且含 `bkpt` 的結果都會 (a) 刪除**同一 fullname/func/line 的既有 UI 斷點**、(b) `Breakpoints.save_breakpoint` 存入使用者斷點清單、(c) `Actions.view_file` 切換檢視、(d) `refresh_breakpoints`。若臨時斷點照計畫用 `-break-insert -f` 送出，會汙染使用者斷點面板並切換檢視。**修正**：臨時斷點的插入必須走內部路徑，回應要被辨識為「靜默通過擁有」而略過上述四步；刪除則直接 `-break-delete`，不經 UI 斷點清單。
- 停駐事件（`process_gdb_response.tsx` 約 line 340–352）帶 `bkptno` 與 `frame`，但**不帶堆疊深度**。深度要等 refresh 的 `-stack-list-frames` 回應，經 `Threads.update_stack` 寫入 `stack`。因此 `nextResume` 的深度判斷必須延後到 `update_stack` 之後才做，不能在停駐當下同步判斷。
- 靜默停駐的續行與「暫停/關閉自動播放」檢查要放在 `update_stack` 之後，並且若使用者已暫停，要結束靜默通過、停在當前行、不播 TTS。

**對計畫的修正：**
- `nextResume` 規則：`next` 深度 > 起點 → `"next"`，否則 `"done"`（`done` 代表目標到達，走正常流程）。`finish` 深度 ≥ 起點 → `"finish"`，否則 `"done"`。`continue` 恆為 `"continue"`。
- `onSilentStop` 必須先判斷 `done`：`done` 時回傳 `{action:"normal"}`，即使該行不是使用者斷點。

---

## Self-Review

- **Spec coverage:** 設計第 1（觸發）→ Task 3；第 1.5（深度追蹤）→ Task 1 `nextResume`；第 2（臨時斷點）→ Task 1 + Task 2；第 3（分類與畫面更新）→ Task 2 + Task 3；第 4（零延遲）→ Task 3 Step 3 沿用既有旗標；第 5（結束條件）→ Task 4；第 6（清理）→ Task 2 + Task 3；決定 B（計數）→ Task 3 Step 3 與 Task 5 (d)；決定 C（無上限）→ 全計畫不設上限。
- **Type consistency:** `classifyStop`、`nextResume`、`startSilentPass`、`finishSilentPass`、`onSilentStop` 名稱在 Task 1–4 一致。
- **Proportion:** 本計畫以 signature 與測試斷言為主，避免貼出完整實作。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-30-passed-guidance-draw.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - 每個任務由新的 subagent 實作，之後再由獨立 reviewer 檢查才進入下一項。最徹底，但每個任務與每次審查都要新的上下文，成本較高。
- **Native** - 由我在這個 session 逐項實作，最後由一個獨立 reviewer 檢查整個分支。成本最低、最快，但直到最後才有獨立審查。

**For this plan I recommend Native**，因為任務之間透過 `silentPass` 的介面緊密相依（Task 1 → 2 → 3 → 4），而且出錯的代價在於回歸測試與停駐行為，最後用一次獨立 verifier 把關即可。Does the plan capture what you want, and which approach should we use?
