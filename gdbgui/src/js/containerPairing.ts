// ── 「兩個容器並排顯示」的純邏輯 ─────────────────────────────────────────
// @layout 的 `pair:A,B` 只是「記下這兩個名字要並排」；真正要不要排、
// 排完剩下哪些容器照原順序疊在下面，由這個純函式決定，方便單元測試。
//
// 設計上最重要的一點：pair 只在「A、B 現在都確實有資料」時才生效。
// 教案還沒執行到會用到 B 的那一步（例如 B 是本次停駐才新建立的容器）時，
// 不能因為之前設過 pair 就少畫一個已經有資料的 A。

export function splitForPairing(
  names: string[],
  pair: [string, string] | null
): { paired: [string, string] | null; rest: string[] } {
  if (pair && pair[0] !== pair[1] && names.includes(pair[0]) && names.includes(pair[1])) {
    return { paired: pair, rest: names.filter((n) => n !== pair[0] && n !== pair[1]) };
  }
  return { paired: null, rest: names };
}
