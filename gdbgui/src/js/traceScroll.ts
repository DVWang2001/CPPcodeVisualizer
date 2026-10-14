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
