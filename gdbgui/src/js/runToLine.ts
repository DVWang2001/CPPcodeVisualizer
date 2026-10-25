import { stripDirective } from "./sourceAnnotations";

const CONTROL = /^(if|for|while|switch|else|return|catch|do)\b/;
// 函式標頭：`int main() {`、`void f(int a) const {`。不含 `;`，也不是控制敘述。
const FUNC_HEADER = /^[\w:<>,*&\s~]+\([^;]*\)\s*(const)?\s*\{?$/;

/** 這一行有沒有可能被執行（可以停下來）。空行、前置處理、using、純括號、純註解、函式標頭都不行。 */
export function isRunnableLine(text: string): boolean {
  const code = stripDirective(text).trim();
  if (!code) return false;
  if (code.startsWith("#") || code.startsWith("//") || code.startsWith("/*")) return false;
  if (/^using\b/.test(code)) return false;
  if (/^[{}();\s]*$/.test(code)) return false;
  if (/^\}?\s*else\s*\{?$/.test(code)) return false;
  if (FUNC_HEADER.test(code) && !CONTROL.test(code)) return false;
  return true;
}

/** 教學頁：目前「停在某行第 k / n 次進入」的狀態。n 要等第一次停下來、從引擎軌迹數出來才知道。 */
export interface Visit {
  /** 使用者按 Enter 的那一行（已換算成可執行行） */
  requested: number;
  /** 實際停下來的行 */
  line: number;
  /** 這次執行用的程式碼，改過就不算同一次 */
  code: string;
  k: number;
  n: number | null;
}

/**
 * 按 Enter 之後該做什麼：同一行、程式沒改、還停在那一行、還沒到第 n 次 → 'continue'（進到下一次）；
 * 其他情況（第一次、改過、換行、已到第 n 次）→ 'fresh'（重跑，回到第 1 次）。
 */
export function decideEnter(
  v: Visit | null,
  requested: number,
  code: string,
  pausedLine: number | null
): "continue" | "fresh" {
  if (v && v.n && v.requested === requested && v.code === code && pausedLine === v.line && v.k < v.n) {
    return "continue";
  }
  return "fresh";
}

/** 教學頁「執行到這一行」：從 line（1 起算）往下找第一個可執行的行；找不到就用原行。 */
export function nearestRunnableLine(lines: string[], line: number): number {
  for (let k = line; k <= lines.length; k++) {
    if (isRunnableLine(lines[k - 1] ?? "")) return k;
  }
  return line;
}
