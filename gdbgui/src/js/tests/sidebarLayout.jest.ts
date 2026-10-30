import { layoutSidebar, dragDivider } from "../sidebarLayout";
import type { SidebarPanel, SidebarSizing } from "../sidebarLayout";

const sizing: SidebarSizing = { total_px: 600, header_px: 32, min_open_px: 80 };
const panel = (id: string, open: boolean, weight = 0): SidebarPanel => ({ id, open, weight });
const sum = (heights: Record<string, number>) => Object.values(heights).reduce((s, h) => s + h, 0);

describe("layoutSidebar：高度分配", () => {
  test("全部收合：每個面板只剩標題列", () => {
    const r = layoutSidebar([panel("a", false), panel("b", false)], sizing);
    expect(r.heights).toEqual({ a: 32, b: 32 });
    expect(r.dropped).toEqual([]);
  });

  test("單一展開：吃掉收合面板以外的全部空間，總和等於欄位高度", () => {
    const r = layoutSidebar([panel("a", true), panel("b", false)], sizing);
    expect(r.heights.b).toBe(32);
    expect(r.heights.a).toBe(600 - 32);
    expect(sum(r.heights)).toBe(600);
  });

  test("多個展開依權重分配，權重 0 平分", () => {
    const r = layoutSidebar([panel("a", true, 100), panel("b", true, 300)], sizing);
    // 剩餘空間 600 - 80 - 80 = 440，依 1:3 分給超出部分
    expect(r.heights).toEqual({ a: 80 + 110, b: 80 + 330 });
    expect(sum(r.heights)).toBe(600);

    const even = layoutSidebar([panel("a", true), panel("b", true)], sizing);
    expect(even.heights.a).toBe(even.heights.b);
    expect(sum(even.heights)).toBe(600);
  });

  test("捨入誤差由最後一個展開面板吃掉，總和仍精確", () => {
    const r = layoutSidebar([panel("a", true, 1), panel("b", true, 1), panel("c", true, 1)], { ...sizing, total_px: 601 });
    expect(sum(r.heights)).toBe(601);
  });

  test("空間不足時從最後一個展開面板開始收合，並回報 dropped", () => {
    // 3 個展開各需 80 = 240，但欄位只有 200
    const r = layoutSidebar(
      [panel("a", true), panel("b", true), panel("c", true)],
      { total_px: 200, header_px: 32, min_open_px: 80 }
    );
    expect(r.dropped).toEqual(["c"]);
    expect(r.heights.c).toBe(32);
    expect(r.heights.a + r.heights.b).toBe(200 - 32);
  });

  test("沒有展開面板時不分配剩餘空間（回傳標題列高度）", () => {
    const r = layoutSidebar([panel("a", false)], sizing);
    expect(r.heights.a).toBe(32);
  });
});

describe("dragDivider：拖曳分隔條", () => {
  test("向下拖：上方變高、下方變矮，總和不變，權重依新高度寫回", () => {
    const panels = [panel("a", true, 0), panel("b", true, 0)];
    const next = dragDivider(panels, sizing, 0, 40);
    const h = layoutSidebar(next, sizing).heights;
    expect(h.a).toBe(300 + 40);
    expect(h.b).toBe(300 - 40);
    expect(sum(h)).toBe(600);
  });

  test("拖到底會夾在最小高度，不會把面板壓到 0", () => {
    const panels = [panel("a", true, 0), panel("b", true, 0)];
    const h = layoutSidebar(dragDivider(panels, sizing, 0, 9999), sizing).heights;
    expect(h.b).toBe(80);
    expect(h.a).toBe(520);
  });

  test("分隔條一側是收合面板時不動作", () => {
    const panels = [panel("a", true, 0), panel("b", false, 0)];
    expect(dragDivider(panels, sizing, 0, 50)).toBe(panels);
  });

  test("中間夾著收合面板時，跨過去拖下一個展開的面板", () => {
    const panels = [panel("a", true, 0), panel("b", false, 0), panel("c", true, 0)];
    const h = layoutSidebar(dragDivider(panels, sizing, 0, 40), sizing).heights;
    // 600 - 32（收合的 b）= 568，兩個展開各 80 最小 + 204 → 各 284，拖 40 → 324 / 244
    expect(h.a).toBe(324);
    expect(h.c).toBe(244);
    expect(h.b).toBe(32);
  });

  test("被自動收合的面板不能拖", () => {
    const tight = { total_px: 200, header_px: 32, min_open_px: 80 };
    const panels = [panel("a", true, 0), panel("b", true, 0), panel("c", true, 0)];
    expect(dragDivider(panels, tight, 1, 20)).toBe(panels);
  });
});
