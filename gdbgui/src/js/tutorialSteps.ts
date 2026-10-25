/** 教學頁「專注步進」：一次只放大一個步驟。step＝目前在第幾步（0 起算），等於步驟數代表整課做完。 */
export type StepState = "done" | "now" | "upcoming";

export function stepState(i: number, step: number): StepState {
  return i < step ? "done" : i === step ? "now" : "upcoming";
}

/** 往下一步；最多停在 n（做完）。 */
export function nextStep(step: number, n: number): number {
  return Math.min(step + 1, n);
}

/** 往上一步；從「做完」退回最後一步，最少停在 0。 */
export function prevStep(step: number): number {
  return Math.max(step - 1, 0);
}
