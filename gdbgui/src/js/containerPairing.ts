// ── 「2~3 個容器並排顯示」的純邏輯 ─────────────────────────────────────────
// @layout 的 `pair:A,B` / `pair:A,B,C` 只是「記下這幾個名字要並排」；真正要不要排、
// 排完剩下哪些容器照原順序疊在下面，由這個純函式決定，方便單元測試。
//
// 設計上最重要的一點：只排「現在確實有資料」的容器。教案還沒執行到會用到 C 的那一步
// （例如 C 是本次停駐才新建立的容器）時，不能因為之前設過 pair 就少畫一個已經有資料的 A。
// 兩個名字時兩個都要有資料才排（跟原本一樣）；三個名字時有資料的只要 2 個以上就排，
// 這樣 `pair:cost,dp,nxt` 從頭寫到尾就好，nxt 出現的那一行自動變成三欄。

export const MAX_PAIR = 3;

export function splitForPairing(
  names: string[],
  pair: string[] | null
): { paired: string[] | null; rest: string[] } {
  if (pair && pair.length >= 2 && pair.length <= MAX_PAIR && new Set(pair).size === pair.length) {
    const present = pair.filter((n) => names.includes(n));
    if (present.length >= 2 && (pair.length === 3 || present.length === pair.length)) {
      return { paired: present, rest: names.filter((n) => !present.includes(n)) };
    }
  }
  return { paired: null, rest: names };
}
