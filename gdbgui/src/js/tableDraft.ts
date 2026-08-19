const PREFIX = "gdbgui_table_draft:";

const blank = (rows: number, cols: number): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));

export function loadDraft(questionKey: string, rows: number, cols: number): string[][] {
  try {
    const raw = localStorage.getItem(PREFIX + questionKey);
    if (!raw) return blank(rows, cols);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== rows || parsed.some(
      (line: unknown) => !Array.isArray(line) || line.length !== cols ||
        line.some((cell: unknown) => typeof cell !== "string")
    )) return blank(rows, cols);
    return parsed as string[][];
  } catch {
    return blank(rows, cols);
  }
}

export function saveDraft(questionKey: string, values: string[][]): void {
  try {
    localStorage.setItem(PREFIX + questionKey, JSON.stringify(values));
  } catch {
    // 草稿儲存失敗不能中斷作答。
  }
}

export function clearDraft(questionKey: string): void {
  try {
    localStorage.removeItem(PREFIX + questionKey);
  } catch {
    // 草稿清除失敗不能中斷作答。
  }
}
