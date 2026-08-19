import { tableFromContainer } from "../tableFromContainer";

const grid = (values: any[][]) => ({ name: "dp", type: "vector", values, isContainer: true });

test("二維容器轉成表格", () => {
  const result = tableFromContainer(grid([[0, 1], [2, 3]]), 200);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.table.rows).toBe(2);
    expect(result.table.cols).toBe(2);
    expect(result.table.values).toEqual([["0", "1"], ["2", "3"]]);
    expect(result.table.row_labels).toEqual(["0", "1"]);
  }
});

test("一維容器被拒絕", () => {
  const result = tableFromContainer(grid([1, 2, 3] as any), 200);
  expect(result.ok).toBe(false);
});

test("各列長度不一被拒絕，理由要說出實際長度", () => {
  const result = tableFromContainer(grid([[1, 2], [3]]), 200);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("1");
});

test("超過格數上限被拒絕", () => {
  const big = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 0));
  const result = tableFromContainer(grid(big), 200);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("400");
});

test("值一律轉成字串，不做數字正規化", () => {
  const result = tableFromContainer(grid([["0042"]]), 200);
  if (result.ok) expect(result.table.values).toEqual([["0042"]]);
});

test("超過 32 字元的儲存格被拒絕", () => {
  const result = tableFromContainer(grid([["x".repeat(33)]]), 200);
  expect(result.ok).toBe(false);
});
