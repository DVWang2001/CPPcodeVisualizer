import {
  normalizedSourceLine,
  makeSourceTrigger,
  resolveSourceTrigger,
  sourceBasename,
  triggerMatchesFrame
} from "./quizTrigger";

export type QuizOption = { id: string; text: string };
export type QuizAnchor = { line_text: string; before_text: string; after_text: string };
export type QuizTrigger = {
  kind: "source_line";
  source_file: string;
  line: number;
  anchor: QuizAnchor;
};
export type QuizQuestion = {
  id: string;
  prompt: string;
  options: QuizOption[];
  correct_option_id: string;
  explanation: string;
  trigger: QuizTrigger;
};
export type QuizSpec = { schema_version: 1; questions: QuizQuestion[] };
export type QuizValidation = { quiz: QuizSpec | null; errors: string[] };

const QUIZ_KEYS = ["schema_version", "questions"];
const QUESTION_KEYS = [
  "id",
  "prompt",
  "options",
  "correct_option_id",
  "explanation",
  "trigger"
];
const OPTION_KEYS = ["id", "text"];
const TRIGGER_KEYS = ["kind", "source_file", "line", "anchor"];
const ANCHOR_KEYS = ["line_text", "before_text", "after_text"];

const isRecord = (value: any): value is { [key: string]: any } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyKeys = (value: { [key: string]: any }, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const charCount = (value: string): number => Array.from(value).length;

function trimmed(value: any, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  const length = charCount(result);
  return length >= min && length <= max ? result : null;
}

function exactKeys(value: any, keys: string[], label: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${label}格式不正確。`);
    return false;
  }
  if (!hasOnlyKeys(value, keys)) {
    errors.push(`${label}含有未知欄位或缺少必要欄位。`);
    return false;
  }
  return true;
}

function parseTrigger(raw: any, index: number, errors: string[]): QuizTrigger | null {
  const label = `第 ${index + 1} 題觸發器`;
  if (!exactKeys(raw, TRIGGER_KEYS, label, errors)) return null;
  if (raw.kind !== "source_line") errors.push(`${label}只支援 source_line。`);
  const source_file = typeof raw.source_file === "string" ? sourceBasename(raw.source_file.trim()) : "";
  if (!source_file) errors.push(`${label}缺少來源檔案。`);
  if (!Number.isInteger(raw.line) || raw.line < 1) errors.push(`${label}行號必須是正整數。`);
  if (!exactKeys(raw.anchor, ANCHOR_KEYS, `${label}錨點`, errors)) return null;

  const anchorKeys = ANCHOR_KEYS as Array<keyof QuizAnchor>;
  const anchor = {} as QuizAnchor;
  anchorKeys.forEach(key => {
    const value = raw.anchor[key];
    if (typeof value !== "string" || normalizedSourceLine(value) !== value) {
      errors.push(`${label}錨點文字必須已正規化。`);
    }
    anchor[key] = typeof value === "string" ? value : "";
  });
  if (!anchor.line_text) errors.push(`${label}綁定行不可空白。`);

  return {
    kind: "source_line",
    source_file,
    line: Number.isInteger(raw.line) ? raw.line : 0,
    anchor
  };
}

function parseQuestion(raw: any, index: number, errors: string[]): QuizQuestion | null {
  const label = `第 ${index + 1} 題`;
  if (!exactKeys(raw, QUESTION_KEYS, label, errors)) return null;

  const id = trimmed(raw.id, 1, Number.MAX_SAFE_INTEGER);
  const prompt = trimmed(raw.prompt, 1, 500);
  const explanation = trimmed(raw.explanation, 0, 1000);
  if (!id) errors.push(`${label}的題目 ID 不可空白。`);
  if (prompt === null) errors.push(`${label}題幹需為 1 至 500 字。`);
  if (explanation === null) errors.push(`${label}解說不可超過 1,000 字。`);

  const options: QuizOption[] = [];
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 6) {
    errors.push(`${label}選項需有 2 至 6 個。`);
  } else {
    const optionIds = new Set<string>();
    raw.options.forEach((option: any, optionIndex: number) => {
      if (!exactKeys(option, OPTION_KEYS, `${label}第 ${optionIndex + 1} 個選項`, errors)) return;
      const optionId = trimmed(option.id, 1, Number.MAX_SAFE_INTEGER);
      const text = trimmed(option.text, 1, 200);
      if (!optionId || optionIds.has(optionId)) errors.push(`${label}的選項 ID 必須非空且不重複。`);
      if (text === null) errors.push(`${label}每個選項需為 1 至 200 字。`);
      if (optionId) optionIds.add(optionId);
      options.push({ id: optionId || "", text: text || "" });
    });
  }

  const correct = typeof raw.correct_option_id === "string" ? raw.correct_option_id.trim() : "";
  if (!correct || options.filter(option => option.id === correct).length !== 1) {
    errors.push(`${label}正解必須對應一個選項。`);
  }
  const trigger = parseTrigger(raw.trigger, index, errors);
  if (!trigger) return null;
  return {
    id: id || "",
    prompt: prompt || "",
    options,
    correct_option_id: correct,
    explanation: explanation || "",
    trigger
  };
}

export function cloneQuiz(quiz: QuizSpec | null): QuizSpec | null {
  return quiz === null ? null : JSON.parse(JSON.stringify(quiz));
}

let authoringIdCounter = 0;

function authoringId(prefix: string): string {
  authoringIdCounter += 1;
  try {
    const values = new Uint32Array(2);
    if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(values);
      return `${prefix}_${values[0].toString(36)}${values[1].toString(36)}_${authoringIdCounter}`;
    }
  } catch (_) {}
  return `${prefix}_${Date.now().toString(36)}_${authoringIdCounter}`;
}

export function emptyQuiz(): QuizSpec {
  return { schema_version: 1, questions: [] };
}

export function addQuestion(quiz: QuizSpec): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  if (copy.questions.length >= 30) return copy;
  const firstOption = authoringId("option");
  copy.questions.push({
    id: authoringId("question"),
    prompt: "",
    options: [
      { id: firstOption, text: "" },
      { id: authoringId("option"), text: "" }
    ],
    correct_option_id: firstOption,
    explanation: "",
    trigger: {
      kind: "source_line",
      source_file: "",
      line: 0,
      anchor: { line_text: "", before_text: "", after_text: "" }
    }
  });
  return copy;
}

export function removeQuestion(quiz: QuizSpec, questionId: string): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  copy.questions = copy.questions.filter(question => question.id !== questionId);
  return copy;
}

export function addOption(quiz: QuizSpec, questionId: string): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  const question = copy.questions.find(value => value.id === questionId);
  if (!question || question.options.length >= 6) return copy;
  question.options.push({ id: authoringId("option"), text: "" });
  return copy;
}

export function removeOption(
  quiz: QuizSpec,
  questionId: string,
  optionId: string
): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  const question = copy.questions.find(value => value.id === questionId);
  if (!question || question.options.length <= 2) return copy;
  question.options = question.options.filter(option => option.id !== optionId);
  if (!question.options.some(option => option.id === question.correct_option_id)) {
    question.correct_option_id = question.options[0].id;
  }
  return copy;
}

export function moveQuestion(
  quiz: QuizSpec,
  questionId: string,
  direction: -1 | 1
): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  const index = copy.questions.findIndex(question => question.id === questionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= copy.questions.length) return copy;
  const moved = copy.questions.splice(index, 1)[0];
  copy.questions.splice(target, 0, moved);
  return copy;
}

export function bindQuestion(
  quiz: QuizSpec,
  questionId: string,
  sourceCode: string,
  sourceFile: string,
  line: number
): QuizSpec {
  const copy = cloneQuiz(quiz)!;
  const question = copy.questions.find(value => value.id === questionId);
  if (!question) return copy;
  question.trigger = makeSourceTrigger(sourceCode, sourceFile, line);
  return copy;
}

export function validateQuiz(raw: unknown, sourceCode: string, sourceFile?: string): QuizValidation {
  if (raw === undefined || raw === null) return { quiz: null, errors: [] };
  const errors: string[] = [];
  if (!exactKeys(raw, QUIZ_KEYS, "題庫", errors)) return { quiz: null, errors };
  const value = raw as { [key: string]: any };
  if (value.schema_version !== 1) errors.push("題庫版本必須是 1。");
  if (!Array.isArray(value.questions) || value.questions.length > 30) {
    errors.push("題庫問題數不可超過 30 題。");
    return { quiz: null, errors };
  }

  const questions = value.questions
    .map((question: any, index: number) => parseQuestion(question, index, errors))
    .filter((question: QuizQuestion | null): question is QuizQuestion => question !== null);
  const questionIds = new Set<string>();
  const triggerKeys = new Set<string>();
  questions.forEach((question, index) => {
    if (!question.id || questionIds.has(question.id)) errors.push("題目 ID 必須非空且不重複。");
    questionIds.add(question.id);

    if (
      sourceFile &&
      !triggerMatchesFrame(question.trigger, { fullname: sourceFile, line: question.trigger.line })
    ) {
      errors.push(`第 ${index + 1} 題的來源檔案與目前教案不符。`);
    }
    const resolved = resolveSourceTrigger(question.trigger, sourceCode);
    if (!resolved.resolved) {
      errors.push(`第 ${index + 1} 題找不到唯一程式碼錨點，請重新綁定。`);
      return;
    }
    question.trigger = resolved.trigger;
    const triggerKey = `${sourceBasename(resolved.trigger.source_file)}:${resolved.trigger.line}`;
    if (triggerKeys.has(triggerKey)) errors.push("同一程式碼行只能綁定一題。");
    triggerKeys.add(triggerKey);
  });

  const quiz: QuizSpec = { schema_version: 1, questions };
  return errors.length ? { quiz: null, errors } : { quiz: cloneQuiz(quiz), errors: [] };
}
