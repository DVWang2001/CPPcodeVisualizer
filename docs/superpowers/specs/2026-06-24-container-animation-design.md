# Container Animation Design

**日期**: 2026-06-24
**範圍**: 為所有資料結構視覺化物件加入動畫（Linear containers + Maze）

## 背景

目前只有 BST（BSTPlugin）有完整的動畫系統（compare walk、insert fade-in、erase fade-out、position move、find highlight）。Linear containers（vector/list/queue/stack/deque/array/string）和 Maze mode 都是即時渲染，沒有動畫。

## 目標

所有容器視覺化物件在狀態變化時都有動畫，遵循「白板/教科書」設計風格。

## 方案選擇

**選定：Approach A — Plugin 架構**

建立 `LinearPlugin` 和 `MazePlugin`，實作現有 `ContainerPlugin` interface，整合 `AnimScheduler` barrier。

選擇原因：
- 與 BSTPlugin 模式一致
- Barrier 整合確保 GDB stepping 會等動畫完成
- 渲染邏輯從 ContainerVisualizer（589 行）移入 plugin，讓主元件瘦身
- 各 plugin 可獨立測試

## 動畫視覺語言

### 設計原則

延續白板/教科書風格。動畫如同「老師在白板上一步步畫圖」：
- 琥珀色（amber）高亮 = 「老師的手正在這裡」
- 顏色代表狀態，不代表操作種類
- 一次只做一件事，有節奏感

### CSS 變數（新增到 `:root`）

```css
:root {
  --anim-base:     400ms;
  --anim-fast:     200ms;
  --anim-slide:    500ms;
  --anim-ease:     cubic-bezier(0.4, 0, 0.2, 1);
  --anim-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --anim-ease-in:  cubic-bezier(0.4, 0, 1, 1);
}
```

### 操作動畫編排

| 操作 | 第 1 步 | 第 2 步 | 第 3 步 |
|------|---------|---------|---------|
| **insert** | 插入位置亮琥珀色 | 右方 cell 滑動讓出空間 | 新 cell 淡入 + 放大 |
| **erase** | 目標 cell 亮琥珀色 | cell 淡出 + 縮小 | 右方 cell 滑動補齊 |
| **valueChange** | cell 閃琥珀色 | 值交叉淡入 | 閃爍淡去 |
| **swap** | 兩 cell 同時亮琥珀色 | 兩 cell 滑到對方位置 | 琥珀色消退 |
| **pushBack** | 新 cell 從右側滑入 | 就定位 | — |
| **popBack** | 最後 cell 亮琥珀色 | 向右滑出 + 淡出 | — |
| **pushFront** | 現有 cell 右滑 | 新 cell 從左側滑入 | — |
| **popFront** | 第一個 cell 亮琥珀色 | 向左滑出 + 淡出 | 剩餘 cell 左滑 |
| **maze cellChange** | — | background-color 過渡 200ms | — |

## 架構設計

### 新增檔案

| 檔案 | 職責 |
|------|------|
| `gdbgui/src/js/LinearPlugin.ts` | `ContainerPlugin` 實作：diff、動畫、渲染 linear containers |
| `gdbgui/src/js/MazePlugin.ts` | `ContainerPlugin` 實作：diff、動畫、渲染 maze mode |
| `gdbgui/src/js/tests/LinearPlugin.jest.ts` | diffOps 單元測試 |
| `gdbgui/src/js/tests/MazePlugin.jest.ts` | diffOps 單元測試 |

### 資料流

```
GDB step → inferior_program_paused
  → _pollContainers() 掃描所有容器
    → 對每個容器呼叫 plugin.diffOps(name, newData)
      → LinearPlugin: 比對歷史 → 回傳 PluginOp[]
      → MazePlugin:   比對歷史 → 回傳 PluginOp[]
    → animScheduler.pushOps(name, ops, animateFn)
      → 依序執行 animateOp()
      → 全部完成 → resolve barrier → GDB 繼續下一步
```

### LinearPlugin 內部設計

**歷史追蹤：**
```typescript
private history = new Map<string, { values: string[], type: string }>();
```

