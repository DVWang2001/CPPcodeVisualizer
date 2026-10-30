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

// 老師端離線時沒有任何回覆，所以不能無限等：超過這個時間就當作答案沒送達。
export const ANSWER_ACK_TIMEOUT_MS = 5000;
const DEVICE_KEY = "gdbgui_quiz_device";
const REFUSED_MESSAGE = "課堂不存在或已結束（或加入人數已滿），請向老師索取新的加入連結。";
const CLOSED_NOTICE = "已收卷，這份答案沒有送出（你填的內容已保留）。";

type Device = { device_id: string; nickname: string };

// 規則必須和老師端引擎的 hello 一致（trim 後 1~50 個字元、不含 <32 或 127 的控制字元），
// 否則老師端會靜默丟掉 hello，這個學生就永遠無法作答。
export type NicknameProblem = "empty" | "too_long" | "control" | null;
export function nicknameProblem(raw: string): NicknameProblem {
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length < 1) return "empty";
  if (length > 50) return "too_long";
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) return "control";
  }
  return null;
}

// crypto.randomUUID 只在安全環境（https / localhost）存在；教室用區網 http，手機上
// 通常沒有，所以要有退路。
export function newDeviceId(): string {
  const cryptoObject: any = (window as any).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
    const digit = Math.floor(Math.random() * 16);
    return (char === "x" ? digit : (digit & 0x3) | 0x8).toString(16);
  });
}

function loadDevice(): Device | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICE_KEY) || "null");
    if (parsed && typeof parsed.device_id === "string" && parsed.device_id &&
      typeof parsed.nickname === "string" && nicknameProblem(parsed.nickname) === null) {
      return { device_id: parsed.device_id, nickname: parsed.nickname };
    }
  } catch {
    // 讀不到就當作第一次加入。
  }
  return null;
}

function saveDevice(device: Device): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  } catch {
    // 存不起來只代表重新整理後要再輸入一次暱稱。
  }
}

export function tableResultClass(result: StudentQuizTableResult): "" | "is-correct" | "is-wrong" {
  if (result.correct_cells === null || result.total_cells === null) return "";
  return result.correct_cells === result.total_cells ? "is-correct" : "is-wrong";
}

type Delivery = { phase: "sending" | "failed" };

