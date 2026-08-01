import * as React from "react";
import * as ReactDOM from "react-dom";
import io from "socket.io-client";
import {
  initialStudentState,
  markReconnecting,
  markStudentError,
  markSubmitted,
  reduceStudentState,
  StudentQuizState
} from "./studentQuizState";
import "../css/studentQuiz.css";

type InitialData = { token: string; session_title: string };

async function guestRequest(method: string, path: string, body?: any): Promise<any> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) throw new Error("本次課堂不存在、已結束或連結已失效。");
    if (response.status === 409) throw new Error("目前無法作答，正在重新整理課堂狀態。");
    throw new Error(payload.error || payload.message || "課堂連線失敗，請稍後重試。");
  }
  return payload;
}

const joinSession = (token: string, nickname: string) =>
  guestRequest("POST", "/api/live-quiz/guest/join", { token, nickname });
const getGuestState = () => guestRequest("GET", "/api/live-quiz/guest/state");
const submitAnswer = (questionId: string, optionId: string) =>
  guestRequest("POST", "/api/live-quiz/guest/answers", {
    question_id: questionId,
    option_id: optionId
  });

function statusText(state: StudentQuizState, submitting: boolean): string {
  if (submitting) return "正在送出答案…";
  if (state.reconnecting) {
    return state.status === "open"
      ? "即時連線中斷，仍可透過網頁送出答案。"
      : "連線中斷，正在重新連線…";
  }
  switch (state.status) {
    case "joining": return "輸入暱稱後加入課堂。";
    case "waiting": return "已加入，請等待老師播放到題目。";
    case "open": return "題目已開放，請選擇一個答案。";
    case "answered": return "已收到答案，請等待老師關題。";
    case "closed": return "老師已關題，請查看結果。";
    case "ended": return "本次課堂已結束。";
    case "error": return state.message || "課堂連線失敗。";
  }
}

function StudentQuizApp({ data }: { data: InitialData }) {
  const [state, setState] = React.useState<StudentQuizState>(() =>
    initialStudentState(data.session_title)
  );
  const [nickname, setNickname] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const socketRef = React.useRef<any>(null);

  const applySnapshot = (snapshot: any) => {
    setState(previous => reduceStudentState(previous, snapshot));
    const selectedOption = snapshot && snapshot.active_question?.selected_option_id;
    setSelected(typeof selectedOption === "string" ? selectedOption : null);
  };

  const refresh = () =>
    getGuestState()
      .then(applySnapshot)
      .catch(reason => setState(previous => markStudentError(previous, reason.message)));

  const connectSocket = () => {
    if (socketRef.current) return;
    const socket: any = (io as any).connect("/lesson_quiz", { auth: { role: "student" } });
    socketRef.current = socket;
    socket.on("connect", refresh);
    socket.on("disconnect", () => setState(previous => markReconnecting(previous)));
    socket.on("connect_error", () => setState(previous => markReconnecting(previous)));
    socket.on("quiz:student-state", applySnapshot);
  };

  React.useEffect(() => {
    getGuestState()
      .then(snapshot => {
        applySnapshot(snapshot);
        connectSocket();
      })
      .catch(() => undefined);
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = nickname.trim();
    if (!trimmed || Array.from(trimmed).length > 50) return;
    setSubmitting(true);
    joinSession(data.token, trimmed)
      .then(snapshot => {
        applySnapshot(snapshot);
        connectSocket();
      })
      .catch(reason => setState(previous => markStudentError(previous, reason.message)))
      .then(() => setSubmitting(false));
  };

  const answer = (event: React.FormEvent) => {
    event.preventDefault();
    const question = state.active_question;
    if (!question || !selected || state.status !== "open") return;
    setSubmitting(true);
    setState(previous => markSubmitted(previous, selected));
    submitAnswer(question.id, selected)
      .then(applySnapshot)
      .catch(reason => {
        if (reason.message.indexOf("重新整理") >= 0) refresh();
        else setState(previous => markStudentError(previous, reason.message));
      })
      .then(() => setSubmitting(false));
  };

  const question = state.active_question;
  const result = question && question.result;
  const nicknameLength = Array.from(nickname.trim()).length;

  return (
    <main className="quiz-shell">
      <header className="quiz-header">
        <span className="quiz-eyebrow">LIVE CODE CHECK</span>
        <h1>{state.session_title}</h1>
      </header>

      <section className="quiz-card" aria-live="polite">
        {state.status === "joining" || (state.status === "error" && !state.session_id) ? (
          <form onSubmit={join}>
            <h2>加入課堂</h2>
            <label htmlFor="quiz-nickname">顯示暱稱</label>
            <input
              id="quiz-nickname"
              autoComplete="nickname"
              autoFocus
              value={nickname}
              onChange={event => setNickname(event.target.value)}
              aria-describedby="nickname-help"
            />
            <div id="nickname-help" className={nicknameLength > 50 ? "field-help error" : "field-help"}>
              {nicknameLength}/50 字；只會在本次課堂中顯示。
            </div>
            <button className="primary-action" disabled={submitting || nicknameLength < 1 || nicknameLength > 50}>
              加入課堂
            </button>
            {state.status === "error" && <p className="error-message" role="alert">{state.message}</p>}
          </form>
        ) : state.status === "ended" ? (
          <div className="ended-state">
            <h2>課堂已結束</h2>
            <p>謝謝參與，這個加入連結已失效。</p>
          </div>
        ) : question ? (
          <form onSubmit={answer}>
            <p className="source-ticket">
              <span aria-hidden="true" className="breakpoint-dot" />
              {question.source_file} · line {question.line}
            </p>
            <h2 className="question-prompt">{question.prompt}</h2>
            <fieldset disabled={state.status !== "open" || submitting}>
              <legend className="sr-only">請選擇一個答案</legend>
              {question.options.map(option => {
                const chosen = selected === option.id || state.selected_option_id === option.id;
                const correct = state.status === "closed" && result?.correct_option_id === option.id;
                return (
                  <label
                    key={option.id}
                    className={`answer-option${chosen ? " selected" : ""}${correct ? " correct" : ""}`}
                  >
                    <input
                      type="radio"
                      name="answer"
                      value={option.id}
                      checked={chosen}
                      onChange={() => setSelected(option.id)}
                    />
                    <span>{option.text}</span>
                    {correct && <strong className="answer-mark">正解</strong>}
                  </label>
                );
              })}
            </fieldset>
            {state.status === "open" && (
              <button className="primary-action" disabled={!selected || submitting}>送出答案</button>
            )}
            {state.status === "closed" && result && (
              <div className={`result-box ${result.is_correct ? "is-correct" : "is-wrong"}`}>
                <strong>
                  {result.is_correct === true ? "✓ 答對了" : result.is_correct === false ? "✕ 還差一點" : "— 本題未作答"}
                </strong>
                {result.explanation && <p>{result.explanation}</p>}
              </div>
            )}
          </form>
        ) : (
          <div className="waiting-state" aria-hidden="true">
            <span className="waiting-cursor">▌</span>
          </div>
        )}

        <p className="status-line" role="status" aria-live="polite">
          {statusText(state, submitting)}
        </p>
      </section>
    </main>
  );
}

const data = (window as any).initial_quiz_data as InitialData;
const root = document.getElementById("quiz-app");
if (root && data) ReactDOM.render(<StudentQuizApp data={data} />, root);
