// BST 模式勾起來卻不畫樹的根因：LinearPlugin.supportedTypes 含 'set'/'map'，而它在 BSTPlugin
// 之後才登錄，registerPlugin 對同一個型別是「後來者蓋掉前者」，於是 getPlugin('set') 回傳的
// 是 LinearPlugin，BSTPlugin.render 從頭到尾沒被呼叫（__bst_history 恆為空）。
// 這支測試釘住「誰負責哪個型別」，與登錄順序無關。
import "../ContainerVisualizer"; // 載入時登錄所有 plugin
import { getPlugin } from "../ContainerPlugin";
import { bstPlugin } from "../BSTPlugin";
import { linearPlugin } from "../LinearPlugin";

test("set/multiset/map/multimap 由 BSTPlugin 負責（勾 BST 模式時才畫得出樹）", () => {
  for (const t of ["set", "multiset", "map", "multimap"]) {
    expect(getPlugin(t)).toBe(bstPlugin);
  }
});

test("線性容器與 unordered_map 仍由 LinearPlugin 負責", () => {
  for (const t of ["vector", "list", "queue", "stack", "deque", "array", "string", "unordered_map"]) {
    expect(getPlugin(t)).toBe(linearPlugin);
  }
});
