import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { store } from "statorgfc";

jest.mock("../../../static/css/reserch.css", () => ({}));

// 子面板很重（各自連 store、畫布、DOM 查詢）。這裡只測側欄自己的勾選、隱藏與佈局邏輯，所以全部換成空殼。
jest.mock("../Visualizer", () => ({ __esModule: true, default: () => null }));
jest.mock("../ContainerVisualizer", () => ({ __esModule: true, default: () => null }));
jest.mock("../UMLVisualizer", () => ({ __esModule: true, default: () => null }));
jest.mock("../CallGraph", () => ({ __esModule: true, default: () => null }));
jest.mock("../WatchTable", () => ({ __esModule: true, default: () => null }));
jest.mock("../MemoryWatch", () => ({ __esModule: true, default: () => null }));
jest.mock("../CompileErrors", () => ({ __esModule: true, default: () => null }));
jest.mock("../Locals", () => ({ __esModule: true, default: () => null }));
jest.mock("../Breakpoints", () => ({ __esModule: true, default: () => null }));
jest.mock("../GdbMiOutput", () => ({ __esModule: true, default: () => null }));
jest.mock("../Memory", () => ({ __esModule: true, default: () => null }));
jest.mock("../Registers", () => ({ __esModule: true, default: () => null }));
jest.mock("../Expressions", () => ({ __esModule: true, default: () => null }));
jest.mock("../InferiorProgramInfo", () => ({ __esModule: true, default: () => null }));

import RightSidebar from "../RightSidebar";
import initialStoreData from "../InitialStoreData";
import { normalizeBundle } from "../bundleAdapter";

const KEYS = ["compile_errors", "memory_watch", "callgraph", "visualizer", "container", "uml_visualizer", "locals", "watch_table", "breakpoints"];

function mount(edit_mode: boolean) {
  store.set("edit_mode", edit_mode);
  const root = document.createElement("div");
  document.body.appendChild(root);
  act(() => {
    ReactDOM.render(React.createElement(RightSidebar, { debug: false }), root);
  });
  return root;
}

const panel = (root: HTMLElement, key: string) => root.querySelector(`[data-panel-key="${key}"]`) as HTMLElement;
const isVisible = (root: HTMLElement, key: string) => panel(root, key).style.display !== "none";

beforeAll(() => {
  (store as any).initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

beforeEach(() => {
  document.body.innerHTML = "";
  store.set("sidebar_selection", undefined);
  delete (window as any).initial_data;
});

describe("RightSidebar：勾選設定", () => {
  test("沒有勾選設定（舊教案）：編輯模式全部面板都勾著，執行模式收合的隱藏", () => {
    const edit = mount(true);
    KEYS.forEach(k => {
      const box = panel(edit, k).querySelector("input[type=checkbox]") as HTMLInputElement;
      expect(box.checked).toBe(true);
    });
  });

  test("執行模式下：未勾選的面板隱藏，勾選的面板即使收合也保留標題列", () => {
    store.set("sidebar_selection", { visualizer: true, container: false });
    const play = mount(false);
    expect(isVisible(play, "visualizer")).toBe(true);
    expect(isVisible(play, "container")).toBe(false);
    // 勾選了、但沒展開的面板仍顯示標題列（可開關）
    expect(isVisible(play, "compile_errors")).toBe(false); // 未列入勾選 → 隱藏
  });

  test("編輯模式下：未勾選的面板仍顯示（變暗），方便勾選", () => {
    store.set("sidebar_selection", { visualizer: true });
    const edit = mount(true);
    expect(isVisible(edit, "container")).toBe(true);
    const box = panel(edit, "container").querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  test("勾選 checkbox 會寫進 store 的 sidebar_selection", () => {
    store.set("sidebar_selection", { visualizer: true });
    const edit = mount(true);
    const box = panel(edit, "container").querySelector("input[type=checkbox]") as HTMLInputElement;
    act(() => {
      box.click();
    });
    const selection = store.get("sidebar_selection");
    expect(selection.container).toBe(true);
    expect(selection.visualizer).toBe(true);
  });

  test("教學頁收合的面板一律隱藏，即使勾選了", () => {
    (window as any).initial_data = { tutorial: true };
    store.set("sidebar_selection", { uml_visualizer: true });
    const play = mount(false);
    expect(isVisible(play, "uml_visualizer")).toBe(false);
  });
});

test("自動存檔還原會保留右側欄勾選（normalizeBundle 不能丟掉 sidebar_panels）", () => {
  const v2 = normalizeBundle({ version: "2.0", source_code: "int main(){}", sidebar_panels: { visualizer: true } });
  expect(v2.sidebar_panels).toEqual({ visualizer: true });
  expect(normalizeBundle({ version: "2.0", source_code: "" }).sidebar_panels).toBeUndefined();
});
