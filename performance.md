# CPPcodeVisualizer 效能改進計劃

## 前提

所有改動都**必須通過**：
- `npm test` — 104 個 Jest 測試
- `docker compose -f docker-compose.test.yml up --exit-code-from e2e` — 26 個 e2e 測試

每一項改動獨立 commit，且每次 commit 前都需全部測試通過。

---

## 改動 1：移除 `InnerContainerParser` 的多餘 `store.set`（1 行，立即可做）

**檔案：** `gdbgui/src/js/containerParsers/InnerContainerParser.js`

**問題：**

```js
const exprs = store.get("expressions");
// ... 修改 child.numchild（in-place mutation，已直接影響 store 內的物件）...
store.set("expressions", exprs); // ← 多餘：觸發所有 subscriber 全量重繪
```

`store.get("expressions")` 回傳的是 reference，對 `child.numchild` 的修改已直接生效。緊接著呼叫 `store.set` 只是白白觸發一次 re-render。GDB 回應時會再觸發一次 `store.set`，那才是真正需要的。

**修改：** 刪除 `store.set("expressions", exprs)` 那一行（約第 38 行）。

**驗證：**
```bash
npm test
docker compose -f docker-compose.test.yml up --exit-code-from e2e
```

---

## 改動 2：用 Store 訂閱取代 `setTimeout` 輪詢（**已評估，暫不實作**）

**檔案：** `gdbgui/src/js/VisualizerHelper.js`

**問題：**

`checkStore` 閉包目前用 `setTimeout(checkStore, 150)` 盲目輪詢。每個容器視覺化啟動後，不管 GDB 有沒有回應都每 150ms 觸發一次。

**為何暫不實作（根本性架構衝突）：**

實作 `store.subscribeToKeys(["expressions"], callback)` 時發現：

1. **訂閱鍵太粗糙**：`"expressions"` 是整個 store 中所有 GDB 變數的共用 key。Tutorial 模式下同時監控 10+ 個容器，每個容器的 `children_fetched` 都會呼叫 `store.set("expressions")`，觸發所有其他容器的訂閱回呼。

2. **checkTicks 過快耗盡**：當 10 個容器同時在等待，每個容器的 `checkStore` 每 ~10ms 就被其他容器的 `store.set` 喚醒一次。`checkTicks > 150` 在 1.5 秒內觸發，容器資料尚未就緒就超時。

3. **store.set 自我觸發迴圈**：`fetch_and_show_children_for_var` 內部也呼叫 `store.set`，訂閱後立刻被自己觸發，形成迴圈（各種 guard 嘗試均無法完全解決，詳見 git 歷史）。

**正確做法需要**：針對個別 varobj 的細粒度訂閱，或將 `checkTicks` 改為時間戳記（而非呼叫次數）計算超時。這需要較大的重構，不在當前優先範圍。

**目前狀態**：保留 `setTimeout` 輪詢，改動 1 已完成（減少一次 re-render），改動 3、4 繼續。

---

## 改動 3：快取已解析的容器值（中等工作量）

**檔案：** `gdbgui/src/js/VisualizerHelper.js`

**問題：**

同一個 `trimmedInst`（如 `"v"`）在同一次 GDB stop 可能觸發多次 `play_tts`（重繪、tutorial replay 等），每次都重新啟動 `checkStore` 輪詢並重新解析相同的 `varObj`。

**修改方向：**

在 `play_tts` 內部或模組層級維護一個 `Map<string, Promise<string>>`，key 為 `trimmedInst + ":" + frame_line`：

```js
// 模組層級
const _tts_cache: Map<string, Promise<string>> = new Map();

// 在每次 GDB run/step 事件觸發時清除：
export function clearVisualizerCache() {
  _tts_cache.clear();
}

// 在 play_tts 開頭：
const cacheKey = `${trimmedInst}:${frame_line}`;
if (_tts_cache.has(cacheKey)) return _tts_cache.get(cacheKey);
const p = new Promise<string>((resolve) => { /* checkStore loop */ });
_tts_cache.set(cacheKey, p);
return p;
```

**驗證：**
```bash
npm test
docker compose -f docker-compose.test.yml up --exit-code-from e2e
```

---

## 改動 4：批次並行 fetch（高工作量，長期改善）

**檔案：** `gdbgui/src/js/GdbVariable.tsx`

**問題：**

`ChildVarFetcher` 的串行 queue 一次只能處理一個 `-var-list-children` 請求。當容器需要多層 fetch（如 `array`：先 fetch `public`，再 fetch `_M_elems`）時，每層都需要等待上一層完成，造成串聯延遲。

**修改方向：**

允許針對「不同 varobj」同時發送 2–3 個 GDB 請求（同一 varobj 仍需串行）。這需要修改 `ChildVarFetcher` 的 queue 邏輯，並確保 GDB MI 可以正確對應多個並發 request_id。

**風險：** GDB MI 協議的並發行為需要仔細測試，難度最高。建議最後實作。

**驗證：**
```bash
npm test
docker compose -f docker-compose.test.yml up --exit-code-from e2e
# 用 browser console 觀察 request_id 間隔是否縮短
```

---

## 優先順序

| 順序 | 改動 | 工作量 | 預期收益 |
|------|------|--------|----------|
| **1** | 刪多餘 `store.set` | 1 行 | 減少 re-render |
| **2** | Store 訂閱取代輪詢 | 中 | 平均 -75ms 延遲 |
| **3** | 快取已解析值 | 中 | 減少重複解析 |
| **4** | 批次並行 fetch | 高 | 減少多層等待 |
