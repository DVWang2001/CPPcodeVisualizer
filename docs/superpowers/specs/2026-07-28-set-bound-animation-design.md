# set/multiset `lower_bound` / `upper_bound` 動畫 Design

**Date:** 2026-07-28
**Status:** Draft, pending user review
**Affects:** `gdbgui/src/js/BSTPlugin.ts`、`gdbgui/src/js/VisualizerHelper.js`、`gdbgui/src/js/tests/BSTPlugin.jest.ts`
**Builds on:** 容器動畫框架（`2026-06-24-container-animation-design.md`）— 沿用既有 plugin / AnimScheduler barrier 機制，不改介面。

## 問題

使用者要 set/multiset 的 `insert` / `find` / `lower_bound` / `upper_bound` / `erase` 都有動畫。盤點現況後，五個裡有三個已經有了：

| 操作 | 現況 | 觸發機制 |
|---|---|---|
| `insert` | ✅ 比對路徑逐點高亮 → 新節點淡入 | `diffOps` 狀態 diff（`BSTPlugin.ts:196-215`） |
| `erase` | ✅ 比對路徑 → 淡出 | `diffOps` 狀態 diff（`BSTPlugin.ts:176-194`） |
| `find` / `count` / `contains` | ✅ 比對路徑 → 綠/紅結果 | 原始碼 regex 預先偵測（`VisualizerHelper.js:1148`） |
| `lower_bound` | ❌ 無 | — |
| `upper_bound` | ❌ 無 | — |

**本 spec 只補缺的兩個。** 現有三個動畫不動。

## 為什麼不能直接複用 find 動畫

`find` 是「一路往下走，看最後有沒有命中」。bound 是「一路往下走，**同時維護一個目前最佳候選**」——候選會在往左走時被更新、往右走時保持不變，最後停在候選上（或 `end()`）。那個滾動更新的候選就是 bound 的教學重點，`find` 動畫沒有這個概念。

| | 往左走的條件 | 終點 |
|---|---|---|
| `find` | `key < cur.key` | 走到 null，最後一個節點是否相等 |
| `lower_bound` | `cur.key >= key` → 設 cur 為候選，往左 | **命中相等即停**，否則走到 null |
| `upper_bound` | `cur.key > key` → 設 cur 為候選，往左 | 走到 null（無提早出口） |

### `lower_bound` 的提早出口

`lower_bound` 一旦命中 `cur.key == key` 就停止，不再往下走。在這棵樹上這是可以證明的：`bstInsertNode` 把相等的 key 一律往右插，所以任何節點的左子樹 key 全部**嚴格小於**它。命中後往左走，左子樹裡不可能再有 `>= key` 的節點，候選再也不會被換掉——剩下的步驟保證無效，動畫演出來只是浪費學生注意力。

**兩個沒有提早出口的情況**（不對稱本身就是教學點，剛好解釋了兩者為何不同）：

- **`lower_bound` 沒命中時**：例如 `{1,3,5,7,9}` 的 `lower_bound(4)` 永遠不會相等。候選在第一步就設成 5，但必須把左子樹走完才敢確定沒有更小的合格者。
- **`upper_bound` 永遠沒有**：它要嚴格大於，遇到相等是「不合格、往右走」，根本不會產生「命中」事件。

### 與真實 STL 的差異（已知且接受）

libstdc++ 的 `_Rb_tree::lower_bound` **不會**提早跳出，它一路走到 null。因為真實紅黑樹有旋轉，相等的 key 可能被轉進左子樹，提早停就會回傳到非最左邊的那個。本專案畫的是樸素 BST（`BSTPlugin.ts:412` 的畫面說明已標示「按插入順序建樹，無旋轉」），在這個前提下提早停是正確的。使用者已明確確認採用樸素 BST 語意。

### multiset 正確性

現有 `bstInsertNode`（`BSTPlugin.ts:39-45`）把相等的 key 放右子樹，所以重複值往右串成鏈。上表的候選規則在這種形狀上仍然正確：

- `lower_bound(5)` 於 `5→5→5` 右鏈：在根就 `5 >= 5` 命中 → 設候選 = 根、**立即停止**（一步結束）→ 答案是**最左邊那個 5** ✅
- `upper_bound(5)` 於同一棵樹：每個節點都 `5 > 5` 為假 → 一路往右到 null，候選始終為 null → `end()` ✅（若 5 是最大值）

## 解：候選標記 + 結果字幕

走比對路徑時：

- **當前比對節點**：沿用既有橘色實心（`#ff9800` / stroke `#e65100`），與 find 動畫一致。
- **目前候選節點**：另外加一圈**藍色虛線外框**（`stroke #1976d2`、`strokeWidth 4`、`strokeDasharray '4 3'`），fill 不變。刻意選 stroke 而非 fill，讓「當前比對節點同時也是候選」時兩種狀態能疊在同一顆節點上而不互相蓋掉——這正是往左走那一刻要讓學生看見的事。
- **走完**：候選轉綠（沿用既有 `findResultId` 的綠色成功樣式），藍虛線同時撤掉（已經是答案，不再是「候選」）。
- **字幕**：樹下方顯示 `lower_bound(7) → 5`；無解時顯示 `lower_bound(9) → end()`。

字幕一個欄位解兩件事：既說明結果，也讓 `end()` 這種「沒有節點可標」的情況不會看起來像壞掉。這是選 A 而不是 B（純複用 find、只標最終答案）的主因。

節奏沿用 find：每步 500ms，結果停留 800ms。

## 實作

### 1. 路徑與候選計算（`BSTPlugin.ts`，新函式）

