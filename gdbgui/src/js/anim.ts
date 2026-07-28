// ── 各 plugin 共用的動畫延遲 ──────────────────────────────────
// BSTPlugin / LinearPlugin / MazePlugin 原本各有一份一模一樣的 delay()，
// 這裡收斂成一份，順便讓快轉模式有單一的插入點。

import { isFastForwarding } from "./fastForward";

/**
 * 動畫用的等待。快轉模式下直接返回——動畫**不跳過、只是零延遲**，
 * 所有 step 照樣依序執行，落地時的畫面與慢慢走完全一致。
 */
export function delay(ms: number): Promise<void> {
  if (isFastForwarding()) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