function statusText(
  state: StudentQuizState,
  delivery: Delivery | null,
  notice: string | null,
  confirming: boolean
): string {
  if (confirming) return "請確認要送出的答案。";
  if (delivery && delivery.phase === "sending") return "正在送出答案…";
  if (delivery && delivery.phase === "failed") return "老師連線中斷，答案未送達。";
  if (notice) return notice;
  if (state.reconnecting) return "連線中斷，正在重新連線…";
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

// 還在等老師確認的那一份答案。nonce 讓「老師的回覆」能對回「這一次送出」。
type InFlight = {
  nonce: string;
  questionKey: string;
  answer: string | string[][];
  phase: "sending" | "failed";
};

// 確認後要套用到畫面的本機資料（選了哪個選項／填了哪張表）。
type LocalAnswer = { optionId?: string; table?: string[][] };

export default function StudentQuizApp({ data }: { data: InitialData }) {
  const deviceRef = React.useRef<Device | null>(null);
  if (deviceRef.current === null) deviceRef.current = loadDevice();
  const [state, setState] = React.useState<StudentQuizState>(() => {
    const initial = initialStudentState(data.session_title);
    // 已經加入過（重新整理）：沿用暱稱，直接進入等待，不再詢問。
    return deviceRef.current
      ? { ...initial, status: "waiting", nickname: deviceRef.current.nickname }
      : initial;
  });
  const [nickname, setNickname] = React.useState(deviceRef.current ? deviceRef.current.nickname : "");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [delivery, setDelivery] = React.useState<Delivery | null>(null);
  // 只對那一題有效：換題後就不再顯示。
  const [noticeState, setNoticeState] = React.useState<{ text: string; questionId: string } | null>(null);
  const [pending, setPending] = React.useState<PendingSubmit | null>(null);
  const socketRef = React.useRef<any>(null);
  const inFlightRef = React.useRef<InFlight | null>(null);
  const localRef = React.useRef<LocalAnswer>({});
  const timerRef = React.useRef<any>(null);
  const submitting = delivery !== null && delivery.phase === "sending";

  const clearInFlight = () => {
    clearTimeout(timerRef.current);
    inFlightRef.current = null;
    setDelivery(null);
  };

  const sendHello = () => {
    const device = deviceRef.current;
    if (socketRef.current && device) {
      socketRef.current.emit("student:hello", { device_id: device.device_id, nickname: device.nickname });
    }
  };

  const transmit = (flight: InFlight, local: LocalAnswer) => {
    const device = deviceRef.current;
    if (!socketRef.current || !device) return;
    clearTimeout(timerRef.current);
    inFlightRef.current = flight;
    localRef.current = local;
    setDelivery({ phase: flight.phase });
    setNoticeState(null);
    timerRef.current = setTimeout(() => {
      if (inFlightRef.current && inFlightRef.current.nonce === flight.nonce) {
        inFlightRef.current = { ...flight, phase: "failed" };
        setDelivery({ phase: "failed" });
      }
    }, ANSWER_ACK_TIMEOUT_MS);
    socketRef.current.emit("student:answer", {
      device_id: device.device_id,
      question_key: flight.questionKey,
      answer: flight.answer,
      nonce: flight.nonce
    });
  };

  const applySnapshot = (snapshot: any) => {
    const flight = inFlightRef.current;
    const incoming = snapshot && snapshot.active_question;
    if (flight && snapshot && snapshot.state !== "ended") {
      // 老師端拒絕答案時不會回 answer-received，只會刷新狀態：題目收卷或換掉了，
      // 這一份就不會再被接受，別讓畫面卡在「送出中」。草稿不動。
      if (!incoming || incoming.id !== flight.questionKey) {
        clearInFlight();
      } else if (incoming.state === "closed") {
        clearInFlight();
        setNoticeState({ text: CLOSED_NOTICE, questionId: flight.questionKey });
      }
    }
    setState(previous => reduceStudentState(previous, snapshot));
    if (snapshot && (snapshot.state === "ended" || snapshot.status === "ended")) {
      clearInFlight();
      setPending(null);
      if (socketRef.current) socketRef.current.disconnect();
    }
  };

  const onAnswerReceived = (message: any) => {
    const flight = inFlightRef.current;
    if (!flight || !message || message.nonce !== flight.nonce) return;
    const local = localRef.current;
    clearInFlight();
    setNoticeState(null);
    setSelected(null);
    setState(previous => markSubmitted(previous, local.optionId, local.table));
    if (local.table) clearDraft(flight.questionKey);
  };

  const connectSocket = () => {
    if (socketRef.current) return;
    const socket: any = (io as any).connect("/lesson_quiz", {
      auth: { role: "student", token: data.token }
    });
    socketRef.current = socket;
    // 每次連上（含斷線重連）都要重新自我介紹，老師端才知道這個裝置是誰。
    socket.on("connect", sendHello);
    socket.on("relay:teacher-online", sendHello);
    socket.on("disconnect", () =>
      setState(previous =>
        previous.status === "ended" || previous.status === "error" ? previous : markReconnecting(previous)
      )
    );
    socket.on("connect_error", (error: any) => {
      // 網路層錯誤會自動重試；其他（token 被伺服器拒絕）重試也沒用，直接停下。
      const transient = error && (error.type === "TransportError" || socket.active === true);
      if (transient) {
        setState(previous => markReconnecting(previous));
      } else {
        clearInFlight();
        setState(previous => markStudentError(previous, REFUSED_MESSAGE));
        socket.disconnect();
      }
    });
    socket.on("quiz:student-state", applySnapshot);
    socket.on("quiz:answer-received", onAnswerReceived);
  };

  React.useEffect(() => {
    if (deviceRef.current) connectSocket();
    return () => {
      clearTimeout(timerRef.current);
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  // 手機切到別的 App、過一段時間再切回來，JS 執行環境常常被系統暫停或從 bfcache
  // 復原；socket 斷線事件不一定會確實觸發。這裡主動在「分頁再次可見」時確認連線：
  // 還連著就重新自我介紹（老師端會回這個學生目前的狀態），斷了就重連。
  const resync = () => {
    const socket = socketRef.current;
    if (!socket) return;
    if (socket.connected) sendHello();
    else socket.connect();
  };

  React.useEffect(() => {
    if (state.status === "joining" || state.status === "ended" || state.status === "error") return;
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
    if (nicknameProblem(trimmed) !== null) return;
    const device = {
      device_id: deviceRef.current ? deviceRef.current.device_id : newDeviceId(),
      nickname: trimmed
    };
    deviceRef.current = device;
    saveDevice(device);
    // 從錯誤畫面重新加入：丟掉舊的 socket（它可能已經被拒絕），用同一個身分重連。
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setState(previous => ({
      ...initialStudentState(previous.session_title),
      status: "waiting",
      nickname: trimmed
    }));
    connectSocket();
  };

  // 連線失敗時，與其卡在一個沒有出路的錯誤畫面，不如讓學生直接重新加入。
  const rejoin = () => setState(previous => initialStudentState(previous.session_title));

  const currentSelection = selected !== null ? selected : state.selected_option_id;

  const requestChoiceSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const question = state.active_question;
    if (!question || question.kind !== "choice" || !currentSelection || question.state !== "open") return;
    setPending({ kind: "choice", optionId: currentSelection });
  };

  const requestTableSubmit = (values: string[][]) => {
    const question = state.active_question;
    if (!question || question.kind !== "table" || question.state !== "open") return;
    setPending({ kind: "table", values });
  };

  const cancelPending = () => setPending(null);

  const confirmPending = () => {
    const question = state.active_question;
    if (pending && question && pending.kind === "choice" && question.kind === "choice") {
      transmit(
        { nonce: newDeviceId(), questionKey: question.id, answer: pending.optionId, phase: "sending" },
        { optionId: pending.optionId }
      );
    } else if (pending && question && pending.kind === "table" && question.kind === "table") {
      transmit(
        { nonce: newDeviceId(), questionKey: question.id, answer: pending.values, phase: "sending" },
        { table: pending.values }
      );
    }
    setPending(null);
  };

  // 逾時之後原樣重送同一份答案，但要用新的 nonce（老師端對同一裝置的重送是冪等的）。
  const resend = () => {
    const flight = inFlightRef.current;
    if (!flight || flight.phase !== "failed") return;
    transmit({ ...flight, nonce: newDeviceId(), phase: "sending" }, localRef.current);
  };

  const question = state.active_question;
  // 老師端其實已記錄這份答案（只是回執遺失）：個人狀態帶著答案，就不顯示「沒有送出」。
  const counted = !!question && (question.kind === "table" ? question.answer !== null : state.selected_option_id !== null);
  const notice = noticeState && question && question.id === noticeState.questionId && !counted ? noticeState.text : null;

  // 老師換題了：任何還沒確認送出的舊題目答案都作廢，不要讓確認列繼續掛著。
  React.useEffect(() => {
    setPending(null);
    setSelected(null);
  }, [question?.id]);

  const nicknameLength = Array.from(nickname.trim()).length;
  const problem = nicknameProblem(nickname);
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
            <div id="nickname-help" className={problem === "too_long" || problem === "control" ? "field-help error" : "field-help"}>
              {nicknameLength}/50 字；只會在本次課堂中顯示。{problem === "control" && "暱稱不可含控制字元（如 Tab）。"}
            </div>
            <button className="primary-action" disabled={submitting || problem !== null}>
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
            <button type="button" className="primary-action" onClick={resync}>重新連線</button>
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
                        const chosen = currentSelection === option.id;
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
                      <button className="primary-action" disabled={!currentSelection || submitting}>
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

        {delivery && delivery.phase === "failed" && (
          <div className="confirm-actions">
            <button type="button" className="primary-action" onClick={resend}>重送答案</button>
          </div>
        )}

        <p className="status-line" role="status" aria-live="polite">
          {statusText(state, delivery, notice, pending !== null)}
        </p>
      </section>
    </main>
  );
}

const initialData = (window as any).initial_quiz_data as InitialData;
const root = document.getElementById("quiz-app");
if (root && initialData) ReactDOM.render(<StudentQuizApp data={initialData} />, root);
