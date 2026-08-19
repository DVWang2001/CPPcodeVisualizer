import * as React from "react";
import { loadDraft, saveDraft } from "./tableDraft";
import { StudentQuizTableQuestion } from "./studentQuizState";

type Props = {
  question: StudentQuizTableQuestion;
  onSubmit: (values: string[][]) => void;
  submitted: boolean;
};

export default function TableAnswerGrid({ question, onSubmit, submitted }: Props) {
  const values = React.useRef<string[][]>(
    question.answer || loadDraft(question.id, question.rows, question.cols)
  );
  const inputs = React.useRef<Array<HTMLInputElement | null>>([]);
  React.useEffect(() => {
    if (!question.answer) return;
    values.current = question.answer;
    question.answer.forEach((line, row) => line.forEach((value, col) => {
      const input = inputs.current[row * question.cols + col];
      if (input) input.value = value;
    }));
  }, [question.answer]);
  const locked = submitted || question.state === "closed";
  const showResults = question.state === "closed" && !!question.answer && !!question.correct_values;
  const displayedValues = showResults ? question.answer! : values.current;

  const change = (row: number, col: number, value: string) => {
    const next = values.current.map(line => line.slice());
    next[row][col] = value;
    values.current = next;
    saveDraft(question.id, next);
  };

  return (
    <div className="table-answer-scroll" style={{ overflow: "auto", maxHeight: "60vh" }}>
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
          {displayedValues.map((line, row) => (
            <tr key={row}>
              <th
                className="table-answer-row"
                style={{ position: "sticky" }}
                scope="row"
              >
                {question.row_labels[row]}
              </th>
              {line.map((value, col) => {
                const index = row * question.cols + col;
                const correct = showResults && value.trim() !== "" && value.trim() === question.correct_values![row][col].trim();
                const result = showResults
                  ? correct
                    ? "答案正確"
                    : `答案錯誤，正確答案 ${question.correct_values![row][col]}`
                  : "";
                return (
                  <td key={col}>
                    <input
                      ref={element => { inputs.current[index] = element; }}
                      className={showResults ? correct ? "is-correct" : "is-wrong" : ""}
                      inputMode="numeric"
                      maxLength={32}
                      defaultValue={value}
                      disabled={locked}
                      aria-label={`${question.row_labels[row]}，${question.col_labels[col]}${result ? `，${result}` : ""}`}
                      title={result || undefined}
                      onInput={event => change(row, col, event.currentTarget.value)}
                      onKeyDown={event => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        const next = inputs.current[index + 1];
                        if (next) next.focus();
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!locked && (
        <button type="button" className="primary-action" onClick={() => onSubmit(values.current)}>
          送出答案
        </button>
      )}
    </div>
  );
}
