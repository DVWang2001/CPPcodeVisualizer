import { parsePullToken, computePullOffsets, formatPullPreview } from "../pullAnim";

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
      targetKey: "1,1",
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

describe("formatPullPreview", () => {
  test("兩個數字相加", () => {
    expect(formatPullPreview("3", "5")).toBe("8");
  });

  test("負數、小數也算", () => {
    expect(formatPullPreview("-2", "2.5")).toBe("0.5");
  });

  test("任一邊不是數字回 null（例如字串容器的值）", () => {
    expect(formatPullPreview("abc", "5")).toBeNull();
    expect(formatPullPreview("3", "xyz")).toBeNull();
  });

  test("空字串回 null", () => {
    expect(formatPullPreview("", "5")).toBeNull();
  });
});

import { parseCrossPullToken, resolveCrossPull } from "../pullAnim";

describe("parseCrossPullToken", () => {
  test("cost:orange,dp:lime->dp:lightblue", () => {
    expect(parseCrossPullToken("cost:orange,dp:lime->dp:lightblue")).toEqual({
      a: { containerName: "cost", color: "orange" },
      b: { containerName: "dp", color: "lime" },
      target: { containerName: "dp", color: "lightblue" },
    });
  });

  test("空白會 trim", () => {
    expect(parseCrossPullToken(" cost : orange , dp : lime -> dp : lightblue ")?.target).toEqual({
      containerName: "dp",
      color: "lightblue",
    });
  });

  test("同容器舊寫法（目標沒有容器名）不是跨容器：回 null，交給 parsePullToken", () => {
    expect(parseCrossPullToken("dp:orange,lime->lightblue")).toBeNull();
  });

  test("來源不是剛好兩個、缺箭頭、缺顏色：null", () => {
    expect(parseCrossPullToken("cost:orange->dp:lightblue")).toBeNull();
    expect(parseCrossPullToken("a:x,b:y,c:z->dp:lightblue")).toBeNull();
    expect(parseCrossPullToken("cost:orange,dp:lime")).toBeNull();
    expect(parseCrossPullToken("cost:,dp:lime->dp:lightblue")).toBeNull();
  });
});

describe("resolveCrossPull", () => {
  const token = parseCrossPullToken("cost:orange,dp:lime->dp:lightblue")!;
  const tables: Record<string, any> = {
    cost: { highlights: [{ index: 6, color: "orange" }], cols: 4 }, // (1,2)
    dp: {
      highlights: [
        { index: 11, color: "lime" }, // (2,3)
        { index: 6, color: "lightblue" }, // (1,2)
      ],
      cols: 4,
    },
  };

  test("兩個容器各自換算 (列,欄)，同一個容器的兩種顏色不會混", () => {
    expect(resolveCrossPull(token, (n) => tables[n] || null)).toEqual({
      a: { containerName: "cost", row: 1, col: 2 },
      b: { containerName: "dp", row: 2, col: 3 },
      target: { containerName: "dp", row: 1, col: 2 },
    });
  });

  test("任一端沒亮、或容器不存在：null", () => {
    expect(resolveCrossPull(token, (n) => (n === "dp" ? tables.dp : null))).toBeNull();
    const noLime: Record<string, any> = { ...tables, dp: { ...tables.dp, highlights: [{ index: 6, color: "lightblue" }] } };
    expect(resolveCrossPull(token, (n) => noLime[n] || null)).toBeNull();
  });
});

test("parsePullToken 不會把跨容器寫法誤認成同容器（顏色欄位含冒號）", () => {
  expect(parsePullToken("cost:orange,dp:lime->dp:lightblue")).toBeNull();
});
