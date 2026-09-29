import * as React from "react";
import * as ReactDOM from "react-dom";
import io from "socket.io-client";
import TableAnswerGrid from "./TableAnswerGrid";
import ScratchCanvas from "./ScratchCanvas";
import {
  initialStudentState,
  markReconnecting,
  markStudentError,
  markSubmitted,
  reduceStudentState,
  StudentQuizQuestion,
  StudentQuizState,
  StudentQuizTableResult
} from "./studentQuizState";
import { clearDraft } from "./tableDraft";
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
    const message = response.status === 404
      ? "本次課堂不存在、已結束或連結已失效。"
      : response.status === 409
        ? "目前無法作答，正在重新整理課堂狀態。"
        : payload.error || payload.message || "課堂連線失敗，請稍後重試。";
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

const joinSession = (token: string, nickname: string) =>
  guestRequest("POST", "/api/live-quiz/guest/join", { token, nickname });
const getGuestState = () => guestRequest("GET", "/api/live-quiz/guest/state");
const submitChoiceAnswer = (questionId: string, optionId: string) =>
  guestRequest("POST", "/api/live-quiz/guest/answers", {
    question_id: questionId,
    option_id: optionId
  });

export async function submitTableAnswer(
  questionId: string,
  answer: string[][],
  applySnapshot: (snapshot: any) => void,
  refresh?: () => Promise<any>
): Promise<void> {
  let snapshot: any;
  try {
    snapshot = await guestRequest("POST", "/api/live-quiz/guest/answers", {
      question_id: questionId,
      answer
    });
  } catch (reason) {
    if ((reason as any).status === 409 && refresh) {
      await refresh();
      return;
    }
    throw reason;
  }
  applySnapshot(snapshot);
  clearDraft(questionId);
}

export function tableResultClass(result: StudentQuizTableResult): "" | "is-correct" | "is-wrong" {
  if (result.correct_cells === null || result.total_cells === null) return "";
  return result.correct_cells === result.total_cells ? "is-correct" : "is-wrong";
}

function statusText(state: StudentQuizState, submitting: boolean, confirming: boolean): string {
  if (confirming) return "請確認要送出的答案。";
  if (submitting) return "正在送出答案…";
  if (state.reconnecting) {
    return state.status === "open"
      ? "即時連線中斷，仍可透過網頁送出答案。"
      : "連線中斷，正在重新連線…";
  }
  switch (state.status) {
    case "joining": return "輸入暱稱後加入課堂。";
    case "waiting": return "已加入，請等待老師播放到題目。";
    case "open": return state.active_question && state.active_question.kind === "table"
      ? "題目已開放，請填完表格後送出。"
      : "題目已開放，請選擇一個答案。";
    case "answered": return "已收到答案，關題前仍可修改。";
    case "closed": return "老師已關題，請查看結果。";
    case "ended": return "本次課堂已結束。";
    case "error": return state.message || "課堂連線失敗。";
  }
}

type PendingSubmit =
  | { kind: "choice"; optionId: string }
  | { kind: "table"; values: string[][] };

