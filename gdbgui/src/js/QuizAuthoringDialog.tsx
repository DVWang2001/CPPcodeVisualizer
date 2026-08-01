import * as React from "react";
import {
  addOption,
  addQuestion,
  bindQuestion,
  cloneQuiz,
  emptyQuiz,
  moveQuestion,
  QuizQuestion,
  QuizSpec,
  removeOption,
  removeQuestion,
  validateQuiz
} from "./quizSchema";

type Props = {
  quiz: QuizSpec | null;
  sourceCode: string;
  sourceFile: string;
  getCursorLine: () => number;
  onSave: (quiz: QuizSpec) => void;
  onClose: () => void;
};

const colors = {
  ink: "#17233b",
  muted: "#667085",
  paper: "#f7f9fc",
  line: "#d8dee9",
  amber: "#e9a319",
  error: "#a61b1b"
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2100,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  padding: "20px",
  background: "rgba(11, 18, 32, .58)"
};

const panel: React.CSSProperties = {
  width: "min(920px, 100%)",
  maxHeight: "calc(100vh - 40px)",
  overflow: "auto",
  background: "#fff",
  color: colors.ink,
  boxShadow: "0 18px 54px rgba(0, 0, 0, .32)"
};

const count = (value: string) => Array.from(value).length;

export default function QuizAuthoringDialog({
  quiz,
  sourceCode,
  sourceFile,
  getCursorLine,
  onSave,
  onClose
}: Props) {
  const [draft, setDraft] = React.useState<QuizSpec>(() => cloneQuiz(quiz) || emptyQuiz());
  const [bindingErrors, setBindingErrors] = React.useState<{ [id: string]: string }>({});
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);
  const validation = validateQuiz(draft, sourceCode, sourceFile);

  React.useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    const first = dialogRef.current && dialogRef.current.querySelector<HTMLElement>("button");
    if (first) first.focus();
    return () => {
      if (previousFocus.current && document.contains(previousFocus.current)) {
        previousFocus.current.focus();
      }
    };
  }, []);

  const updateQuestion = (id: string, update: (question: QuizQuestion) => QuizQuestion) => {
    setDraft({
      ...draft,
      questions: draft.questions.map(question =>
        question.id === id ? update({ ...question, options: question.options.map(o => ({ ...o })) }) : question
      )
    });
  };

  const bind = (id: string) => {
    try {
      setDraft(bindQuestion(draft, id, sourceCode, sourceFile, getCursorLine()));
      setBindingErrors({ ...bindingErrors, [id]: "" });
    } catch (error) {
      setBindingErrors({
        ...bindingErrors,
        [id]: error instanceof Error ? error.message : "無法綁定目前行。"
      });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const controls = Array.prototype.slice.call(
      dialogRef.current.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled])"
      )
    ) as HTMLElement[];
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (
      (!event.shiftKey && index === controls.length - 1) ||
      (event.shiftKey && index <= 0)
    ) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  };

  const save = () => {
    const result = validateQuiz(draft, sourceCode, sourceFile);
    if (result.quiz) onSave(result.quiz);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="quiz-authoring-title"
      data-testid="quiz-authoring-dialog"
      style={overlay}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <section style={panel}>
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            padding: "18px 22px",
            borderBottom: `1px solid ${colors.line}`,
            background: "rgba(255,255,255,.97)"
          }}
        >
          <div>
            <h2 id="quiz-authoring-title" style={{ margin: 0, fontSize: "22px" }}>
              課堂題目
            </h2>
            <div style={{ color: colors.muted, fontSize: "12px", marginTop: "3px" }}>
              把單選題綁到播放時會停下的程式碼行 · {draft.questions.length}/30 題
            </div>
          </div>
          <button
            type="button"
            className="btn btn-default"
            onClick={() => setDraft(addQuestion(draft))}
            disabled={draft.questions.length >= 30}
          >
            ＋ 新增題目
          </button>
        </header>

        <div style={{ padding: "20px 22px", background: colors.paper }}>
          {draft.questions.length === 0 && (
            <div
              style={{
                padding: "42px 20px",
                textAlign: "center",
                color: colors.muted,
                border: `1px dashed ${colors.line}`,
                background: "#fff"
              }}
            >
              目前沒有題目。新增後，請把每一題綁定到一行程式碼。
            </div>
          )}

          {draft.questions.map((question, index) => {
            const prefix = `第 ${index + 1} 題`;
            const errors = validation.errors.filter(error => error.indexOf(prefix) >= 0);
            if (bindingErrors[question.id]) errors.push(bindingErrors[question.id]);
            return (
              <article
                key={question.id}
                style={{
                  position: "relative",
                  marginBottom: "16px",
                  padding: "18px 18px 18px 24px",
                  border: `1px solid ${colors.line}`,
                  borderLeft: `5px solid ${colors.amber}`,
                  background: "#fff"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    marginBottom: "14px"
                  }}
                >
                  <strong style={{ fontSize: "16px" }}>{prefix}</strong>
                  <div style={{ display: "flex", gap: "5px" }}>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      aria-label={`${prefix}上移`}
                      disabled={index === 0}
                      onClick={() => setDraft(moveQuestion(draft, question.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      aria-label={`${prefix}下移`}
                      disabled={index === draft.questions.length - 1}
                      onClick={() => setDraft(moveQuestion(draft, question.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      onClick={() => setDraft(removeQuestion(draft, question.id))}
                    >
                      刪除
                    </button>
                  </div>
                </div>

                <label htmlFor={`prompt-${question.id}`} style={{ width: "100%" }}>
                  <span style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>題幹</span>
                    <small style={{ color: colors.muted }}>{count(question.prompt)}/500</small>
                  </span>
                  <textarea
                    id={`prompt-${question.id}`}
                    className="form-control"
                    rows={2}
                    value={question.prompt}
                    onChange={event =>
                      updateQuestion(question.id, value => ({ ...value, prompt: event.target.value }))
                    }
                  />
                </label>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "8px",
                    margin: "12px 0"
                  }}
                >
                  <button type="button" className="btn btn-default btn-sm" onClick={() => bind(question.id)}>
                    綁定目前行
                  </button>
                  <code
                    style={{
                      padding: "5px 8px",
                      color: colors.ink,
                      background: "#fff7df",
                      border: "1px solid #f2d38b"
                    }}
                  >
                    {question.trigger.line > 0
                      ? `${question.trigger.source_file} · L${question.trigger.line}`
                      : "尚未綁定"}
                  </code>
                </div>

                <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
                  <legend style={{ fontSize: "14px", marginBottom: "8px", border: 0 }}>
                    選項（點圓鈕指定正解）
                  </legend>
                  {question.options.map((option, optionIndex) => (
                    <div
                      key={option.id}
                      style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}
                    >
                      <input
                        type="radio"
                        name={`correct-${question.id}`}
                        aria-label={`選項 ${optionIndex + 1} 是正解`}
                        checked={question.correct_option_id === option.id}
                        onChange={() =>
                          updateQuestion(question.id, value => ({
                            ...value,
                            correct_option_id: option.id
                          }))
                        }
                      />
                      <input
                        className="form-control"
                        aria-label={`${prefix}選項 ${optionIndex + 1}`}
                        value={option.text}
                        onChange={event =>
                          updateQuestion(question.id, value => ({
                            ...value,
                            options: value.options.map(item =>
                              item.id === option.id ? { ...item, text: event.target.value } : item
                            )
                          }))
                        }
                      />
                      <small style={{ minWidth: "48px", color: colors.muted }}>
                        {count(option.text)}/200
                      </small>
                      <button
                        type="button"
                        className="btn btn-default btn-sm"
                        disabled={question.options.length <= 2}
                        onClick={() => setDraft(removeOption(draft, question.id, option.id))}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-default btn-sm"
                    disabled={question.options.length >= 6}
                    onClick={() => setDraft(addOption(draft, question.id))}
                  >
                    ＋ 新增選項
                  </button>
                </fieldset>

                <label htmlFor={`explanation-${question.id}`} style={{ width: "100%" }}>
                  <span style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>關題後解說</span>
                    <small style={{ color: colors.muted }}>
                      {count(question.explanation)}/1000
                    </small>
                  </span>
                  <textarea
                    id={`explanation-${question.id}`}
                    className="form-control"
                    rows={2}
                    value={question.explanation}
                    onChange={event =>
                      updateQuestion(question.id, value => ({
                        ...value,
                        explanation: event.target.value
                      }))
                    }
                  />
                </label>

                {errors.length > 0 && (
                  <ul aria-live="polite" style={{ color: colors.error, margin: "10px 0 0", paddingLeft: "20px" }}>
                    {errors.map((error, errorIndex) => (
                      <li key={`${error}-${errorIndex}`}>{error}</li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}

          {validation.errors.some(error => error.indexOf("第 ") !== 0) && (
            <div role="alert" style={{ color: colors.error, marginTop: "12px" }}>
              {validation.errors.filter(error => error.indexOf("第 ") !== 0).join(" ")}
            </div>
          )}
        </div>

        <footer
          style={{
            position: "sticky",
            bottom: 0,
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "14px 22px",
            borderTop: `1px solid ${colors.line}`,
            background: "#fff"
          }}
        >
          <button type="button" className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={validation.errors.length > 0}
          >
            儲存題目
          </button>
        </footer>
      </section>
    </div>
  );
}
