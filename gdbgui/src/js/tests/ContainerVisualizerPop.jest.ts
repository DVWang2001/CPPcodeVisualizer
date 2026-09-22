// 真的掛載 ContainerVisualizer 元件，逐步驗證使用者回報的情境：
// pop:dp:orange 停在 int up 那一行第二次（同一顏色、不同格子，或甚至同一格子）
// 會不會真的重播動畫。純函式單元測試（cellPopKey.jest.ts）已經證明底層邏輯
// 正確；這裡額外用真實的 React render 流程再驗一次，排除「元件生命週期/render
// 沒有照純函式的方式串起來」這種整合層級的落差。
import React from "react";
import * as TestRenderer from "react-test-renderer";
const { act } = TestRenderer;
import ContainerVisualizer from "../ContainerVisualizer";
import { global_variable } from "../global_variable";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

function seedDp() {
  (global_variable as any).__latest_containers = new Map([
    ["dp", { name: "dp", type: "vector", isContainer: true, values: [[0, 0, 0], [0, 1, 2], [0, 3, 4]] }],
  ]);
  (global_variable as any).__latest_highlights = new Map([
    ["dp", [{ index: 1, color: "orange" }, { index: 3, color: "lime" }, { index: 4, color: "lightblue" }]],
  ]);
}

function hasCellPop(json: any): boolean {
  const found: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.props && n.props.className === "cell-pop") found.push(n);
    (n.children || []).forEach(walk);
  };
  walk(json);
  return found.length > 0;
}

test("停在 pop:dp:orange 那一行第二次，橘色格仍然要重播動畫（不是只有第一次有）", () => {
  seedDp();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ContainerVisualizer as any));
  });

  // 尚未觸發任何 pop：不該有 cell-pop
  expect(hasCellPop(renderer.toJSON())).toBe(false);

  // 第一次停在 int up（pop:dp:orange）
  act(() => {
    (window as any).gdbgui_bump_pop_gen("dp", "orange");
  });
  expect(hasCellPop(renderer.toJSON())).toBe(true);

  // 模擬使用者走到下一行（left、write），這兩行不動 orange，cell-pop 應該還在
  // （因為那一格的內容——顏色——沒變，key 沒理由跟著變，這是正常持續高亮的樣子）
  act(() => {
    (window as any).gdbgui_bump_pop_gen("dp", "lime");
  });
  expect(hasCellPop(renderer.toJSON())).toBe(true);

  // 關鍵：迴圈繞回來，第二次停在同一行 int up（pop:dp:orange 再次觸發）。
  // 這是使用者回報「只有第一次亮起有動畫」的情境——第二次也要有 cell-pop。
  act(() => {
    (window as any).gdbgui_bump_pop_gen("dp", "orange");
  });
  expect(hasCellPop(renderer.toJSON())).toBe(true);

  act(() => {
    renderer.unmount();
  });
});
