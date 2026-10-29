// ── 靜默通過的前端接線 ────────────────────────────────────────────────
// 狀態與決策在 silentPassRunner.ts / silentPass.ts；這裡負責把它接到 GDB 命令與 UI：
//   runAutoplayWithSilentPass  自動播放要續行時，先插入指導行的臨時斷點，再續行
//   silentPassOnStack          refresh 帶回堆疊深度後，決定靜默續行、或結束並照常播放
//   endSilentPassAndCleanup    任何結束路徑（手動操作、使用者斷點、暫停）都要清臨時斷點

import { store } from "statorgfc";
import GdbApi from "./GdbApi";
import Actions from "./Actions";
import VisualizerHelper from "./VisualizerHelper";
import { global_variable } from "./global_variable";
import constants from "./constants";
import { guideLineNumbers } from "./silentPass";
import {
  startSilentPass,
  finishSilentPass,
  onSilentStop,
  isSilentPassActive,
  setPendingStop,
  takePendingStop,
  asOwnResume,
  isOwnResume,
} from "./silentPassRunner";

const TOKEN = constants.SILENT_PASS_TOKEN_STR;

const AUTOPLAY_TO_KIND: Record<string, "continue" | "next" | "finish"> = {
  continue: "continue",
  next: "next",
  "step-out": "finish",
};

function sourcePathForGdb(fullname: string): string {
  const real =
    (window as any).gdbgui_real_source_path || localStorage.getItem("gdbgui_gdb_source_path") || fullname;
  return String(real).replace(/\\/g, "/");
}

/**
 * 自動播放要續行（next / continue / step-out）時呼叫。
 * 能靜默通過就先插入臨時斷點；不能（手動、無指導行、虛步）就原樣續行。
 * resume 必須是會實際送出續行命令的函式。
 */
export function runAutoplayWithSilentPass(command: string, resume: () => void): void {
  const kind = AUTOPLAY_TO_KIND[command];
  const sub = store.get("for_sub_step");
  const inVirtualForStep = kind === "next" && sub && (sub.seg === "A" || sub.seg === "C");
  if (!kind || !store.get("autoplay_enabled") || isSilentPassActive() || !GdbApi.inferior_is_paused() || inVirtualForStep) {
    return asOwnResume(resume);
  }
  const paused: any = store.get("paused_on_frame") || {};
  const lines = guideLineNumbers({
    line: (global_variable as any).__line,
    tts: (global_variable as any).__tts,
    layout: (global_variable as any).__layout,
  });
  if (!paused.fullname || lines.length === 0) return asOwnResume(resume);

  const userLines = new Set<number>(
    (store.get("breakpoints") as any[])
      .filter((b: any) => b.fullname === paused.fullname && b.line !== undefined)
      .map((b: any) => Number(b.line))
  );
  const depth = (store.get("stack") as any[] | undefined || []).length;
  const cmds = startSilentPass(kind, depth, sourcePathForGdb(paused.fullname), lines, userLines).map(
    (c) => TOKEN + c
  );
  asOwnResume(() => {
    if (cmds.length) GdbApi.run_gdb_command(cmds);
    resume();
  });
}

/** 靜默停駐（或任何會結束靜默通過的停駐）時，記下這次停駐的資訊，等堆疊深度回來再決定。 */
export function recordSilentStop(line: number): void {
  const userNums = new Set<string>(
    (store.get("breakpoints") as any[]).map((b: any) => String(b.number))
  );
  setPendingStop({ line, userBreakpointNumbers: userNums });
}

/** 停駐被判定為正常（使用者斷點、出題、或靜默通過已結束）時呼叫：清臨時斷點。 */
export function endSilentPassAndCleanup(): void {
  const del = finishSilentPass();
  if (del) GdbApi.run_gdb_command(del);
}

/** 停駐在靜默判定之外的任何手動續行：清臨時斷點。自動播放自己發出的續行不清。 */
export function endSilentPassOnManualResume(): void {
  if (isSilentPassActive() && !isOwnResume()) endSilentPassAndCleanup();
}

/** Threads.update_stack 在 refresh 帶回堆疊後呼叫：決定靜默續行或結束。 */
export function silentPassOnStack(depth: number): void {
  const p = takePendingStop();
  if (!p) return;
  const decision = onSilentStop(depth, {
    bkptno: p.bkptno,
    line: p.line,
    userBreakpointNumbers: p.userBreakpointNumbers,
    guideBreakpointNumbers: new Set(),
    quizMatched: false,
  });
  const autoplayOn = !!store.get("autoplay_enabled") && !store.get("autoplay_paused");
  if (decision.action === "normal" || !autoplayOn) {
    endSilentPassAndCleanup();
    // 到達目標（且仍在自動播放）：照常播這一行的 TTS；使用者介入則停在這裡不出聲
    if (decision.action === "normal" && autoplayOn) {
      const f: any = store.get("paused_on_frame") || {};
      VisualizerHelper.play_tts(f.line, f.func);
    }
    return;
  }
  asOwnResume(() => {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(decision.resume);
  });
}
