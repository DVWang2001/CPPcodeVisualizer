import { cloneQuiz, QuizQuestion, QuizSpec, validateQuiz } from "../quizSchema";

const source = [
  "int main() {",
  "  int i = 0;",
  "  i++;  //@ @guide 說明",
  "  return 0;",
  "}"
].join("\n");

const question = (overrides: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: "q1",
  prompt: "i 是多少？",
  options: [{ id: "a", text: "0" }, { id: "b", text: "1" }],
  correct_option_id: "b",
  explanation: "i++ 會遞增。",
  trigger: {
    kind: "source_line",
    source_file: "main.cpp",
    line: 3,
    anchor: {
      line_text: "i++;",
      before_text: "int i = 0;",
      after_text: "return 0;"
    }
  },
  ...overrides
});

const quiz = (questions: QuizQuestion[] = [question()]): QuizSpec => ({
  schema_version: 1,
  questions
});

test("accepts and clones a valid single-choice quiz", () => {
  const result = validateQuiz(quiz(), source, "main.cpp");

  expect(result.errors).toEqual([]);
  expect(result.quiz).toEqual(quiz());
  expect(result.quiz).not.toBe(quiz());
});

test("missing quiz is valid but malformed roots and unknown fields are rejected", () => {
  expect(validateQuiz(null, source, "main.cpp")).toEqual({ quiz: null, errors: [] });
  expect(validateQuiz(undefined, source, "main.cpp")).toEqual({ quiz: null, errors: [] });
  expect(validateQuiz([], source, "main.cpp").errors.join(" ")).toContain("題庫格式");
  expect(
    validateQuiz({ schema_version: 1, questions: [], surprise: true }, source, "main.cpp")
      .errors.join(" ")
  ).toContain("未知欄位");
});

test.each([
  [question({ prompt: "" }), "題幹"],
  [question({ id: "q/1" }), "題目 ID"],
  [question({ id: ".." }), "題目 ID"],
  [question({ prompt: "x".repeat(501) }), "題幹"],
  [question({ options: [{ id: "a", text: "0" }] }), "選項"],
  [question({ options: [{ id: "a", text: "0" }, { id: "a", text: "1" }] }), "選項 ID"],
  [question({ correct_option_id: "missing" }), "正解"],
  [question({ explanation: "x".repeat(1001) }), "解說"],
  [{ ...question(), surprise: true } as any, "未知欄位"]
])("rejects an invalid question %#", (bad, fragment) => {
  expect(validateQuiz(quiz([bad as QuizQuestion]), source, "main.cpp").errors.join(" ")).toContain(
    fragment
  );
});

test("rejects duplicate question ids, duplicate resolved anchors and the wrong source file", () => {
  expect(validateQuiz(quiz([question(), question()]), source, "main.cpp").errors.join(" ")).toContain(
    "題目 ID"
  );
  expect(
    validateQuiz(quiz([question(), question({ id: "q2" })]), source, "main.cpp").errors.join(" ")
  ).toContain("同一程式碼行");
  expect(validateQuiz(quiz(), source, "other.cpp").errors.join(" ")).toContain("來源檔案");
});

test("rejects an anchor that no longer resolves and clones without sharing nested values", () => {
  expect(
    validateQuiz(quiz(), source.replace("i++;", "i += 2;"), "main.cpp").errors.join(" ")
  ).toContain("重新綁定");

  const original = quiz();
  const copy = cloneQuiz(original)!;
  copy.questions[0].options[0].text = "changed";
  expect(original.questions[0].options[0].text).toBe("0");
});