function StudentQuizApp({ data }: { data: InitialData }) {
  const [state, setState] = React.useState<StudentQuizState>(() =>
    initialStudentState(data.session_title)
  );
  const [nickname, setNickname] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [pending, setPending] = React.useState<PendingSubmit | null>(null);
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

  // 手機切到別的 App、過一段時間再切回來，JS 執行環境常常被系統暫停或從 bfcache
  // 復原；socket 斷線事件不一定會確實觸發。這裡主動在「分頁再次可見」時重新拉一次
  // 課堂狀態，避免畫面停在切走前那一刻不動。已加入之後才需要這個（加入前/已結束
  // 不必浪費一次請求）。
  React.useEffect(() => {
    if (state.status === "joining" || state.status === "ended") return;
    const resync = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", resync);
      window.removeEventListener("focus", resync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

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

  // 找不到參與者／連線失敗時，與其卡在一個沒有出路的錯誤畫面，不如讓學生直接重新
  // 加入——伺服器的 join 本來就會在舊身分失效時自動核發新的。
  const rejoin = () => setState(previous => initialStudentState(previous.session_title));

  const requestChoiceSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const question = state.active_question;
    if (!question || question.kind !== "choice" || !selected || question.state !== "open") return;
    setPending({ kind: "choice", optionId: selected });
  };

  const requestTableSubmit = (values: string[][]) => {
    const question = state.active_question;
    if (!question || question.kind !== "table" || question.state !== "open") return;
    setPending({ kind: "table", values });
  };

  const cancelPending = () => setPending(null);

  const confirmPending = () => {
    const question = state.active_question;
    if (!pending || !question) {
      setPending(null);
      return;
    }
    setSubmitting(true);
    if (pending.kind === "choice" && question.kind === "choice") {
      setState(previous => markSubmitted(previous, pending.optionId));
      submitChoiceAnswer(question.id, pending.optionId)
        .then(applySnapshot)
        .catch(reason => {
          if (reason.status === 409) return refresh();
          else setState(previous => markStudentError(previous, reason.message));
        })
        .then(() => {
          setSubmitting(false);
          setPending(null);
        });
    } else if (pending.kind === "table" && question.kind === "table") {
      setState(previous => markSubmitted(previous));
      submitTableAnswer(question.id, pending.values, applySnapshot, refresh)
        .catch(reason => setState(previous => markStudentError(previous, reason.message)))
        .then(() => {
          setSubmitting(false);
          setPending(null);
        });
    } else {
      setSubmitting(false);
      setPending(null);
    }
  };

  const question = state.active_question;

  // 老師換題了：任何還沒確認送出的舊題目答案都作廢，不要讓確認列繼續掛著。
  React.useEffect(() => {
    setPending(null);
  }, [question?.id]);

  const nicknameLength = Array.from(nickname.trim()).length;
  // 分頁而不是並排：手機直向的可視高度放不下「題幹＋作答＋一個夠大的畫布」，
  // 硬擠會讓兩邊都不好用。
  const [tab, setTab] = React.useState<"answer" | "canvas">("answer");
  const [miniCanvas, setMiniCanvas] = React.useState(false);
  const [testInputPinned, setTestInputPinned] = React.useState(true);

  const locked = (question: StudentQuizQuestion) =>
    question.state !== "open" || submitting || pending !== null;

  return (
    <main className="quiz-shell">
      <header className="quiz-header">
        <span className="quiz-eyebrow">LIVE CODE CHECK</span>
        <h1>{state.session_title}</h1>
      </header>

      {question && question.test_input && state.status === "closed" ? (
        <div
          className={`test-input-pin${testInputPinned ? " open" : ""}`}
          onClick={() => setTestInputPinned(previous => !previous)}
          role="button"
          tabIndex={0}
          aria-expanded={testInputPinned}
        >
          <div className="test-input-header">
            <span className="test-input-icon">📋</span>
            <span className="test-input-title">題目測資</span>
          </div>
          {testInputPinned && <pre className="test-input-body">{question.test_input}</pre>}
        </div>
      ) : null}

      <section className="quiz-card" aria-live="polite">
        {state.status === "joining" ? (
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
          </form>
        ) : state.status === "ended" ? (
          <div className="ended-state">
            <h2>課堂已結束</h2>
            <p>謝謝參與，這個加入連結已失效。</p>
          </div>
        ) : state.status === "error" ? (
          <div className="error-state">
            <h2>連線發生問題</h2>
            <p className="error-message" role="alert">{state.message || "課堂連線失敗。"}</p>
            <button type="button" className="primary-action" onClick={() => refresh()}>重新連線</button>
            <button type="button" className="secondary-action" onClick={rejoin}>重新加入課堂</button>
          </div>
        ) : question ? (
          <div>
            <p className="source-ticket">
              <span aria-hidden="true" className="breakpoint-dot" />
              {question.source_file} · line {question.line}
            </p>
            <h2 className="question-prompt">{question.prompt}</h2>
            {question.test_input && state.status !== "closed" ? (
              <div className="test-input-card">
                <div className="test-input-header">
                  <span className="test-input-icon">📋</span>
                  <span className="test-input-title">題目測資 (Standard Input)</span>
                </div>
                <pre className="test-input-body">{question.test_input}</pre>
              </div>
            ) : null}

            <div className="scratch-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "answer"}
                className={tab === "answer" ? "on" : ""} onClick={() => setTab("answer")}>作答</button>
              <button type="button" role="tab" aria-selected={tab === "canvas"}
                className={tab === "canvas" ? "on" : ""} onClick={() => setTab("canvas")}>畫布</button>
              {tab === "answer" && (
                <label className="scratch-toggle">
                  <input type="checkbox" checked={miniCanvas}
                    onChange={event => setMiniCanvas(event.target.checked)} />
                  顯示畫布
                </label>
              )}
            </div>

            {tab === "canvas" ? (
              <ScratchCanvas questionKey={question.id} />
            ) : (
              <div className="table-with-scratch">
                {/* 唯讀縮圖：作答時瞄一眼自己畫的東西。不能在上面畫，避免打字/點選時誤觸。
                    放右上是唯一不擋到作答的角落。縮圖是 absolute，這層 div 是它的定位基準。 */}
                {miniCanvas && (
                  <ScratchCanvas questionKey={question.id} readOnly onTap={() => setTab("canvas")} />
                )}

                {question.kind === "choice" ? (
                  <form onSubmit={requestChoiceSubmit}>
                    <fieldset disabled={locked(question)}>
                      <legend className="sr-only">請選擇一個答案</legend>
                      {question.options.map(option => {
                        const chosen = selected === option.id || state.selected_option_id === option.id;
                        const correct = state.status === "closed" && question.result?.correct_option_id === option.id;
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
                    {question.state === "open" && !pending && (
                      <button className="primary-action" disabled={!selected || submitting}>
                        {state.status === "answered" ? "更新答案" : "送出答案"}
                      </button>
                    )}
                    {state.status === "closed" && question.result && (
                      <div className={`result-box ${question.result.is_correct ? "is-correct" : "is-wrong"}`}>
                        <strong>
                          {question.result.is_correct === true
                            ? "✓ 答對了"
                            : question.result.is_correct === false
                              ? "✕ 還差一點"
                              : "— 本題未作答"}
                        </strong>
                        {question.result.explanation && <p>{question.result.explanation}</p>}
                      </div>
                    )}
                  </form>
                ) : (
                  <>
                    <TableAnswerGrid
                      key={question.id}
                      question={question}
                      onSubmit={requestTableSubmit}
                      submitted={locked(question)}
                    />
                    {state.status === "closed" && question.result && (
                      <div className={["result-box", tableResultClass(question.result)].filter(Boolean).join(" ")}>
                        <strong>
                          {question.result.correct_cells === null
                            ? "— 本題未作答"
                            : `${question.result.correct_cells}/${question.result.total_cells} 格正確`}
                        </strong>
                        {question.result.explanation && <p>{question.result.explanation}</p>}
                      </div>
                    )}
                  </>
                )}

                {pending && (
                  <div className="confirm-bar" role="alertdialog" aria-label="確認送出答案">
                    <p>
                      {state.status === "answered" ? "確定要用新的答案覆蓋掉原本送出的答案嗎？" : "確定送出這個答案嗎？"}
                      在老師關題前都還可以再修改。
                    </p>
                    <div className="confirm-actions">
                      <button type="button" className="primary-action" onClick={confirmPending} disabled={submitting}>
                        確認送出
                      </button>
                      <button type="button" className="secondary-action" onClick={cancelPending} disabled={submitting}>
                        再想想
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="waiting-state" aria-hidden="true">
            <span className="waiting-cursor">▌</span>
          </div>
        )}

        <p className="status-line" role="status" aria-live="polite">
          {statusText(state, submitting, pending !== null)}
        </p>
      </section>
    </main>
  );
}

const data = (window as any).initial_quiz_data as InitialData;
const root = document.getElementById("quiz-app");
if (root && data) ReactDOM.render(<StudentQuizApp data={data} />, root);
