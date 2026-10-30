import io from "socket.io-client";
import { createEngine, LiveQuizEngine } from "./liveQuizEngine";
import { LiveQuizSession } from "./lessonQuizRuntime";
import { CapturedTable } from "./tableFromContainer";

/**
 * 老師端的課堂 client。計分、狀態機、名單都在瀏覽器（liveQuizEngine）；
 * 伺服器只剩三件事：開場（POST /sessions）、中繼（Socket.IO /lesson_quiz）、
 * 收場（POST /end，上傳匿名聚合）。事件契約見 live_quiz.py 的 `relay:` 區段。
 *
 * 狀態只放在這個模組的記憶體裡（D4）：不寫 localStorage/sessionStorage，
 * 重新整理 = 結束課堂。
 */

export type LiveQuizStats = {
  joined_count: number;
  question_id: string;
  state: string;
  answer_count: number;
  correct_count: number;
  option_counts?: { [optionId: string]: number };
  cell_stats?: number[];
};

export type StudentTableResponse = {
  nickname: string;
  answer: string[][] | null;
  correct_cells: number;
  total_cells: number;
};

type Handlers = {
  onState: (session: LiveQuizSession) => void;
  onStats: (stats: LiveQuizStats) => void;
  onConnection: (connected: boolean) => void;
};

function csrfToken(): string {
  return (window as any).initial_data?.csrf_token || "";
}

async function request(
  method: string,
  path: string,
  body?: { [key: string]: any }
): Promise<any> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": csrfToken()
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(payload.error || payload.message || "課堂連線失敗。");
    error.status = response.status;
    throw error;
  }
  return payload;
}

// ---- 模組層級的單一課堂 ----

let engine: LiveQuizEngine | null = null;
/** 伺服器回的開場 payload：引擎的 teacherSession 不含 join_url/qr_url 等欄位，要疊回去。 */
let seed: LiveQuizSession | null = null;
let socket: any = null;
let handlers: Handlers | null = null;
let ended = false;
/** sid 對應的 device_id：只來自伺服器釘住的 roster 或該 sid 自己送的 hello。全部用 Map，鍵是學生給的字串。 */
const deviceBySid = new Map<string, string>();
const connectedSids = new Set<string>();

/** 引擎丟的是 {status, message}；轉成與舊 request() 同形的 Error，面板的錯誤處理不必改。 */
function surface(error: any): never {
  if (error && typeof error.status === "number" && typeof error.message === "string") {
    const out: any = new Error(error.message);
    out.status = error.status;
    throw out;
  }
  throw error;
}

function guard<T>(sessionId: number, run: (engine: LiveQuizEngine) => T): T {
  if (!engine || !seed || seed.id !== sessionId) {
    const error: any = new Error("找不到課堂。");
    error.status = 404;
    throw error;
  }
  try {
    return run(engine);
  } catch (error) {
    return surface(error);
  }
}

const view = (current: LiveQuizEngine): LiveQuizSession => ({ ...seed!, ...current.teacherSession() });

function notify() {
  if (!engine || !handlers) return;
  handlers.onState(view(engine));
  const stats = engine.stats();
  if (stats) handlers.onStats(stats);
}

function sendToStudents(payload: any) {
  if (socket) socket.emit("relay:to-students", { payload });
}

function sendToStudent(sid: string, event: string, payload: any) {
  if (socket) socket.emit("relay:to-student", { sid, event, payload });
}

/**
 * 全體廣播用的題目：只有題面，沒有任何統計或個人作答。
 * 收卷前不含正解與解說；收卷後才附上（那是全班共通的，個人成績另外逐人補發）。
 */
function publicQuestion(question: any) {
  const out: { [key: string]: any } = {
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    test_input: question.test_input,
    state: question.state,
    source_file: question.source_file,
    line: question.line
  };
  const closed = question.state === "closed";
  if (question.kind === "table") {
    for (const key of ["rows", "cols", "row_labels", "col_labels"]) {
      if (question[key] !== undefined) out[key] = question[key];
    }
    if (closed) {
      if (question.correct_values !== undefined) out.correct_values = question.correct_values;
      out.result = { explanation: question.explanation };
    }
  } else {
    out.options = question.options;
    if (closed) out.result = { correct_option_id: question.correct_option_id, explanation: question.explanation };
  }
  return out;
}

function broadcastQuestion(questionId: string) {
  if (!engine) return;
  const question = engine.teacherSession().questions.find(q => q.id === questionId);
  if (!question) return;
  sendToStudents({
    state: "active",
    session_id: seed!.id,
    session_title: seed!.title,
    active_question: publicQuestion(question)
  });
}

/** 把某位學生目前的個人狀態送給他（重連、hello、收卷）。沒登記過的裝置沒有狀態可送。 */
function sendStudentState(sid: string, deviceId: string | undefined) {
  if (!engine || deviceId === undefined) return;
  const state = engine.studentState(deviceId);
  if (state) sendToStudent(sid, "quiz:student-state", state);
}

const isObject = (value: any): value is { [key: string]: any } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ---- 中繼事件：只信信封上的 sid，內容一律來自 msg.data ----

function onStudentHello(msg: any) {
  if (!engine || ended || !isObject(msg) || typeof msg.sid !== "string" || !isObject(msg.data)) return;
  const sid: string = msg.sid;
  const { device_id: deviceId, nickname } = msg.data;
  if (typeof deviceId !== "string" || !deviceId) return;
  try {
    engine.hello(deviceId, nickname);
  } catch (_) {
    return; // 暱稱不合法：丟棄，學生端會停在等待狀態
  }
  deviceBySid.set(sid, deviceId);
  connectedSids.add(sid);
  sendStudentState(sid, deviceId);
  notify();
}

