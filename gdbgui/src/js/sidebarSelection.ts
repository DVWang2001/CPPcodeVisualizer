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

/**
 * 教案的 //@ @layout open:xxx 點名過的面板，在這次執行期間強制視為勾選（只影響執行模式，
 * 不寫進 sidebar_selection，所以不會改到老師存的勾選，也不會被存進教案）。每次重新執行清空。
 */
export function forcePanelChecked(key: string) {
  const forced = store.get("sidebar_forced") || {};
  if (!forced[key]) store.set("sidebar_forced", { ...forced, [key]: true });
}

export function clearForcedPanels() {
  if (store.get("sidebar_forced")) store.set("sidebar_forced", undefined);
}
