// ── 靜默通過：自動播放續行時，途中經過的指導行也要畫出來（不播 TTS）──────
// 純函式，不碰 store 與 socket。執行端（silentPassRunner / Actions）依這裡的
// 決策與命令字串行事。深度規則依 localgdb/exec.js 的 forward()：
//   next  在第一個深度 ≤ 起點的步驟停下 → 那一停就是目標，不可靜默續行。
//   finish 落在呼叫者（深度 < 起點）即為目標。

export interface GuideLineMaps {
  line?: Record<string | number, string>;
  tts?: Record<string | number, string>;
  layout?: Record<string | number, string>;
}

export interface StopForClassify {
  bkptno: string | null;
  line: number;
  userBreakpointNumbers: Set<string>;
  guideBreakpointNumbers: Set<string>;
  quizMatched: boolean;
}

export type ResumeKind = "continue" | "next" | "finish";
export type ResumeDecision = "continue" | "next" | "finish" | "done";

/** 任一欄（guide/tts/layout）有內容的行號，升冪。 */
export function guideLineNumbers(maps: GuideLineMaps): number[] {
  const lines = new Set<number>();
  for (const map of [maps.line, maps.tts, maps.layout]) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (map[key]) lines.add(Number(key));
    }
  }
  return [...lines].filter((n) => !isNaN(n)).sort((a, b) => a - b);
}

/** 對不是使用者斷點的指導行插入臨時斷點。使用者斷點所在行不插，避免同行命中混淆。 */
export function insertGuideBreakpointCmds(
  fullname: string,
  lines: number[],
  userLines: Set<number>,
): string[] {
  return lines
    .filter((n) => !userLines.has(n))
    .map((n) => `-break-insert -f "${fullname}:${n}"`);
}

/** 刪除臨時斷點。沒有編號時回傳空字串（呼叫端據此略過送出）。 */
export function deleteBreakpointCmd(numbers: string[]): string {
  return numbers.length ? `-break-delete ${numbers.join(" ")}` : "";
}

/**
 * 這一次停駐是「正常」（照常播 TTS）還是「靜默」（只畫面更新）。
 * 使用者斷點命中或出題閘門命中一律正常。
 */
export function classifyStop(s: StopForClassify): "normal" | "silent" {
  if (s.quizMatched) return "normal";
  if (s.bkptno !== null && s.userBreakpointNumbers.has(s.bkptno)) return "normal";
  return "silent";
}

/**
 * 靜默停駐後如何續行。done 代表已到目標，呼叫端應改走正常流程。
 * continue：無深度條件，恆續行。
 * next：深度 > 起點 才續行（仍在被跨過的呼叫內）；否則即為目標。
 * finish：深度 ≥ 起點 才續行（仍在被結束的框架或更深）；否則即為目標。
 */
export function nextResume(kind: ResumeKind, originDepth: number, stopDepth: number): ResumeDecision {
  if (kind === "continue") return "continue";
  if (kind === "next") return stopDepth > originDepth ? "next" : "done";
  return stopDepth >= originDepth ? "finish" : "done";
}
