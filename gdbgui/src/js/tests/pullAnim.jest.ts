import { parsePullToken, computePullOffsets } from "../pullAnim";

describe("parsePullToken", () => {
  test("解析 dp:orange,lime->lightblue", () => {
    expect(parsePullToken("dp:orange,lime->lightblue")).toEqual({
      containerName: "dp",
      colorA: "orange",
      colorB: "lime",
      targetColor: "lightblue",
    });
  });

  test("容器名跟顏色都會 trim 空白", () => {
    expect(parsePullToken(" dp : orange , lime -> lightblue ")).toEqual({
      containerName: "dp",
      colorA: "orange",
      colorB: "lime",
      targetColor: "lightblue",
    });
  });

  test("沒有 -> 回 null", () => {
    expect(parsePullToken("dp:orange,lime")).toBeNull();
  });

  test("沒有容器名冒號回 null", () => {
    expect(parsePullToken("orange,lime->lightblue")).toBeNull();
  });

  test("顏色不是剛好兩個回 null", () => {
    expect(parsePullToken("dp:orange->lightblue")).toBeNull();
    expect(parsePullToken("dp:orange,lime,cyan->lightblue")).toBeNull();
  });

  test("空字串回 null", () => {
    expect(parsePullToken("")).toBeNull();
  });
});

describe("computePullOffsets", () => {
  // 3x3 網格，攤平 index = row*3 + col
  const cols = 3;

  test("上方格 + 左方格飛向當前格（典型 DP 走格子）", () => {
    const highlights = [
      { index: 1, color: "orange" }, // (0,1) = 上面
      { index: 3, color: "lime" },   // (1,0) = 左邊
      { index: 4, color: "lightblue" }, // (1,1) = 目標
    ];
    const result = computePullOffsets(highlights, cols, "orange", "lime", "lightblue");
    expect(result).toEqual({
      aKey: "0,1",
      bKey: "1,0",
      deltaA: { dRow: 1, dCol: 0 },
      deltaB: { dRow: 0, dCol: 1 },
    });
  });

  test("任一顏色沒亮著就回 null", () => {
    const highlights = [
      { index: 1, color: "orange" },
      { index: 4, color: "lightblue" },
    ];
    expect(computePullOffsets(highlights, cols, "orange", "lime", "lightblue")).toBeNull();
  });

  test("highlights 是 undefined 回 null", () => {
    expect(computePullOffsets(undefined, cols, "orange", "lime", "lightblue")).toBeNull();
  });

  test("cols <= 0 回 null", () => {
    const highlights = [
      { index: 1, color: "orange" },
      { index: 3, color: "lime" },
      { index: 4, color: "lightblue" },
    ];
    expect(computePullOffsets(highlights, 0, "orange", "lime", "lightblue")).toBeNull();
  });

  test("來源格剛好同一格也算得出來（雖然實務上不會這樣用）", () => {
    const highlights = [
      { index: 0, color: "orange" },
      { index: 0, color: "lime" },
      { index: 4, color: "lightblue" },
    ];
    const result = computePullOffsets(highlights, cols, "orange", "lime", "lightblue");
    expect(result!.deltaA).toEqual({ dRow: 1, dCol: 1 });
    expect(result!.deltaB).toEqual({ dRow: 1, dCol: 1 });
  });
});
