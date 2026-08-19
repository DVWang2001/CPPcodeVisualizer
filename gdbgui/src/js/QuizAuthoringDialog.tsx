import * as React from "react";
import {
  addOption,
  addQuestion,
  bindQuestion,
  changeQuestionKind,
  cloneQuiz,
  emptyQuiz,
  moveQuestion,
  MAX_CELLS_CEILING,
  QuizQuestion,
  QuizSpec,
  removeOption,
  removeQuestion,
  validateQuiz
} from "./quizSchema";
import { global_variable } from "./global_variable";

type Props = {
  quiz: QuizSpec | null;
  sourceCode: string;
  sourceFile: string;
  getCursorLine: () => number;
  onSave: (quiz: QuizSpec) => void;
  onClose: () => void;
  /**
   * 別人的教案：只能看，不能改。
   *
   * 題目只存在 bundle 裡，畫面上沒有別的地方看得到，所以不是把入口鎖掉，
   * 而是做成唯讀檢視——想拿來教就先「存到我的帳號」複製一份。
   */
  readOnly?: boolean;
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

const focusableControls = (root: HTMLElement): HTMLElement[] =>
  Array.prototype.slice.call(root.querySelectorAll("button, input, select, textarea"))
    .filter((control: HTMLElement) => !control.matches(":disabled"));

export default function QuizAuthoringDialog({
  quiz,
  sourceCode,
  sourceFile,
  getCursorLine,
  onSave,
  onClose,
  readOnly = false
}: Props) {
  const [draft, setDraft] = React.useState<QuizSpec>(() => cloneQuiz(quiz) || emptyQuiz());
  const [bindingErrors, setBindingErrors] = React.useState<{ [id: string]: string }>({});
  const [containerPickers, setContainerPickers] = React.useState<{ [id: string]: boolean }>({});
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);
  const validation = validateQuiz(draft, sourceCode, sourceFile);

  React.useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    const first = dialogRef.current && focusableControls(dialogRef.current)[0];
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
        question.id === id
          ? update(
              question.kind === "choice"
                ? { ...question, options: question.options.map(o => ({ ...o })) }
                : { ...question, table_spec: { ...question.table_spec } }
            )
          : question
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
    const controls = focusableControls(dialogRef.current);
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
              {readOnly
                ? `別人的教案，只能檢視 · 共 ${draft.questions.length} 題`
                : `把單選題綁到播放時會停下的程式碼行 · ${draft.questions.length}/30 題`}
            </div>
          </div>
          {!readOnly && (
            <button
              type="button"
              className="btn btn-default"
              onClick={() => setDraft(addQuestion(draft))}
              disabled={draft.questions.length >= 30}
            >
              ＋ 新增題目
            </button>
          )}
        </header>

        {/* 用原生的 fieldset[disabled] 一次停用所有子孫控制項，不必逐一加
            disabled——少 17 處手動掛載，也不會有人新增欄位時忘記跟上。 */}
        <fieldset
          disabled={readOnly}
          style={{
            border: 0,
            margin: 0,
            minWidth: 0,
            padding: "20px 22px",
            background: colors.paper
          }}
        >
          {readOnly && (
            <div
              data-testid="quiz-authoring-readonly-notice"
              style={{
                marginBottom: "16px",
                padding: "10px 14px",
                border: `1px solid ${colors.line}`,
                borderLeft: `3px solid ${colors.amber}`,
                background: "#fff",
                fontSize: "13px",
                color: colors.ink
              }}
            >
              這是別人的教案，題目無法修改。要拿來上課或改題，請先按「存到我的帳號」複製一份。
            </div>
          )}
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
            const containerNames = Array.from(
              (((global_variable as any).__latest_containers as Map<string, any> | undefined) || new Map()).keys()
            );
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

                <label style={{ display: "block", marginBottom: "12px" }}>
                  題型
                  <select
                    className="form-control"
                    aria-label={`${prefix}題型`}
                    value={question.kind}
                    onChange={event =>
                      setDraft(changeQuestionKind(draft, question.id, event.target.value as "choice" | "table"))
                    }
                  >
                    <option value="choice">單選題</option>
                    <option value="table">填表題</option>
                  </select>
                </label>

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

                {question.kind === "choice" && (
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
                          updateQuestion(question.id, value =>
                            value.kind === "choice"
                              ? { ...value, correct_option_id: option.id }
                              : value
                          )
                        }
                      />
                      <input
                        className="form-control"
                        aria-label={`${prefix}選項 ${optionIndex + 1}`}
                        value={option.text}
                        onChange={event =>
                          updateQuestion(question.id, value =>
                            value.kind === "choice"
                              ? {
                                  ...value,
                                  options: value.options.map(item =>
                                    item.id === option.id ? { ...item, text: event.target.value } : item
                                  )
                                }
                              : value
                          )
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
                )}

                {question.kind === "table" && (
                  <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
                    <legend style={{ fontSize: "14px", marginBottom: "8px", border: 0 }}>
                      表格設定
                    </legend>
                    <label style={{ display: "block", marginBottom: "8px" }}>
                      變數提示（選填）
                      <input
                        className="form-control"
                        aria-label={`${prefix}變數提示`}
                        maxLength={128}
                        value={question.table_spec.var_hint}
                        onChange={event =>
                          updateQuestion(question.id, value =>
                            value.kind === "table"
                              ? { ...value, table_spec: { ...value.table_spec, var_hint: event.target.value } }
                              : value
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      disabled={containerNames.length === 0}
                      onClick={() =>
                        setContainerPickers({ ...containerPickers, [question.id]: !containerPickers[question.id] })
                      }
                    >
                      從畫面上的容器選擇
                    </button>
                    {containerNames.length === 0 && (
                      <small style={{ display: "block", color: colors.muted, marginTop: "5px" }}>
                        目前沒有容器；可留空，第一次出題時再選擇。
                      </small>
                    )}
                    {containerNames.length > 0 && containerPickers[question.id] && (
                      <select
                        className="form-control"
                        aria-label={`${prefix}畫面上的容器`}
                        value={containerNames.indexOf(question.table_spec.var_hint) >= 0 ? question.table_spec.var_hint : ""}
                        onChange={event =>
                          updateQuestion(question.id, value =>
                            value.kind === "table"
                              ? { ...value, table_spec: { ...value.table_spec, var_hint: event.target.value } }
                              : value
                          )
                        }
                        style={{ marginTop: "8px" }}
                      >
                        <option value="" disabled>選擇容器</option>
                        {containerNames.map(name => <option key={name} value={name}>{name}</option>)}
                      </select>
                    )}
                    <label style={{ display: "block", marginTop: "10px" }}>
                      格數上限
                      <input
                        type="number"
                        className="form-control"
                        aria-label={`${prefix}格數上限`}
                        min={1}
                        max={MAX_CELLS_CEILING}
                        step={1}
                        value={question.table_spec.max_cells}
                        onChange={event =>
                          updateQuestion(question.id, value =>
                            value.kind === "table"
                              ? { ...value, table_spec: { ...value.table_spec, max_cells: Number(event.target.value) } }
                              : value
                          )
                        }
                      />
                    </label>
                  </fieldset>
                )}

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
        </fieldset>

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
            {readOnly ? "關閉" : "取消"}
          </button>
          {!readOnly && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={validation.errors.length > 0}
            >
              儲存題目
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
