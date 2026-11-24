// 程式追蹤表每走一步就多一欄，欄一多就超出面板寬度；使用者要的是「永遠看到最新
// 那一欄」，所以步數增加時自動捲到最右邊（行號與程式碼兩欄是 sticky，不會被捲走）。
//
// 只在步數「增加」時捲動，不是每次重繪都捲——追蹤表每秒 forceUpdate 一次，
// 若每次都捲，使用者往左翻回去看前面的欄位會被立刻拉回來，根本無法回頭看。
// 重新執行（步數變少）只是重設記錄，不捲動：新的一輪從最左邊開始。
export function nextScrollLeft(
  prevSteps: number,
  steps: number,
  scrollWidth: number,
  clientWidth: number
): number | null {
  if (steps <= prevSteps) return null;
  return Math.max(0, scrollWidth - clientWidth);
}

// 步驟欄的寬度跟著該欄最長的數值走以後，同一輪後面的行填進較長的數值會讓最新一欄
// 變寬、右半邊被面板切掉（步數沒變，nextScrollLeft 不會捲）。原本停在最右邊、正在
// 看最新一欄的話，表格變寬時跟著貼齊新的右邊；使用者往左翻回去看舊欄位時不動。
// 容許 1px 的誤差：縮放（例如 125%）下 scrollLeft 會是小數。
export function keepRightEdge(
  prevScrollWidth: number,
  prevClientWidth: number,
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number
): number | null {
  if (scrollWidth <= prevScrollWidth) return null;
  if (scrollLeft < prevScrollWidth - prevClientWidth - 1) return null;
  return Math.max(0, scrollWidth - clientWidth);
}
