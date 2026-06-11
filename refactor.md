```markdown
# VisualizerHelper 容器解析器重構計劃

## 背景與動機

目前 `VisualizerHelper.js` 的 `checkStore` 函數內有一大塊 `if/else`，
把「類型判斷」、「GDB 格式偵測」、「異步等待」、「值解析」全混在一起。

主要痛點：
- 新增容器格式支援需要修改同一個巨大函數
- `setTimeout(checkStore, 150) + return` 散落各處，難以追蹤狀態
- `fetch_and_show_children_for_var` 被重複呼叫導致 queue flooding（已有 `show_children_in_ui` guard 修補）
- 難以為單一解析邏輯撰寫單元測試

重構**不改變行為**，只改善結構。前提：**所有 26 個 e2e 測試全部通過**後才開始。

---

## 設計模式選擇

| 模式 | 用途 |
|------|------|
| **Strategy** | 每種容器類型對應一個獨立解析器，彼此不互相干擾 |
| **Chain of Responsibility** | 同類型容器有多種 GDB 格式時，依序嘗試直到有人能處理 |
| **Async Poll helper** | 取代散落的 `setTimeout(checkStore, N) + return` |

---

## 目標架構

```
src/js/
└── containerParsers/
    ├── index.js              ← 組裝責任鏈、匯出 resolveChildValues()
    ├── ContainerParser.js    ← 基底介面
    ├── StringParser.js
    ├── MapParser.js          ← flat alternating + {first,second} 兩種格式
    ├── UnorderedMapParser.js ← 繼承 MapParser 或共用邏輯
    ├── ArrayParser.js        ← 責任鏈：pp → struct layout → value fallback → element vars
    ├── SetParser.js
    ├── InnerContainerParser.js  ← stack/queue/deque 嵌套展開
    └── DefaultParser.js      ← 直接 children.map(c => c.value)
```

`VisualizerHelper.js` 的 `checkStore` 只保留「找到 varObj → 呼叫 resolveChildValues() → 等結果 → 存入 payload」的骨架。

---

## 核心介面定義

### ContainerParser（基底）

```js
class ContainerParser {
  /**
   * 判斷此 parser 是否能處理目前狀態。
   * @param {string} containerName  e.g. "array", "map"
   * @param {object} varObj         GDB var 物件（含 children, value, numchild, type）
   * @returns {boolean}
   */
  canHandle(containerName, varObj) {
    return false;
  }

  /**
   * 執行解析。
   * - 若資料已備齊，回傳 { done: true, values: [...] }
   * - 若需等待（fetch in-flight），回傳 { done: false, retryMs: 150 }
   * @param {object} varObj
   * @param {object} context  { trimmedInst, expressions, GdbVariable }
   * @returns {{ done: boolean, values?: any[], retryMs?: number }}
   */
  parse(varObj, context) {
    throw new Error("Not implemented");
  }
}
```

### resolveChildValues()（給 checkStore 呼叫）

```js
/**
 * 遍歷責任鏈，找到第一個 canHandle 的 parser 並呼叫 parse()。
 * 若 done=false，呼叫端應 setTimeout(checkStore, retryMs) 並 return。
 */
function resolveChildValues(containerName, varObj, context) {
  for (const parser of parserChain) {
    if (parser.canHandle(containerName, varObj)) {
      return parser.parse(varObj, context);
    }
  }
  // 不應到達這裡（DefaultParser 永遠 canHandle）
  return { done: true, values: [] };
}
```

### 責任鏈順序

```js
const parserChain = [
  new StringParser(),
  new MapParser(),          // map + multimap
  new UnorderedMapParser(), // unordered_map + unordered_multimap
  new SetParser(),          // set + multiset + unordered_set
  new InnerContainerParser(), // stack / queue / deque（嵌套展開）
  new ArrayParser(),        // 內部自帶子責任鏈
  new DefaultParser(),      // fallback
];
```

---

## 各 Parser 實作說明

### StringParser

```js
canHandle(name, _) { return name === "string"; }
parse(varObj, _) {
  let s = varObj.value || "";
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return { done: true, values: s.split('') };
}
```

### MapParser

支援兩種 GDB 格式：
1. **新格式**（libstdc++ pretty-printer）：flat alternating `[0]=key, [1]=val, [2]=key ...`
2. **舊格式**：每個 child 的 value 為 `{first = K, second = V}`

```js
canHandle(name, _) {
  return ["map","multimap","unordered_map","unordered_multimap"].includes(name);
}
parse(varObj, _) {
  const ch = varObj.children;
  const firstStr = ch.length > 0 ? String(ch[0].value || "").trim() : "";
  if (ch.length > 0 && !firstStr.includes('first = ') && ch.length % 2 === 0) {
    // 新格式
    const values = [];
    for (let i = 0; i + 1 < ch.length; i += 2) {
      let k = String(ch[i].value || "").trim();
      let v = String(ch[i+1].value || "").trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      values.push({ key: k, value: v });
    }
    return { done: true, values };
  } else {
    // 舊格式
    const values = ch.map(child => {
      const str = String(child.value || "").trim();
      const fi = str.indexOf('first = ');
      const si = str.lastIndexOf(', second = ');
      if (fi !== -1 && si !== -1) {
        return { key: str.slice(fi+8, si).trim(), value: str.slice(si+11).replace(/\s*\}$/, '').trim() };
      }
      return { key: String(ch.indexOf(child)), value: str };
    });
    return { done: true, values };
  }
}
```

### ArrayParser（內部子責任鏈）

ArrayParser 本身包含三個子策略，依序嘗試：

```
ArrayPrettyPrinterStrategy    ← isAccessSection 全為 false → 直接讀 children
ArrayStructLayoutStrategy     ← 導航 public → _M_elems → elements
  ├─ 若 _M_elems.numchild > 0 → fetch children（含 guard）
  └─ 若 numchild = 0 且 value 非 "[N]" → 直接解析 value
