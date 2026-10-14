// 程式追蹤表（Visualizer）要顯示的原始碼。
//
// 回報：用 ?lesson=N 從教案庫載入教案後，右側「程式追蹤表」一直顯示
// 「尚未載入源碼」，要在編輯器裡打字、或改用 Import JSON 才會出現。
//
// 根因：追蹤表只讀 global_variable.__source_text，而它只在 Monaco 掛載與內容
// 變動事件裡同步；從伺服器載入的那條路徑上，編輯器已經有內容了，卻沒有任何
// 一次同步發生。編輯器本身才是原始碼的唯一真相，所以讀不到快取時就直接問它，
// 並把結果寫回快取，之後的 render 不必再問。
export function resolveSourceText(
  globalVar: { __source_text?: string },
  getEditorValue?: () => string | undefined | null
): string {
  const cached = globalVar.__source_text;
  if (cached) return cached;
  let live = "";
  try {
    live = (getEditorValue && getEditorValue()) || "";
  } catch (_) {
    live = "";
  }
  if (live) globalVar.__source_text = live;
  return live;
}
