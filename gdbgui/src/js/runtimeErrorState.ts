// 執行錯誤圖解（P2）的接線：每個停點都經過 noteRuntimeStop（process_gdb_response，在 UI 暫停之前）。
// 停點帶著錯誤（LocalGdb 的 payload["runtime-error"]，或堆疊用完的訊號停點）：算出圖解存進 store 的 runtime_error，
// 右側欄「執行錯誤」面板勾選並展開，開著自動播放時暫停（規劃文件 §4.3，決定 3）。
// 之後的停點沒有錯誤：面板留著（here = false），編輯器與「執行這行的結果」的錯誤標記拿掉。重新執行時 resetRuntimeErrors 清空。
// 程式跑完（exited 停點）時記下 ended：回到編輯模式面板仍在（RightSidebar 不鎖這個面板），陣列越界畫出寫出去之後的圖。
import { store } from "statorgfc";
import { diagnose, RtDiag, RtWhich } from "./runtimeDiag";
import { runtimeErrorRun, currentStepIndex } from "./localEngine";
import { ensurePanelChecked } from "./sidebarSelection";

export interface RuntimeErrorState {
  which: RtWhich;
  diag: RtDiag;
  /** 播放器現在是不是停在出錯的那一步 */
  here: boolean;
  /** 播放器現在停在第幾步 */
  stepNow: number | null;
  /** 錯誤之後程式跑到結束了（停點 reason 是 exited…）：那一行已經執行過，回到編輯模式也照樣顯示 */
  ended?: boolean;
}

/** 同一次執行、同一個錯誤只算一次圖解（往回追值要走軌跡）。 */
let cache: { run: any; which: RtWhich; diag: RtDiag } | null = null;

function registry(): any {
  return (window as any).gdbgui_collapser_registry || {};
}

/** 這個停點是哪一個錯誤；不是錯誤的停點回傳 null。 */
function whichAt(payload: any): RtWhich | null {
  const rt = payload && payload["runtime-error"];
  if (rt && rt.index !== undefined && rt.index !== null && rt.index !== "" && !isNaN(Number(rt.index))) return Number(rt.index);
  if (payload && payload.reason === "signal-received") {
    const run = runtimeErrorRun();
    if (run && run.exit && run.exit.reason === "stack-overflow") return "stack-overflow";
  }
  return null;
}

export function noteRuntimeStop(payload: any): void {
  const which = whichAt(payload);
  const stepNow = currentStepIndex();
  const prev: RuntimeErrorState | null = store.get("runtime_error");
  if (which === null) {
    // 程式跑完（exited-normally、exited、exited-signalled）：圖解留著，記下錯誤那一行已經執行過了
    const ended = !!payload && typeof payload.reason === "string" && payload.reason.indexOf("exited") >= 0;
    if (prev && (prev.here || prev.stepNow !== stepNow || !!prev.ended !== ended)) store.set("runtime_error", { ...prev, here: false, stepNow, ended });
    return;
  }
  const run = runtimeErrorRun();
  if (!run) return;
  let diag: RtDiag;
  if (cache && cache.run === run && cache.which === which) diag = cache.diag;
  else {
    try {
      diag = diagnose(run, which);
    } catch (e) {
      console.warn("[runtime-error] 圖解失敗：", e);
      return;
    }
    cache = { run, which, diag };
  }
  store.set("runtime_error", { which, diag, here: true, stepNow });
  ensurePanelChecked("runtime_errors"); // 沒勾選時先勾上，否則開了也看不到
  const r = registry();
  if (r.runtime_errors && r.runtime_errors.open) r.runtime_errors.open();
  if (store.get("autoplay_enabled")) store.set("autoplay_paused", true);
}

/** 重新執行（或重新編譯）時清掉上一次執行的錯誤，收起面板。 */
export function resetRuntimeErrors(): void {
  cache = null;
  if (store.get("runtime_error") !== null) store.set("runtime_error", null);
  const r = registry();
  if (r.runtime_errors && r.runtime_errors.close) r.runtime_errors.close();
}