ArrayValueFallbackStrategy    ← numchild=0 且 value="[N]" → 解析 varObj.value
ArrayElementVarsStrategy      ← 最後手段：create a[0], a[1], a[2]
```

關鍵規則：
- 每次觸發 `fetch_and_show_children_for_var` 前必須檢查 `!obj.show_children_in_ui`（防止 queue flooding）
- 返回 `{ done: false, retryMs: 150 }` 由呼叫端處理重試

### InnerContainerParser

處理 `stack`、`queue`、`deque` 的嵌套結構：

```js
canHandle(name, _) { return ["stack","queue","deque"].includes(name); }
parse(varObj, context) {
  // 若有 inner container child 尚未展開 → fetch → { done: false }
  // 若展開完成 → flatMap children.children → { done: true, values }
  // 若只有一層 [[...]] → 扁平化
}
```

### DefaultParser

```js
canHandle(_, __) { return true; } // 永遠接手
parse(varObj, _) {
  return { done: true, values: varObj.children.map(c => c.value) };
}
```

---

## checkStore 骨架（重構後）

```js
const checkStore = () => {
  checkTicks++;
  if (checkTicks > 150) { resolve(trimmedInst); return; }

  const expressions = store.get("expressions");
  const varObj = expressions.find(
    obj => obj.expression === displayKey && obj.in_scope === "true"
  );
  if (!varObj) { setTimeout(checkStore, 100); return; }

  // ── 空容器快速路徑 ──
  if (isEmpty(varObj)) {
    resolveEmpty(containerName, trimmedInst, frame_line, resolve);
    return;
  }
  // ── numchild=0 但 value 有內容（pretty-printer 直接塞值）──
  if (isValueOnlyContainer(varObj)) {
    resolveFromValue(varObj, containerName, trimmedInst, frame_line, resolve);
    return;
  }
  // ── 等待 children 載入 ──
  if (varObj.numchild > 0 && varObj.children.length === 0) {
    GdbVariable.fetch_and_show_children_for_var(varObj.name);
    setTimeout(checkStore, 200);
    return;
  }

  // ── 解析 ──
  const result = resolveChildValues(containerName, varObj, {
    trimmedInst, expressions, GdbVariable
  });

  if (!result.done) {
    setTimeout(checkStore, result.retryMs ?? 150);
    return;
  }

  // ── 完成 ──
  storeAndResolve(result.values, containerName, trimmedInst, frame_line, resolve);
};
```

---

## 實作步驟

1. **建立 `containerParsers/` 目錄與 `ContainerParser.js` 基底**
2. **逐一移植現有邏輯**至各 Parser，每移一個就跑一次 `docker compose ... up`
3. **整合 `resolveChildValues()`**，替換 checkStore 內對應的 `else if` 區塊
4. **移除舊的 `else if` 骨架**，替換成新骨架
5. **全部 26 個測試通過**才算完成

> **每個步驟都是一個獨立 commit，且每次都需要所有測試通過才繼續。**

---

## 不在本次重構範圍內

- `GdbVariable.tsx` 的修改
- `checkStore` 以外的 VisualizerHelper 邏輯
- BST / RB-tree 繪製邏輯
- 測試檔案

---

## 驗收標準

- `docker compose -f docker-compose.test.yml up --exit-code-from e2e` 全部 26 個測試通過
- `checkStore` 函數本體不再有容器解析邏輯（只有骨架）
- 每個 Parser 可被獨立 `import` 與單元測試
```