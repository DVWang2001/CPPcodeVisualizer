import {
  addQuestion,
  bindQuestion,
  emptyQuiz,
  moveQuestion,
  QuizQuestion,
  QuizSpec,
  removeQuestion
} from "../quizSchema";

const source = ["int main() {", "  int i = 0;", "  i++;", "  return i;", "}"].join(
  "\n"
);

function question(id: string, line: number): QuizQuestion {
  return {
    id,
    prompt: `題目 ${id}`,
    options: [
      { id: `${id}a`, text: "0" },
      { id: `${id}b`, text: "1" }
    ],
    correct_option_id: `${id}b`,
    explanation: "說明",
    trigger: {
      kind: "source_line",
      source_file: "main.cpp",
      line,
      anchor: { line_text: line === 3 ? "i++;" : "return i;", before_text: "", after_text: "" }
    }
  };
}

function quizWithIds(ids: string[]): QuizSpec {
  return { schema_version: 1, questions: ids.map((id, index) => question(id, index + 3)) };
}

test("bindQuestion captures the current Monaco line without mutating input", () => {
  const original = emptyQuiz();
  const withQuestion = addQuestion(original);
  const id = withQuestion.questions[0].id;
  const bound = bindQuestion(withQuestion, id, source, "main.cpp", 3);

  expect(original.questions).toEqual([]);
  expect(withQuestion.questions[0].trigger.line).toBe(0);
  expect(bound.questions[0].trigger).toEqual({
    kind: "source_line",
    source_file: "main.cpp",
    line: 3,
    anchor: { line_text: "i++;", before_text: "int i = 0;", after_text: "return i;" }
  });
});

test("moveQuestion preserves ids and changes only the copied order", () => {
  const quiz = quizWithIds(["q1", "q2"]);
  const moved = moveQuestion(quiz, "q2", -1);

  expect(moved.questions.map(value => value.id)).toEqual(["q2", "q1"]);
  expect(quiz.questions.map(value => value.id)).toEqual(["q1", "q2"]);
  expect(moved.questions[0]).not.toBe(quiz.questions[1]);
});

test("add and remove create new values and keep question ids unique", () => {
  const original = quizWithIds(["q1"]);
  const first = addQuestion(original);
  const second = addQuestion(first);
  const ids = second.questions.map(value => value.id);

  expect(new Set(ids).size).toBe(3);
  expect(original.questions).toHaveLength(1);
  expect(removeQuestion(second, ids[1]).questions.map(value => value.id)).toEqual([
    "q1",
    ids[2]
  ]);
  expect(second.questions).toHaveLength(3);
});

test("moving an edge or unknown question is a safe immutable no-op", () => {
  const quiz = quizWithIds(["q1", "q2"]);
  expect(moveQuestion(quiz, "q1", -1)).toEqual(quiz);
  expect(moveQuestion(quiz, "missing", 1)).toEqual(quiz);
  expect(moveQuestion(quiz, "q1", -1)).not.toBe(quiz);
});