function onStudentAnswer(msg: any) {
  if (!engine || ended || !isObject(msg) || typeof msg.sid !== "string" || !isObject(msg.data)) return;
  const sid: string = msg.sid;
  const { device_id: deviceId, question_key: questionKey, answer, nonce } = msg.data;
  if (typeof deviceId !== "string" || !deviceId) return;
  const known = deviceBySid.get(sid);
  if (known !== undefined && known !== deviceId) return;
  try {
    if (Array.isArray(answer)) engine.answerTable(deviceId, questionKey, answer);
    else if (typeof answer === "string") engine.answerChoice(deviceId, questionKey, answer);
    else return;
  } catch (_) {
    // 被引擎拒絕（已收卷、題型不符…）：不回「已收到」，只讓這位學生回到正確的狀態。
    sendStudentState(sid, deviceId);
    return;
  }
  deviceBySid.set(sid, deviceId);
  if (typeof nonce === "string" || typeof nonce === "number") {
    sendToStudent(sid, "quiz:answer-received", { nonce });
  }
  notify(); // 只更新老師自己的畫面；不對全體廣播
}

function onPresence(msg: any) {
  if (!isObject(msg) || typeof msg.sid !== "string" || typeof msg.connected !== "boolean") return;
  if (msg.connected) {
    connectedSids.add(msg.sid);
    if (!ended) sendStudentState(msg.sid, deviceBySid.get(msg.sid));
  } else {
    connectedSids.delete(msg.sid);
    deviceBySid.delete(msg.sid);
  }
  notify();
}

function onRoster(msg: any) {
  if (!isObject(msg) || !Array.isArray(msg.students)) return;
  connectedSids.clear();
  for (const entry of msg.students) {
    if (!isObject(entry) || typeof entry.sid !== "string") continue;
    connectedSids.add(entry.sid);
    if (typeof entry.device_id === "string" && entry.device_id) deviceBySid.set(entry.sid, entry.device_id);
  }
  notify();
}

// ---- 對外 API（名稱與簽章沿用舊版）----

export const createLiveSession = async (lessonId: number): Promise<LiveQuizSession> => {
  const created: LiveQuizSession = await request("POST", "/api/live-quiz/sessions", { lesson_id: lessonId });
  engine = createEngine(created);
  seed = created;
  ended = false;
  deviceBySid.clear();
  connectedSids.clear();
  return created;
};

export const triggerLiveQuestion = async (
  sessionId: number,
  questionId: string,
  sourceFile: string,
  line: number,
  capture?: { table: CapturedTable; var_hint: string },
  testInput?: string
): Promise<LiveQuizSession> => {
  const updated = guard(sessionId, current => {
    current.trigger(questionId, sourceFile, line, capture, testInput);
    return view(current);
  });
  broadcastQuestion(questionId);
  notify();
  return updated;
};

export const closeLiveQuestion = async (
  sessionId: number,
  questionId: string
): Promise<LiveQuizSession> => {
  const updated = guard(sessionId, current => {
    current.close(questionId);
    return view(current);
  });
  broadcastQuestion(questionId);
  // 個人成績不能放進廣播，逐一補發給目前連線、且登記過裝置的學生。
  connectedSids.forEach(sid => sendStudentState(sid, deviceBySid.get(sid)));
  notify();
  return updated;
};

/** 收卷後的個別作答。只有填表題、只有 closed 之後才拿得到（引擎擋）。 */
export const fetchQuestionResponses = async (
  sessionId: number,
  questionId: string
): Promise<{ responses: StudentTableResponse[] }> =>
  guard(sessionId, current => current.responses(questionId));

/**
 * 逐筆作答的匯出。結束課堂後伺服器不會有這些資料（本來就沒存），所以由瀏覽器內的
 * 引擎產生 JSON 直接下載；這是研究資料唯一的出口。
 */
export function downloadLiveSessionExport(): void {
  if (!engine) return;
  const payload = engine.exportSession() as any;
  const day = String(payload.exported_at || "").slice(0, 10);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `live-quiz-${seed ? seed.id : 0}-${day}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 收場：把引擎的匿名聚合一次上傳。任何原因失敗（400、500、斷網）都用空 body 重試一次，
 * 空 body = 不上傳，確保場次一定會結束；hint_saved:false 是正常結果，不是錯誤。
 */
export const endLiveSession = async (sessionId: number): Promise<LiveQuizSession> => {
  const path = `/api/live-quiz/sessions/${sessionId}/end`;
  const summary = guard(sessionId, current => current.endedSummary());
  let result: LiveQuizSession;
  try {
    result = await request("POST", path, summary);
  } catch (_) {
    result = await request("POST", path);
  }
  ended = true;
  return result;
};

export function connectTeacherQuizSocket(sessionId: number, callbacks: Handlers): () => void {
  handlers = callbacks;
  const current: any = (io as any).connect("/lesson_quiz", {
    auth: { role: "teacher", session_id: sessionId }
  });
  socket = current;
  current.on("connect", () => callbacks.onConnection(true));
  current.on("disconnect", () => callbacks.onConnection(false));
  current.on("connect_error", () => callbacks.onConnection(false));
  current.on("relay:student-hello", onStudentHello);
  current.on("relay:student-answer", onStudentAnswer);
  current.on("relay:presence", onPresence);
  current.on("relay:roster", onRoster);
  return () => {
    current.disconnect();
    if (socket === current) {
      socket = null;
      handlers = null;
    }
  };
}