**diffOps 演算法：**

1. **長度相同，值不同** → 找出改變的 index
   - 恰好兩個 index 值互換 → `swap` op
   - 否則 → 每個改變 index 一個 `valueChange` op
2. **長度增加 1** → 偵測插入位置
   - 尾端 → `pushBack`；前端 → `pushFront`；中間 → `insert`
3. **長度減少 1** → 偵測刪除位置
   - 尾端 → `popBack`；前端 → `popFront`；中間 → `erase`
4. **長度差 > 1** → `bulkChange` op（整體淡入淡出）

**animateOp：**
每個 op type 對應 async 函式，用 `delay()` + `afterFrame()` 控制時序，修改內部 animation state 後呼叫 `requestRender()` 觸發重繪。

**render：**
從 `ContainerVisualizer.renderContainerShape` 搬入 linear container 渲染邏輯，加上動畫相關 inline style（opacity、transform、transition）。

### MazePlugin 內部設計

- 歷史：`Map<string, number[][]>`
- `diffOps`：逐 cell 比較 → 變化的 cell 產生 `cellChange` op
- `animateOp`：設定 cell transition + 更新顏色
- `render`：從 `ContainerVisualizer.renderMaze` 搬入，加 per-cell transition

### ContainerVisualizer 變化

**瘦身：**
- 移除 `renderContainerShape` 中 linear container 和 maze 的渲染程式碼
- 統一改為 `plugin.render(name)` 委託渲染
- `_pollContainers` 不再限制只對 `bstMode` 容器呼叫 diffOps，改為對所有容器都檢查 plugin

**保留：**
- 容器卡片外框（border、shadow、name/type 標籤）
- Toggle UI（BST mode、Maze mode）
- Font size 控制
- Maze color rule editor

### PluginOp payload 定義

```typescript
// LinearPlugin ops:
{ type: 'insert',      payload: { index: number, value: string } }
{ type: 'erase',       payload: { index: number, value: string } }
{ type: 'valueChange', payload: { index: number, oldValue: string, newValue: string } }
{ type: 'swap',        payload: { indexA: number, indexB: number } }
{ type: 'pushBack',    payload: { value: string } }
{ type: 'popBack',     payload: { value: string } }
{ type: 'pushFront',   payload: { value: string } }
{ type: 'popFront',    payload: { value: string } }
{ type: 'bulkChange',  payload: {} }

// MazePlugin ops:
{ type: 'cellChange',  payload: { row: number, col: number, oldValue: number, newValue: number } }
```

## 測試策略

### 單元測試（Jest）

| 測試檔案 | 測試內容 |
|----------|----------|
| `LinearPlugin.jest.ts` | diffOps 偵測正確性：insert/erase/swap/valueChange/push/pop/bulkChange；resetContainer/resetAll |
| `MazePlugin.jest.ts` | diffOps 逐 cell 比對；initial load（空→有值）不產生逐 cell 動畫 |

只測 diffOps 產出的 ops（純邏輯），不測 CSS 動畫時序。與 `BSTPlugin.jest.ts` 模式一致。

### E2E 合約

渲染搬到 plugin 後，`data-testid="container-cell"` 等 selector 必須保持不變。

## 邊界條件

| 情境 | 處理方式 |
|------|----------|
| 容器 0 → N（initial load） | `bulkChange` → 整體淡入 |
| 容器 N → 0（clear） | `bulkChange` → 整體淡出 |
| 長度差 > 1 | `bulkChange` → 整體過渡 |
| 快速連續 step | AnimScheduler barrier 確保動畫完成才進下一步 |
| 容器離開 scope | `resetContainer()` 清除歷史和動畫 |
| 程式重啟 | `resetAll()` 清除所有狀態 |
| Maze mode 開/關 | 開啟時開始追蹤歷史；關閉時 resetContainer |

## 不在範圍內

- 速度滑桿（沿用 CSS 變數控制速度）
- Undo/replay
- AnimScheduler 核心邏輯變更
- unordered_map 動畫（hash-based，操作順序無教學意義）
- CallGraph 動畫
- UI 層微動畫（panel、button hover）