```ts
export function computeBoundPath(
    root: BSTNode | null, key: string, strict: boolean
): { path: string[]; candidates: (string | null)[] }
```

逐節點下走，`path[i]` 是第 i 步造訪的節點 id，`candidates[i]` 是**造訪完 path[i] 之後**的候選 id（無則 null）。`strict = false` → `lower_bound`（`cur.key >= key`），`strict = true` → `upper_bound`（`cur.key > key`）。最終答案 = `candidates[candidates.length - 1] ?? null`；空樹時 `path` 與 `candidates` 皆為空陣列，答案為 null。

迴圈尾端的提早出口：`if (!strict && c === 0) break;`（`c` 為 `bstCmp(cur.entry.key, key)`）。註解要寫明理由——相等一律往右插故左子樹全部小於 key，候選已定案。

比較一律走既有的 `bstCmp`（數字優先、退回字串比較），與樹的建構規則保持一致。

`export` 是為了單元測試；`BSTNode` 型別同時需要 `export`。

### 2. 動畫狀態（`BSTPlugin.ts` 的 `BSTAnimState`）

新增兩個欄位，並在 `resetAll` / `resetContainer` 一併清除：

- `boundCandidateId: Map<string, string | null>`
- `boundCaption: Map<string, string | null>`

### 3. `_runBound()`（`BSTPlugin.ts`，新私有方法）

1. 逐步走 `path`：設 `comparingIds = {path[i]}`、`boundCandidateId = candidates[i]`，`requestRender()` → `afterFrame()` → `delay(500)`。
2. 清 `comparingIds`。
3. 算出 `final = candidates[candidates.length - 1] ?? null`（不用 `.at()`，避免踩到 TS target），設 `boundCaption = "<method>(<key>) → <label|end()>"`。
4. `final` 存在 → 清 `boundCandidateId`、設 `findResultId = { id: final, found: true }`。
5. `requestRender()`、`delay(800)`，然後清掉 `boundCandidateId` / `boundCaption` / `findResultId`，最後 `requestRender()`。

### 4. `prospectiveOp` 分支（`BSTPlugin.ts:242`）

新增 `'lowerBound'`（strict=false）與 `'upperBound'`（strict=true）兩個分支。建樹方式與既有 `'find'` 分支完全相同（過濾 `_deletingIds` 後逐個 `bstInsertNode`），然後呼叫 `computeBoundPath` + `_runBound`。字幕用的方法顯示名（`lower_bound` / `upper_bound`）由 opType 在 plugin 內部映射，不加參數。

### 5. 渲染（`BSTPlugin.ts:315-400`、`:403-413`）

- 讀出 `boundCand`，加 `const isCandidate = boundCand === node.entry.id`。
- circle 目前寫死 `strokeWidth: 2`；改為變數，`isCandidate` 且非最終結果時 → stroke `#1976d2`、strokeWidth `4`、strokeDasharray `'4 3'`。fill 的三元鏈**不動**（候選只影響外框）。
- 既有的「傳統二元搜尋樹…」說明 div 之後，`boundCaption` 非空時多渲染一個字幕 div，帶 `data-testid="bst-bound-caption"`。

### 6. 偵測（`VisualizerHelper.js:1148-1164`）

- regex 擴充：`(find|count|contains)` → `(find|count|contains|lower_bound|upper_bound)`。
- 第 1160 行寫死的 `'find'` 改為依 `matchFind[2]` 映射：`lower_bound` → `'lowerBound'`、`upper_bound` → `'upperBound'`、其餘 → `'find'`。

barrier 保留／釋放、`evalKey`、TTS 同步時序全部沿用既有 `tryReserve` + `reserveBarrier` 路徑，一行不改。`displayKey` 前綴沿用 `bst_find::`（同一行只會 match 一次，不會撞名）。

## Scope / 非目標

- **不做真實紅黑樹旋轉動畫。** 目前畫面畫的是按插入順序建的樸素 BST（`BSTPlugin.ts:412` 的說明文字已誠實標示）；動畫與畫面一致即可，改成真 RB-tree 是另一個題目。
- 不動 `insert` / `find` / `erase` 現有動畫。
- 不處理 `map` / `multimap` 的 bound。plugin 的 `supportedTypes` 涵蓋四種型別，新分支對 map 也會運作（key 比較邏輯相同），但本次不特別驗證。
- 不處理 `s.insert(s.lower_bound(x), v)` 這類巢狀呼叫；regex 只 match 第一個容器方法。
- 不處理 `equal_range`。

## 驗證

`gdbgui/src/js/tests/BSTPlugin.jest.ts` 加一組 `computeBoundPath` 單元測試，涵蓋：

1. set（插入順序 `5,3,7,1,9`）：`lower_bound(3)` → 3、`lower_bound(4)` → 5、`upper_bound(3)` → 5。
2. multiset 重複鍵（插入順序 `5,2,5,8,5`）：`lower_bound(5)` 落在**最左邊**的 5；`upper_bound(5)` → 8。
3. `end()`：`lower_bound(99)` 與空樹兩種情況都回傳 null。
4. **提早出口**：set 的 `lower_bound(3)` 其 `path` 長度為 2（`5, 3`），**不含**節點 1 —— 這是最容易在後續重構中被改壞的一條。
5. `upper_bound` 對相等鍵**不**提早退出：multiset 的 `upper_bound(5)` 走完整條路徑到 null。

以及 `candidates` 陣列長度等於 `path` 長度（動畫逐步取用的前提，提早 break 時也必須成立）。
