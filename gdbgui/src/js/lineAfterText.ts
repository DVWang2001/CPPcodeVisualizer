// S5: plain-language text for the "what this line did" panel (vg_line_after side event, S3/S4).
// Pure functions only, so they can be unit-tested without a DOM or a socket.

export interface VarChange {
  name: string;
  from: unknown;
  to: unknown;
  existed: boolean;
}

export type AfterState =
  | { kind: "stop"; line: number; changed: VarChange[] }
  | { kind: "frame-exit"; changed: VarChange[] }
  | { kind: "program-end"; changed: VarChange[] }
  | { kind: "unfinished"; reason: string; changed: VarChange[] };

export interface LineAfterPayload {
  line: number;
  fn: string;
  depth: number;
  after: AfterState;
  stdout: string | null;
  stderr: string | null;
}

/** A value as the student should read it; a variable that did not exist yet is spelled out. */
export function fmtValue(v: unknown): string {
  if (v === undefined) return "（尚未宣告）";
  return JSON.stringify(v);
}

/** Output with line breaks made visible (⏎) so a trailing newline is not lost in the panel. */
export function fmtOutput(text: string): string {
  return text.replace(/\n/g, "⏎");
}

/** The lines of text the panel shows for one stop. */
export function describeLineAfter(p: LineAfterPayload): string[] {
  const lines: string[] = [];
  lines.push(`第 ${p.line} 行執行後`);

  if (p.after.changed.length === 0) {
    lines.push("這一行沒有改變任何變數。");
  } else {
    for (const c of p.after.changed) lines.push(`變數 ${c.name}：${fmtValue(c.from)} → ${fmtValue(c.to)}`);
  }

  switch (p.after.kind) {
    case "frame-exit":
      lines.push("這個函式在此結束，控制權回到呼叫它的地方。");
      break;
    case "program-end":
      lines.push("程式在此結束。");
      break;
    case "unfinished":
      lines.push(`程式在這一行中止（${p.after.reason}），之後的狀態不可用。`);
      break;
    default:
      break;
  }

  if (p.stdout === null) lines.push("輸出：（無法對應到這一行）");
  else if (p.stdout === "") lines.push("輸出：（這一行沒有印出文字）");
  else lines.push(`輸出：「${fmtOutput(p.stdout)}」`);

  if (p.stderr) lines.push(`錯誤輸出：「${fmtOutput(p.stderr)}」`);
  return lines;
}
