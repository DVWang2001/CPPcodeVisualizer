// ── 靜默通過的狀態機與臨時斷點生命週期 ────────────────────────────────
// 模組層級只有一份狀態：同一時間最多一個靜默通過。所有結束路徑都必須走
// finishSilentPass()，它回傳要送出的刪除命令，並清空狀態。
// 決策本身在 silentPass.ts；這裡只負責記住「啟動的指令、起點深度、已插入的編號」。

import {
  ResumeKind,
  StopForClassify,
  classifyStop,
  deleteBreakpointCmd,
  insertGuideBreakpointCmds,
  nextResume,
} from "./silentPass";

interface PassState {
  kind: ResumeKind;
  originDepth: number;
  insertedNumbers: string[];
}

let state: PassState | null = null;

/** 最近一次停駐的 bkptno（process_gdb_response 在呼叫 paused 之前寫入）。 */
let lastStopBkptno: string | null = null;
/** 靜默停駐已畫完，等 refresh 帶回堆疊深度再決定續行。 */
let pendingStop: { bkptno: string | null; line: number; userBreakpointNumbers: Set<string> } | null = null;
/** 目前的續行命令是否由靜默通過發出（區分自動播放續行與手動按鈕）。 */
let ownResume = false;

export function noteStopBkptno(bkptno: string | null): void {
  lastStopBkptno = bkptno;
}

export function takeStopBkptno(): string | null {
  return lastStopBkptno;
}

export function setPendingStop(p: { line: number; userBreakpointNumbers: Set<string> } | null): void {
  pendingStop = p ? { bkptno: lastStopBkptno, ...p } : null;
}

export function takePendingStop(): NonNullable<typeof pendingStop> | null {
  const p = pendingStop;
  pendingStop = null;
  return p;
}

/** 在靜默通過自己發出的續行期間執行 fn，讓 Actions.inferior_program_resuming 不把它當成手動操作。 */
export function asOwnResume<T>(fn: () => T): T {
  ownResume = true;
  try {
    return fn();
  } finally {
    ownResume = false;
  }
}

export function isOwnResume(): boolean {
  return ownResume;
}

/**
 * 啟動靜默通過，回傳要送出的 `-break-insert` 命令。
 * 呼叫端必須把每條命令的回應編號交給 recordInsertedNumber。
 */
export function startSilentPass(
  kind: ResumeKind,
  originDepth: number,
  fullname: string,
  guideLines: number[],
  userLines: Set<number>,
): string[] {
  state = { kind, originDepth, insertedNumbers: [] };
  return insertGuideBreakpointCmds(fullname, guideLines, userLines);
}

export function recordInsertedNumber(n: string): void {
  if (state) state.insertedNumbers.push(n);
}

export function isSilentPassActive(): boolean {
  return state !== null;
}

/** 結束靜默通過：回傳刪除臨時斷點的命令（沒有則空字串），並清空狀態。未啟用時安全地回傳空字串。 */
export function finishSilentPass(): string {
  if (!state) return "";
  const cmd = deleteBreakpointCmd(state.insertedNumbers);
  state = null;
  return cmd;
}

export type SilentStopDecision =
  | { action: "normal" }
  | { action: "silent"; resume: string };

/**
 * 靜默通過中的一次停駐要怎麼處理。
 * normal：照常流程（含 TTS）；呼叫端須負責 finishSilentPass()。
 * silent：只做畫面更新，然後送出 resume 對應的 GDB 命令（-exec-continue / -exec-next / -exec-finish）。
 */
export function onSilentStop(stopDepth: number, s: StopForClassify): SilentStopDecision {
  if (!state) return { action: "normal" };
  if (classifyStop(s) === "normal") return { action: "normal" };
  const decision = nextResume(state.kind, state.originDepth, stopDepth);
  if (decision === "done") return { action: "normal" };
  return { action: "silent", resume: `-exec-${decision}` };
}
