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

const PANEL_ALIASES: Record<string, string> = { memory: "memory_watch", pointer: "memory_watch" };

/** 教案的 //@ @layout 裡所有 open: 點名過的面板 key（依出現順序、去重；別名換成真正的 key）。 */
export function layoutOpenedPanels(layoutMap: Record<string, string> | undefined): string[] {
  const found: string[] = [];
  Object.keys(layoutMap || {})
    .sort((a, b) => Number(a) - Number(b))
    .forEach(line => {
      (layoutMap![line] || "").trim().split(/\s+/).forEach(token => {
        if (!token.startsWith("open:")) return;
        token.slice(5).split(",").forEach(raw => {
          const id = PANEL_ALIASES[raw.trim()] || raw.trim();
          if (id && !found.includes(id)) found.push(id);
        });
      });
    });
  return found;
}
