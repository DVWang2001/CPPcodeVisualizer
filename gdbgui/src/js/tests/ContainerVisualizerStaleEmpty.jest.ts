// 使用者回報：map/set 這類動態容器從空的長大之後，「資料結構視覺化」面板永遠卡在
// empty，即使區域變數面板已經正確顯示內容。根因：`__latest_containers` 只在「目前
// 這一行的 @guide 文字剛好引用 {容器名}」時才會被 VisualizerHelper.js 重新計算——
// has_more 修好之後，子節點資料常常是插入那一行「之後」才非同步到位，教案若沒有在
// 後面每一行都重複寫 {容器名}，widget 就永遠讀不到已經補齊的資料。
// 這支測試直接驗證 ContainerVisualizer 每秒輪詢時會自己抓這個落差補上，不依賴
// guide token 再次命中同一個容器。
import ContainerVisualizer from "../ContainerVisualizer";
import { global_variable } from "../global_variable";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

function makeVisualizer() {
  const visualizer = new (ContainerVisualizer as any)({});
  visualizer._lastResetRunGen = 0;
  visualizer.forceUpdate = jest.fn();
  return visualizer;
}

test("容器快取還是空的、但底層 var-object 已經有完整子節點：輪詢時直接補上，不必等 guide token 再次命中", () => {
  (global_variable as any).__run_generation = 0;
  (global_variable as any).__latest_containers = new Map([
    ["x", { name: "main::x", type: "map", isContainer: true, values: [] }],
  ]);
  store.set("expressions", [
    {
      expression: "main::x",
      in_scope: "true",
      name: "var1",
      numchild: 2,
      value: "std::map with 1 element",
      children: [
        { exp: "[0]", value: "1", type: "const int" },
        { exp: "[1]", value: "10", type: "int" },
      ],
    },
  ]);

  const visualizer = makeVisualizer();
  visualizer._pollContainers();

  const healed = (global_variable as any).__latest_containers.get("x");
  expect(healed.values).toEqual([{ key: "1", value: "10" }]);
});

test("底層 var-object 的子節點還沒載完（children.length 跟 numchild 對不上）：不要用不完整的資料誤補", () => {
  (global_variable as any).__run_generation = 0;
  (global_variable as any).__latest_containers = new Map([
    ["y", { name: "main::y", type: "set", isContainer: true, values: [] }],
  ]);
  store.set("expressions", [
    {
      expression: "main::y",
      in_scope: "true",
      name: "var2",
      numchild: 1,
      value: "std::set with 1 element",
      children: [], // 還在等 -var-list-children 回應
    },
  ]);

  const visualizer = makeVisualizer();
  visualizer._pollContainers();

  const stillEmpty = (global_variable as any).__latest_containers.get("y");
  expect(stillEmpty.values).toEqual([]);
});

test("容器本來就有值了：不去動它，避免蓋掉 guide-token 路徑本來就會處理的正常更新", () => {
  (global_variable as any).__run_generation = 0;
  const original = { name: "main::z", type: "vector", isContainer: true, values: ["7"] };
  (global_variable as any).__latest_containers = new Map([["z", original]]);
  store.set("expressions", [
    {
      expression: "main::z",
      in_scope: "true",
      name: "var3",
      numchild: 2,
      value: "std::vector of length 2",
      children: [
        { exp: "[0]", value: "7" },
        { exp: "[1]", value: "9" },
      ],
    },
  ]);

  const visualizer = makeVisualizer();
  visualizer._pollContainers();

  expect((global_variable as any).__latest_containers.get("z")).toBe(original);
});
