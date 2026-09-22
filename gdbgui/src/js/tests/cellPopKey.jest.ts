import { popCellKey } from "../cellPopKey";

describe("popCellKey", () => {
  test("no generation (0/undefined) — never pops, no matter the highlight", () => {
    expect(popCellKey("2,3", 0, { bg: "lightblue" })).toEqual({ key: "2,3", className: undefined });
    expect(popCellKey("2,3", undefined, { bg: "lightblue" })).toEqual({ key: "2,3", className: undefined });
  });

  test("generation set but cell not highlighted this render: no pop", () => {
    expect(popCellKey("2,3", 1, null)).toEqual({ key: "2,3", className: undefined });
    expect(popCellKey("2,3", 1, undefined)).toEqual({ key: "2,3", className: undefined });
  });

  test("generation set and cell highlighted: keyed by generation, cell-pop class applied", () => {
    expect(popCellKey("2,3", 1, { bg: "lightblue" })).toEqual({
      key: "2,3-pop-1",
      className: "cell-pop",
    });
  });

  test("same generation across renders (same stop, unrelated re-render): identical key — no repeated pop", () => {
    const a = popCellKey("2,3", 3, { bg: "orange" });
    const b = popCellKey("2,3", 3, { bg: "orange" });
    expect(a.key).toBe(b.key);
  });

  // 這是這個檔案存在的真正原因：grid_paths.cpp 的 dp[i][j]:lightblue 連續三行
  // 顏色完全沒變（同一格從「先讀上面那格」一路亮到「寫進這一格」都是 lightblue），
  // 只有 pop:dp 出現的那一行的「顏色」跟前一行相比沒有任何差異。舊版
  // popCellKey 是拿高亮顏色字串比對，比出「沒變」就不重播動畫——這正是
  // 使用者回報「沒看到動畫」的根因。新版改成拿 applyLayout 每次真的停在
  // 一個新行、且該行 @layout 出現 pop: 時遞增的世代號，不管顏色有沒有變，
  // 世代號變了就重播。
  test("regression: same color across consecutive stops still pops when the generation advances", () => {
    const stop1 = popCellKey("dp:2,3", 1, { bg: "lightblue" }); // int up = ...
    const stop2 = popCellKey("dp:2,3", 1, { bg: "lightblue" }); // int left = ...（沒有 pop: token，世代號沒變）
    const stop3 = popCellKey("dp:2,3", 2, { bg: "lightblue" }); // dp[i][j] = ...（這一行有 pop:dp，世代號 +1）

    expect(stop1.key).toBe(stop2.key); // 中間這一行沒有 pop:，不該多跳一次
    expect(stop3.key).not.toBe(stop2.key); // 這一行有 pop:，即使顏色沒變也要重播
    expect(stop3.className).toBe("cell-pop");
  });

  test("cell becomes unhighlighted: reverts to the bare key, no className, even if generation is set", () => {
    expect(popCellKey("2,3", 5, undefined)).toEqual({ key: "2,3", className: undefined });
  });
});
