import { stripDirective } from "./sourceAnnotations";
import { QuizTrigger } from "./quizSchema";

export type SourceFrame = {
  fullname?: string;
  file?: string;
  line?: string | number;
};

export type ResolvedTrigger = {
  trigger: QuizTrigger;
  resolved: boolean;
  reason?: string;
};

export const normalizedSourceLine = (line: string): string =>
  stripDirective(line).trim().replace(/\s+/g, " ");

export function sourceBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

function copyTrigger(trigger: QuizTrigger, line = trigger.line): QuizTrigger {
  return { ...trigger, line, anchor: { ...trigger.anchor } };
}

function anchorAt(lines: string[], index: number) {
  return {
    line_text: lines[index] || "",
    before_text: lines[index - 1] || "",
    after_text: lines[index + 1] || ""
  };
}

function sameAnchor(left: QuizTrigger["anchor"], right: QuizTrigger["anchor"]): boolean {
  return (
    left.line_text === right.line_text &&
    left.before_text === right.before_text &&
    left.after_text === right.after_text
  );
}

export function makeSourceTrigger(
  sourceCode: string,
  sourceFile: string,
  line: number
): QuizTrigger {
  const lines = sourceCode.split("\n").map(normalizedSourceLine);
  if (!Number.isInteger(line) || line < 1 || line > lines.length || !lines[line - 1]) {
    throw new Error("請把題目綁定到非空白的程式碼行。");
  }
  const source_file = sourceBasename(sourceFile);
  if (!source_file) throw new Error("找不到題目的來源檔案。");
  return {
    kind: "source_line",
    source_file,
    line,
    anchor: anchorAt(lines, line - 1)
  };
}

export function resolveSourceTrigger(trigger: QuizTrigger, sourceCode: string): ResolvedTrigger {
  const lines = sourceCode.split("\n").map(normalizedSourceLine);
  const candidates: number[] = [];
  lines.forEach((line, index) => {
    if (line && sameAnchor(anchorAt(lines, index), trigger.anchor)) candidates.push(index + 1);
  });
  if (candidates.length === 1) {
    return { trigger: copyTrigger(trigger, candidates[0]), resolved: true };
  }
  return {
    trigger: copyTrigger(trigger),
    resolved: false,
    reason: candidates.length ? "程式碼錨點不唯一，請重新綁定。" : "找不到程式碼錨點，請重新綁定。"
  };
}

export function triggerMatchesFrame(trigger: QuizTrigger, frame: SourceFrame): boolean {
  const frameLine = typeof frame.line === "number" ? frame.line : Number(frame.line);
  if (!Number.isInteger(frameLine) || frameLine < 1 || frameLine !== trigger.line) return false;

  const framePath = frame.fullname || frame.file || "";
  const expected = sourceBasename(trigger.source_file);
  const actual = sourceBasename(framePath);
  if (!expected || !actual) return false;
  return trigger.source_file.indexOf("\\") >= 0 || framePath.indexOf("\\") >= 0
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}
