import { resolve2DHighlightIndex } from "../gridHighlightIndex";

describe("resolve2DHighlightIndex", () => {
  test("容器資料已備妥：用真正的欄數換算", () => {
    // 5 欄的容器，row=1,col=1 → index = 1*5+1 = 6
    const data = { values: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
    expect(resolve2DHighlightIndex(1, 1, data)).toEqual({ ready: true, index: 6 });
  });

  test("row=0 時任何欄數換算結果都一樣——這是舊 bug 沒被發現的原因", () => {
    const data5cols = { values: [[0, 0, 0, 0, 0]] };
    const data1col = { values: [[0]] };
    expect(resolve2DHighlightIndex(0, 2, data5cols)).toEqual({ ready: true, index: 2 });
    // 用錯的欄數（1）算 row=0 一樣是對的，只有 row>0 才會露餡
    expect(resolve2DHighlightIndex(0, 2, data1col)).toEqual({ ready: true, index: 2 });
  });

  test("容器資料還沒備妥（undefined）：回 not ready，不能假設欄數", () => {
    expect(resolve2DHighlightIndex(1, 1, undefined)).toEqual({ ready: false });
  });

  test("容器資料還沒備妥（null）：回 not ready", () => {
    expect(resolve2DHighlightIndex(1, 1, null)).toEqual({ ready: false });
  });

  test("values 是空陣列（容器目前是空的）：回 not ready", () => {
    expect(resolve2DHighlightIndex(1, 1, { values: [] })).toEqual({ ready: false });
  });

  test("values[0] 不是陣列（容器還沒真的是 2D，例如剛建立、還沒展開子節點）：回 not ready", () => {
    expect(resolve2DHighlightIndex(1, 1, { values: [0, 0] as any })).toEqual({ ready: false });
  });

  test("回歸測試：使用者實測回報的走方格_DP推導案例——dp 是 5 欄，(row=1,col=1) 曾經被錯算成 index=2（欄數當成 1）", () => {
    const dp = { values: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] };
    const result = resolve2DHighlightIndex(1, 1, dp);
    expect(result).toEqual({ ready: true, index: 6 });
    // 明確排除舊 bug 的錯誤答案
    expect(result).not.toEqual({ ready: true, index: 2 });
  });
});
