import { store } from "statorgfc";

/**
 * 右側欄面板的勾選（教案 bundle 的 sidebar_panels 存這個 store 值）。
 * 沒有存過勾選（store 的 sidebar_selection 是 undefined）時維持舊行為：全部面板都在，
 * 收合的面板在執行模式隱藏——既有教案不會因為這次改版少面板。
 */
export function ensurePanelChecked(key: string) {
  const selection = store.get("sidebar_selection");
  if (!selection) return; // 舊行為：本來就全部可見
  if (!selection[key]) store.set("sidebar_selection", { ...selection, [key]: true });
}
