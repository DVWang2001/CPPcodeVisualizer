// ── 2D 容器高亮的「列/欄 → 攤平 index」換算 ──────────────────────────────
//
// {dp[i][j]:color} 這類 2D 索引高亮，最後要換算成一個攤平的 index（供
// __latest_highlights 用，跟渲染那邊的 hlPosMap2D 用同一套 row*cols+col）。
// 換算需要知道容器「一列有幾欄」，這個欄數只能從容器自己的資料
// （__latest_containers 裡的 values[0].length）讀，而容器資料是另一個
// 獨立的非同步 token（例如同一行 @guide 裡的 {dp}）才抓得到的。
//
// 舊版在容器資料還沒抓回來時直接假設欄數＝1，導致算出來的格子在非第 0 列
// 全部偏移（第 0 列因為 row*cols=0，不管 cols 多少結果都一樣，剛好躲過，
// 這也是為什麼「上面」那個 highlight 常常剛好對、只有「這一格」「左邊」對
// 不上——它們剛好落在 row>0）。這個函式改成回報「還沒準備好」，呼叫端要
// 等容器資料備妥才能真的換算，不能悄悄假設一個欄數。

export interface Container2DData {
  values: unknown[][];
}

export type HighlightIndexResult =
  | { ready: true; index: number }
  | { ready: false };

export function resolve2DHighlightIndex(
  rowVal: number,
  colVal: number,
  containerData: Container2DData | null | undefined
): HighlightIndexResult {
  const cols =
    containerData &&
    Array.isArray(containerData.values) &&
    containerData.values.length > 0 &&
    Array.isArray(containerData.values[0])
      ? containerData.values[0].length
      : undefined;
  if (cols === undefined) return { ready: false };
  return { ready: true, index: rowVal * cols + colVal };
}
