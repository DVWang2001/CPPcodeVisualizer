import { collapseSizes, isCollapsed } from "../tutorialPane";

test("收合：左欄寬度併進中間，右欄不變，總和不變", () => {
  expect(collapseSizes([34, 36, 29])).toEqual([0, 70, 29]);
});

test("isCollapsed 只看左欄是否接近 0", () => {
  expect(isCollapsed([0, 70, 29])).toBe(true);
  expect(isCollapsed([34, 36, 29])).toBe(false);
});
