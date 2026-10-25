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

/** 教學頁「執行到這一行」：從 line（1 起算）往下找第一個可執行的行；找不到就用原行。 */
export function nearestRunnableLine(lines: string[], line: number): number {
  for (let k = line; k <= lines.length; k++) {
    if (isRunnableLine(lines[k - 1] ?? "")) return k;
  }
  return line;
}
