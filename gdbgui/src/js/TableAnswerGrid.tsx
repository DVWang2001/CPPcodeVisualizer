import * as React from "react";
import { loadDraft, saveDraft } from "./tableDraft";
import { StudentQuizTableQuestion } from "./studentQuizState";

type Props = {
  question: StudentQuizTableQuestion;
  onSubmit: (values: string[][]) => void;
  submitted: boolean;
  // 取代送出按鈕的內容（確認列）：放在同一個黏底頁尾、同一個位置。
  footer?: React.ReactNode;
};

const MAX_CELL_LENGTH = 32;
const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "-"];

export default function TableAnswerGrid({ question, onSubmit, submitted, footer }: Props) {
  const form = React.useRef<HTMLFormElement | null>(null);
  const selectedCell = React.useRef<HTMLInputElement | null>(null);
  const formId = `table-form-${question.id}`;
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
    // 欄位是 text（number 會把輸入到一半的 "1." 或 "-" 清成空字串），所以自己擋掉非數字字元。
    const sanitize = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && /[^0-9.\-]/.test(target.value)) {
        target.value = target.value.replace(/[^0-9.\-]/g, "");
      }
    };
    element.addEventListener("input", sanitize);
    element.addEventListener("input", save);
    element.addEventListener("submit", submit);
    element.addEventListener("keydown", nextCell);
    return () => {
      element.removeEventListener("input", sanitize);
      element.removeEventListener("input", save);
      element.removeEventListener("submit", submit);
      element.removeEventListener("keydown", nextCell);
    };
  }, [question.id, question.rows, question.cols]);

  const locked = submitted || question.state === "closed";
  const padKey = (key: string) => {
    const input = selectedCell.current;
    if (!input || input.readOnly) return;
    if (key === "next") {
      const inputs = Array.from(form.current?.querySelectorAll("input") || []);
      const next = inputs[inputs.indexOf(input) + 1];
      if (next) next.focus();
      return;
    }
    if (key === "del") input.value = input.value.slice(0, -1);
    else if (input.value.length < MAX_CELL_LENGTH) input.value += key;
    // 走原本的 input 事件 → 草稿儲存，送出內容與手打完全一致。
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const showResults = question.state === "closed" && !!question.answer && !!question.correct_values;

  return (
    <>
    <div className="table-answer-scroll" style={{ overflow: "auto", maxHeight: "60vh" }}>
      <form ref={form} id={formId} className="table-answer-form">
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
                      type="text"
                      maxLength={MAX_CELL_LENGTH}
                      name={`cell-${row}-${col}`}
                      className={showResults ? (correct ? "is-correct" : "is-wrong") : locked ? "is-pending-lock" : ""}
                      inputMode="none"
                      readOnly={locked}
                      aria-label={`${question.row_labels[row]}，${question.col_labels[col]}${result ? `，${result}` : ""}`}
                      title={result || undefined}
                      onFocus={event => {
                        selectedCell.current = event.currentTarget;
                        event.currentTarget.select();
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          </tbody>
        </table>
      </form>
    </div>
    {(!locked || footer) && (
      <div className="quiz-footer">
        {!locked && (
          // mousedown 不搶焦點，選取中的格子才不會因為按鍵盤而失焦。
          <div className="number-pad" onMouseDown={event => event.preventDefault()}>
            {PAD_KEYS.map(key => (
              <button type="button" key={key} onClick={() => padKey(key)}>{key}</button>
            ))}
            <button type="button" onClick={() => padKey("del")}>刪除</button>
            <button type="button" onClick={() => padKey("next")}>下一格</button>
          </div>
        )}
        {footer || <button type="submit" form={formId} className="primary-action">送出答案</button>}
      </div>
    )}
    </>
  );
}
