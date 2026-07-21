# 節點內操作聚焦（@guide 驅動）Design

**Date:** 2026-07-21
**Status:** Draft, pending user review
**Affects:** `gdbgui/src/js/CallGraph.tsx`；抽出 `resolveGuideText` 成共用 util（`Visualizer.tsx` 一併改用）
**Reference:** 已驗證 mockup `node-guide-mockup.html`（scratchpad）
**Builds on:** 呼叫圖鏡頭視角（`2026-07-21-callgraph-camera-view-design.md`）— 只在局部模式展開。

## 問題

節點上看不出函式內部「正在做什麼操作」，目前只有 TTS 描述。倒出全部局部變數（先前 mockup A）反而失焦。

## 解：目前節點聚焦顯示「當前這一行的 @guide」

作者本來就為每一行寫 @guide（指導）。把 **active node 當前行的 @guide 文字（含 {變數} 即時值）** 聚焦顯示在節點上 —— 換行換焦點，作者透過寫 @guide 控制「聚焦在哪個操作」。無操作徽章（使用者明確不要）。

### 節點呈現

- **只有 active node（目前節點，琥珀焦點）** 在 `func(args)` 標頭下方多一個「操作」區，顯示 `resolveGuideText(__line[activeNode.line])`。
- 其餘節點維持精簡（`func(args)` + `⇒值`），不展開，避免整棵樹爆滿。
- **只在鏡頭局部模式**（`viewMode === "local"`，節點大）顯示；全局模式節點太小 → 不顯示。
- **當前行的 @guide 變動時**（activeNode.line 改變）操作區**閃一下**（琥珀 `--amber-soft`，0.5s），讓使用者看到操作推進。`prefers-reduced-motion` 時不閃。
- **值強調**：@guide 裡由 {變數} 替換出來的值以綠色（`--green`）粗體呈現，字面文字用一般色 —— 讓「這個操作動到哪些值」一眼可見（這是「聚焦在正在操作的地方」的重點）。

## 資料與重用

- **當前行 @guide 文字**：`(window as any).gdbgui_global_variable.__line[activeNode.line]`（SourceCode.tsx 已維護的 line→guide dict）。
- **{變數} → 即時值替換**：現有 `Visualizer.resolveGuideText()`（`Visualizer.tsx:31-42`，讀 `store.get("expressions")`）。
- **重構（值強調需要）**：把 `resolveGuideText` 從 Visualizer 抽到共用 util `gdbgui/src/js/guideText.ts`，並提供**回傳分段**的變體 `resolveGuideSegments(text): Array<{text: string; isValue: boolean}>`（字面 vs {變數}替換值），CallGraph 用它把替換值渲染成綠色。Visualizer 改用抽出的 `resolveGuideText`（行為不變，純函式，可單元測試）。
- `activeNode` / `activeNode.line`：CallGraph 既有（`posById.get(activeNodeId)`，node.line 每快照更新為該 frame 目前行）。

## 與現有功能關係

- 不取代 Visualizer 面板的 @guide 顯示（面板顯示較完整；節點是聚焦一瞥）。兩者共用抽出的 `resolveGuideText`。
- 不動 @guide 語法、不加新註解欄位。純渲染層 + 一個純函式抽出。
- 與 P2 的 custom-label（§2.8 `[標籤]`）不衝突：custom-label 換整個 node label；本功能是標頭下方的獨立操作區。若某行同時有 custom-label 與一般 @guide 文字，操作區顯示 resolveGuideText 後的完整 @guide 文字（含 [標籤] 也照 resolve）。

## Scope / 非目標

- 不顯示非 active 節點的操作；不做整條堆疊每個 frame 的操作（GDB 只給選取 frame 的值）。
- 不做操作歷史累積（先前 mockup C）；只顯示「當前」操作。
- 全局模式不顯示（節點太小）。
- 值強調靠 {變數} 分段；不解析 @guide 語意去猜哪些是「值」。

## 測試 / 驗收

- 單元測試（`guideText.ts`）：`resolveGuideText` 既有行為（{var} 替換、找不到保留、`func::var` 匹配）；`resolveGuideSegments` 正確切出字面/值分段。
- jest 全綠 + build 成功。
- 使用者驗收：Import `rec_knapsack.gdbgui.json` → Run → 切局部模式：目前節點標頭下出現當前操作（如「比較 不拿 3、拿 5」），綠色標出被動到的值；步進到下一行時操作區換內容並閃一下；非目前節點、全局模式都不顯示操作區。
