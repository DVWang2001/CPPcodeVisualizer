# 呼叫圖 鏡頭視角切換（全局/局部）Design

**Date:** 2026-07-21
**Status:** Draft, pending user review
**Affects:** `gdbgui/src/js/CallGraph.tsx`（單一元件）
**Reference impl:** 已驗證的互動 mockup（scratchpad `view-toggle-mockup.html`）— 鏡頭模型、遞迴進入 dolly、返回值上飄的完整可運作邏輯都在裡面。

## 問題

呼叫樹一大就畫得太大、每個節點看不清，捲來捲去失去方向感（幽靈預跑把整棵樹一次畫出後尤其明顯）。

## 解：把「捲動看大樹」換成「鏡頭在固定的樹上移動」

樹用**固定佈局**（沿用既有 `layoutTree` / 幽靈提供的座標，不變），呼叫圖容器改成 `overflow:hidden` + 內層一層 `transform: translate(...) scale(...)` 當**鏡頭**。加一個 `[全局][局部]` 雙段切換：

- **全局**：鏡頭拉遠 —— `scale = min(vw/treeW, vh/treeH)*0.92`、置中，整棵樹一次看到（小）。保留既有著色（目前節點琥珀、活躍路徑靛藍、其餘變淡）與 ×N 徽章。
- **局部**：鏡頭拉近 `scale=1`，對準目前節點（activeNode）—— 目前節點放視窗上方（約 88px），其直接子節點在下方；`transform` 帶 0.6s 緩動。**只有目前節點（琥珀）+ 直接子節點（靛藍框）高亮，其餘變淡**（仍在畫面上、飛過時看得到結構）。activeNode 改變 → 更新 transform → 鏡頭 dolly 過去。

### 遞迴進入（往下）

activeNode 變成子節點 → 鏡頭往子節點方向 dolly（transform 平移，父節點滑出上緣）、焦點移到子節點。純鏡頭移動，樹不重排。

### 返回（往上）

activeNode 變回父節點 → 鏡頭往上 dolly 回父節點。**額外演出「值上飄」**：沿用 P1 已有的 `retValue`/`justReturned`，當某節點剛返回，一個綠色 `⇒值` token 沿邊從子節點飄到父節點（≈0.7s 後淡出）。返回的子節點著色為「已返回」（淡 + 綠色 `⇒值` 留著，沿用 P1 的節點狀態）。

## 與現有功能整合（都要保留）

CallGraph 目前已有：幽靈骨架（P3）、×N 配對 + hover + 停駐紅框（P2）、深度徽章（P2）、邊上呼叫點標籤（P2）、點節點跳行（P1）、`⇒值`/`↑值`（P1）。**這些全部保留**，只是改成畫在「固定佈局 + 鏡頭 transform」的座標系裡：

- 佈局座標不再隨模式改變（現在是 scroll 容器 + 依模式重排）→ 改成固定一次、鏡頭移動。
- 幽靈骨架：全局模式照畫（整棵含未實現的虛線框）；局部模式可只保留 activeNode 的幽靈子節點（預告下一步）或全隱藏 —— 取最省事者，預設局部隱藏幽靈。
- ×N 徽章、深度、邊標籤：照現有邏輯畫在節點/邊上，跟著鏡頭 transform 一起移動。
- 點節點跳行：不受影響（節點還是可點）。
- 既有的 `componentDidUpdate` scrollIntoView（把 active 捲入視窗）→ 由鏡頭 transform 取代（局部模式對準 active；全局模式不需要）。

## 狀態與按鈕

- `CallGraphState` 增 `viewMode: 'global' | 'local'`，預設 `'global'`（維持現況；使用者點局部聚焦）。
- 雙段按鈕放呼叫圖面板右上角（token 樣式，靛藍 accent），沿用 mockup 的視覺。

## Scope / 非目標

- 不改資料模型、不改後端。純 CallGraph.tsx 渲染層。
- 不做拖曳平移/手動縮放（鏡頭全自動跟 activeNode）。
- 值上飄 token 是加分項；若與現有 `↑值` 重疊衝突難整合，退回「只有鏡頭上移 + 既有 ↑值」，不阻擋主功能。

## 測試 / 驗收

- 現有 jest 全綠（本功能主要是渲染，無新純函式；若抽出 camera transform 計算為純函式則加單元測試：給定 treeW/H、viewport、activeNode 座標，回傳正確 translate/scale）。
- build 成功。
- 部署後使用者驗收：Import `rec_knapsack.gdbgui.json` → Run →
  - 全局：整棵樹縮小可見；點「局部」鏡頭拉近對準目前節點。
  - 局部：遞迴進入時鏡頭往子節點 dolly、返回時綠色值上飄 + 鏡頭上移，節點大而清楚，全程不亂跳。
  - 幽靈、×N、深度、邊標籤、跳行都還在。
