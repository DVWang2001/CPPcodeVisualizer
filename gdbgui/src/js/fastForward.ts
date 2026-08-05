// ── 快轉指導 `[fast @N]` 的純邏輯 ────────────────────────────
// 這個檔案的兩個核心匯出都是純函式（不碰 store、不碰 GDB、不碰 React）：
//   parseFastDirective()  從「已選中的那一段」TTS 文字取出 @ 引數（尚未求值）
//   decideFastState()     用 (行號, 造訪次數, 目前狀態) 判定要武裝/持續/解除
//
// 設計核心：**終點條件綁在 (行號, 次數) 上，但抑制範圍是全域的**。
// 快轉期間每一個停駐點都靜音，不是只有目標行安靜——只讓目標行安靜的話，
// 迴圈本體的每一行還是會照唸，等於沒有快轉。
//
// 失敗模式一律是「沒有快轉」而非「教案壞掉」：求值失敗、次數已達標、
// 非自動播放模式都只是不武裝，`[fast @N]` 退化成 `[next]`。

import { global_variable } from "./global_variable";

/** 快轉模式狀態，掛在 `global_variable.__fast_forward`。 */
export interface FastForwardState {
  /** 武裝時所在的行號，也是唯一的終點行 */
  line: number;
  /** 目標造訪次數（已求值的正整數） */
  target: number;
  /** 已經靜音步進幾步，用於 5000 步安全上限 */
  steps: number;
}

export type FastDecision = "arm" | "hold" | "disarm" | "none";

/**
 * 安全上限：超過就強制解除。
 * 沒有這個上限時，一個打錯的 `@{變數}`（例如寫成迴圈變數）會讓教案永遠停不下來，
 * 而使用者在展示現場沒有辦法中止。
 */
export const FAST_FORWARD_STEP_LIMIT = 5000;

// ── ① 解析器 ────────────────────────────────────────────────

/**
 * `[fast @X]` 必須寫在該段最前面，`X` 可以是常數（`5`）或 `{變數}`（`{n}`）。
 * 與 `[next]` 家族不同，它帶一個引數，所以不能混進同一條 regex。
 */
const FAST_DIRECTIVE_RE = /^\[fast\s+@([^\]\s]+)\]\s*/;

/**
 * 解析快轉指令前綴，回傳**尚未求值**的 `@` 引數字串（`"5"` 或 `"{n}"`）。
 *
 * 呼叫端必須傳入「`|` 分段與 `@N` 門檻都套用完之後被選中的那一段」，
 * 不是原始的整條 TTS 文字——否則多段教案只會看到第一段的內容。
 */
export function parseFastDirective(ttsText: unknown): { target: string } | null {
  if (typeof ttsText !== "string" || !ttsText) return null;
  const m = ttsText.match(FAST_DIRECTIVE_RE);
  return m ? { target: m[1] } : null;
}

/** 去掉開頭的 `[fast @X]`，留下要唸出來的文字。沒有指令時原樣回傳。 */
export function stripFastDirective(ttsText: string): string {
  if (typeof ttsText !== "string" || !ttsText) return "";
  return ttsText.replace(FAST_DIRECTIVE_RE, "");
}

/** `@` 引數是不是 `{變數}` 形式（需要向 GDB 求值）。 */
export function isFastTargetExpr(raw: unknown): boolean {
  return typeof raw === "string" && raw.startsWith("{") && raw.endsWith("}");
}

/** 取出 `{變數}` 裡的運算式本體。 */
export function fastTargetExpr(raw: string): string {
  return raw.slice(1, -1).trim();
}

/**
 * 把常數字串或 GDB 求值結果轉成目標次數。
 * 不是正整數（含 `NaN`、`0`、負數、`"<optimized out>"` 之類）一律回 null＝不武裝。
 */
export function toFastTarget(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return n > 0 ? n : null;
}

// ── ② 狀態判定 ──────────────────────────────────────────────

/**
 * 判定這一次停駐該怎麼處理。
 *
 * - 已武裝：超過步數上限 → `disarm`；停在目標行且次數達標 → `disarm`；其餘一律 `hold`
 *   （`hold` 就是「靜音、零延遲、立刻步進」，不論停在哪一行）。
 * - 未武裝：帶著本行解析出來的 `target`，次數還沒到 → `arm`；已經到了 → `none`
 *   （直接照常播放，不武裝——否則會白白衝過整個教案）。
 *
 * `target` 是第四個參數而非塞進 `armed`：未武裝時沒有狀態物件可帶，
 * 已武裝時目標次數在武裝當下就固定了、不再重新求值。
 */
export function decideFastState(
  line: number,
  visitCount: number,
  armed: FastForwardState | null,
  target: number | null = null
): FastDecision {
  if (armed) {
    if (armed.steps > FAST_FORWARD_STEP_LIMIT) return "disarm";
    if (line === armed.line && visitCount >= armed.target) return "disarm";
    return "hold";
  }
  if (toFastTarget(target) === null) return "none";
  return visitCount < (target as number) ? "arm" : "none";
}

// ── ③ 全域狀態存取 ──────────────────────────────────────────
// 狀態放在 global_variable（而非 store）——快轉是播放期的暫態，
// 不需要觸發任何 React 重繪，而且 VisualizerHelper 與各 plugin 都拿得到。

export function getFastForward(): FastForwardState | null {
  return (global_variable as any).__fast_forward || null;
}

/** 動畫 `delay()` 用的旗標：快轉時所有動畫零延遲（照跑、只是不等）。 */
export function isFastForwarding(): boolean {
  return getFastForward() !== null;
}

// ── ④ 跳躍中的保險絲 ────────────────────────────────────────
// 武裝狀態現在只代表「一次跳在途中」（見 fastForwardJump.ts）：整段步進發生在
// GDB 行程內，正常情況幾百毫秒內就會有 blob 回來解除。
//
// 但 blob 是唯一的解除來源——GDB 掛掉、命令送壞、輸出被截斷，armed 就會永遠卡著，
// 而 armed 期間 _fast_forward_pause 會吃掉每一個停駐點，等於播放靜默死亡。
// 所以武裝一定要有時限。逾時解除的後果只是「這次沒跳成功」，可以接受。

const JUMP_TIMEOUT_MS = 20000;
let _jumpTimer: ReturnType<typeof setTimeout> | null = null;

export function armFastForward(line: number, target: number): FastForwardState {
  const state: FastForwardState = { line, target, steps: 0 };
  (global_variable as any).__fast_forward = state;
  if (_jumpTimer) clearTimeout(_jumpTimer);
  _jumpTimer = setTimeout(() => {
    console.warn("[fast] 跳躍逾時，未收到 blob，解除武裝");
    disarmFastForward();
  }, JUMP_TIMEOUT_MS);
  return state;
}

export function disarmFastForward(): void {
  (global_variable as any).__fast_forward = null;
  if (_jumpTimer) {
    clearTimeout(_jumpTimer);
    _jumpTimer = null;
  }
}
