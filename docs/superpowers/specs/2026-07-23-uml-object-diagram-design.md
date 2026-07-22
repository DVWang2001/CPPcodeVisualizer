# UML 動態物件圖（使用者自訂 class）Design

**Date:** 2026-07-23
**Status:** Draft, pending user review
**Affects:** 新面板/plugin + `VisualizerHelper.js`（`uml:` 指令）+ 一個 ptype 查詢/解析器 + 物件圖建構器
**Reference mockup:** scratchpad `uml-object-mockup.html`（UML 框、可見性、方法區、繼承三角、指標箭頭）

## 目標

讓學生看到**自己寫的 class**（非 STL，現有容器視覺化畫不出來）的**動態物件圖**：從一個起點變數展開，跟著指標把整個物件網畫成 UML 框，每格顯示欄位即時值、成員可見性、方法、與繼承關係。

## 觸發

`@guide` 加 `uml:變數名` 指令（與 `bst:`、`maze:` 同一套語法，在 `VisualizerHelper.processing_guide` 解析）。變數是起點，通常是指標（`uml:head`、`uml:root`）或物件（`uml:myObj`）。

## 資料來源（兩路合併）

1. **類別結構 —— `ptype`**（新的 GDB 互動；目前系統未用）：對物件的類別執行 `ptype <ClassName>`，解析出：
   - 基底類別與繼承存取（`class Dog : public Animal`）。
   - 成員欄位：名稱、型別、**可見性**（`public:` / `private:` / `protected:` 分區）。
   - 方法：簽章 + 可見性。
   parser 吃 ptype 的文字輸出（分區規則固定，可測試的純函式）。
2. **即時值 —— GDB varobj children**（沿用現有機制）：物件 varobj 的 children = 欄位當前值；基底子物件是一個特殊 child，其 children = 繼承欄位的值。
3. **合併**：ptype 給結構（順序、可見性、方法、基底），varobj 給每個欄位的即時值。

## 跟指標展開成物件圖

- 從起點物件開始，**以物件位址當節點身分**（dedup + 偵測環）。
- 對每個「指向 class/struct 的非空指標欄位」，跟著展開被指到的物件（用 `*(ClassName*)addr` 這類位址轉型表達式建 varobj，避免長路徑；BFS）。
- **節點上限 ~30**（與呼叫樹同 scope）；達上限或遇環即停，超出的指標標示「…」不展開。
- 結果寫進 `global_variable.__latest_uml`（節點清單 + 邊清單），面板讀取渲染。

## 渲染（新 UML 面板 / plugin）

每個物件一個 **UML 框**（三格，仿 mockup）：
- **標頭**：`ClassName`（小字附 `@位址`）。
- **屬性格**：每欄位一行 `<可見性> 名稱 = 即時值`。可見性標記：`+` public（綠）、`−` private（紅）、`#` protected（琥珀）。值變動時閃黃。
- **方法格**：每方法一行 `<可見性> 名稱(簽章)`（靜態，無值）。
- **指標欄位**：畫成箭頭連到目標物件框；null 顯示 `∅`。
- **繼承**：基底類別畫成**獨立框**，derived 用**空心三角箭頭**指向基底（正式 UML）；基底框內顯示基底自己的欄位（含即時值）與方法。多層繼承往上疊。
- **布局**：linked list = 橫向鏈、tree = 樹狀（重用 `callGraphLayout` / `BSTPlugin` 佈局概念）；繼承往上、指標往下/橫向。

## 沿用與新增

- **沿用**：`VisualizerHelper` 指令解析與 varobj 建立、`ContainerVisualizer` 的面板/plugin 註冊、`RightSidebar` 加 Collapser、SVG 節點框繪製（`CallGraph.tsx` / `BSTPlugin.ts` 範例）、`ContainerPlugin` 介面。
- **新增**：`uml:` 指令分支、ptype 查詢與純函式 parser（`umlType.ts`）、物件圖建構器（跟指標 + dedup + cap）、UML 渲染 plugin/面板（`UMLPlugin` 或新 `UMLVisualizer`）。

## 實作階段（里程碑）

1. **P1 單框 + 即時值**：`uml:varName` → 一個物件框，欄位名=值（varobj children）。建立指令、面板、資料流。先不做 ptype、不展開。
2. **P2 結構（ptype）**：可見性 +/−/#、方法區、繼承（基底獨立框 + 三角）。加 ptype 查詢 + parser + 合併。
3. **P3 跟指標展開成圖**：BFS 跟指標、位址 dedup、防環、~30 上限、多框佈局 + 指標箭頭。

每階段可獨立驗收（Import 一個含 `uml:` 的教案 → Run → 看對應層級的圖）。

## Scope / 非目標

- 只做物件圖（即時值），方法只顯示簽章不顯示狀態。
- STL 容器仍走現有容器視覺化，不在此。
- 不做關聯/聚合的完整 UML 關係分類（除繼承外，指標一律以箭頭表示「參考」）。
- 不做 template 展開、不做 static 成員特別處理（v1）。

## 測試 / 驗收

- 純函式單元測試：ptype parser（分區→可見性、基底、方法）、物件圖建構器（dedup、環、cap）。
- 容器實跑：以自訂 `Node`（linked list）、`TreeNode`（tree）、`Dog:Animal`（繼承）教案，用容器 gdb 驗證 ptype 輸出與 varobj children 可取得。
- jest / pytest 綠、build 成功、部署後使用者 Import 教案驗收各階段畫面。
