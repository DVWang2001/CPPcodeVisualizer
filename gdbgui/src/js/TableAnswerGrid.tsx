import * as React from "react";
import { loadDraft, saveDraft } from "./tableDraft";
import { StudentQuizTableQuestion } from "./studentQuizState";

type Props = {
  question: StudentQuizTableQuestion;
  onSubmit: (values: string[][]) => void;
  submitted: boolean;
};

export default function TableAnswerGrid({ question, onSubmit, submitted }: Props) {
  const form = React.useRef<HTMLFormElement | null>(null);
  const onSubmitRef = React.useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  React.useEffect(() => {
    const values = question.answer || loadDraft(question.id, question.rows, question.cols);
    values.forEach((line, row) => line.forEach((value, col) => {
      const input = form.current?.elements.namedItem(`cell-${row}-${col}`) as HTMLInputElement | null;
      if (input) input.value = value;
    }));
  }, [question.id, question.answer, question.rows, question.cols]);

  React.useEffect(() => {
    const element = form.current;
    if (!element) return;
    const read = () => Array.from({ length: question.rows }, (_, row) =>
      Array.from({ length: question.cols }, (_, col) => {
        const input = element.elements.namedItem(`cell-${row}-${col}`) as HTMLInputElement | null;
        return input?.value || "";
      })
    );
    const save = () => saveDraft(question.id, read());
    const submit = (event: Event) => {
      event.preventDefault();
      const answer = read();
      saveDraft(question.id, answer);
      onSubmitRef.current(answer);
    };
    const nextCell = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      const inputs = Array.from(element.querySelectorAll("input"));
      const next = inputs[inputs.indexOf(event.target) + 1];
      if (next) next.focus();
    };
    element.addEventListener("input", save);
    element.addEventListener("submit", submit);
    element.addEventListener("keydown", nextCell);
    return () => {
      element.removeEventListener("input", save);
      element.removeEventListener("submit", submit);
      element.removeEventListener("keydown", nextCell);
    };
  }, [question.id, question.rows, question.cols]);

  const locked = submitted || question.state === "closed";
  const showResults = question.state === "closed" && !!question.answer && !!question.correct_values;

  return (
    <div className="table-answer-scroll" style={{ overflow: "auto", maxHeight: "60vh" }}>
      <form ref={form} className="table-answer-form">
        <table className="table-answer-grid">
          <caption className="sr-only">填表答案</caption>
          <thead>
          <tr>
            <th
              className="table-answer-corner"
              style={{ position: "sticky" }}
              aria-hidden="true"
            />
            {question.col_labels.map((label, col) => (
              <th
                className="table-answer-col"
                style={{ position: "sticky" }}
                scope="col"
                key={col}
              >
                {label}
              </th>
            ))}
          </tr>
          </thead>
          <tbody>
          {Array.from({ length: question.rows }, (_, row) => (
            <tr key={row}>
              <th
                className="table-answer-row"
                style={{ position: "sticky" }}
                scope="row"
              >
                {question.row_labels[row]}
              </th>
              {Array.from({ length: question.cols }, (_, col) => {
                const value = question.answer?.[row]?.[col] || "";
                const correct = showResults && value.trim() !== "" && value.trim() === question.correct_values![row][col].trim();
                const result = showResults
                  ? correct
                    ? "答案正確"
                    : `答案錯誤，正確答案 ${question.correct_values![row][col]}`
                  : "";
                return (
                  <td key={col}>
                    <input
                      type="number"
                      step="any"
                      name={`cell-${row}-${col}`}
                      className={showResults ? correct ? "is-correct" : "is-wrong" : ""}
                      inputMode="numeric"
                      readOnly={locked}
                      aria-label={`${question.row_labels[row]}，${question.col_labels[col]}${result ? `，${result}` : ""}`}
                      title={result || undefined}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          </tbody>
        </table>
        {!locked && <button className="primary-action">送出答案</button>}
      </form>
    </div>
  );
}
