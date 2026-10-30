/**
 * 老師端的課堂測驗引擎：把原本伺服器（live_quiz.py）上的計分搬進瀏覽器。
 * 純函式式閉包，不碰網路、不碰 storage；回傳的 payload 形狀與伺服器一致，
 * 讓既有面板與學生頁不必知道計分已經換地方。
 *
 * 目前只實作單選題；填表題（kind === "table"）由後續工作補上。
 */
import type { LiveQuizSession } from "./lessonQuizRuntime";
import type { LiveQuizStats } from "./liveQuizClient";
import type { CapturedTable } from "./tableFromContainer";

export type EngineError = { status: 400 | 404 | 409; message: string };

export type StudentState = {
  participant_id: string;
  session_id: number;
  session_title: string;
  nickname: string;
  state: "active";
  active_question: any;
};

export type EndUpload = {
  questions: Array<{
    question_key: string;
    opened_at: string | null;
    closed_at: string | null;
    answer_count: number;
    correct_count: number;
    option_counts?: { [id: string]: number };
    cell_stats?: number[];
    var_hint?: string;
  }>;
};

export type LiveQuizEngine = {
  hello(deviceId: string, nickname: string): { isNew: boolean };
  trigger(
    questionId: string,
    sourceFile: string,
    line: number,
    capture?: { table: CapturedTable; var_hint: string },
    testInput?: string
  ): LiveQuizSession;
  close(questionId: string): LiveQuizSession;
  answerChoice(deviceId: string, questionId: string, optionId: string): StudentState;
  teacherSession(): LiveQuizSession;
  stats(): LiveQuizStats | null;
  studentState(deviceId: string): StudentState | null;
  endedSummary(): EndUpload;
};

const MAX_NICKNAME_LENGTH = 50;

type Option = { id: string; text: string; [key: string]: any };
type Question = {
  id: string;
  kind: string;
  prompt: string;
  test_input: string | null;
  explanation: string;
  source_file: string;
  line: number;
  anchor: any;
  position: number;
  state: string;
  opened_at: string | null;
  closed_at: string | null;
  answer_count: number;
  correct_count: number;
  options: Option[];
  correct_option_id: string;
  option_counts: { [id: string]: number };
};
type Participant = { nickname: string };
type Response = { selected: string; isCorrect: boolean };

function reject(status: 400 | 404 | 409, message: string): never {
  const error: EngineError = { status, message };
  throw error;
}

function basename(path: any): string {
  return typeof path === "string" ? path.replace(/\\/g, "/").split("/").pop() || "" : "";
}

/** 照抄 live_quiz._same_file：Windows 風格路徑只比檔名且不分大小寫。 */
function sameFile(left: any, right: any): boolean {
  const leftName = basename(left);
  const rightName = basename(right);
  if (!leftName || !rightName) return false;
  const windowsLike = (p: string) => p.indexOf("\\") >= 0 || /^[A-Za-z]:[\\/]/.test(p);
  if (windowsLike(left) || windowsLike(right)) {
    return leftName.toLowerCase() === rightName.toLowerCase();
  }
  return leftName === rightName;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function createEngine(
  session: LiveQuizSession,
  now: () => string = () => new Date().toISOString()
): LiveQuizEngine {
  const questions: Question[] = session.questions.map(raw => {
    const q = clone(raw) as any;
    const counts: { [id: string]: number } = {};
    for (const option of q.options || []) counts[option.id] = 0;
    return {
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      test_input: typeof q.test_input === "string" ? q.test_input : null,
      explanation: q.explanation,
      source_file: q.source_file,
      line: q.line,
      anchor: q.anchor,
      position: q.position,
      state: "ready",
      opened_at: null,
      closed_at: null,
      answer_count: 0,
      correct_count: 0,
      options: q.options,
      correct_option_id: q.correct_option_id,
      option_counts: counts
    };
  });
  const participants = new Map<string, Participant>();
  const responses = new Map<string, Map<string, Response>>();

  const findQuestion = (id: string): Question | undefined => questions.find(q => q.id === id);
  const openQuestion = (): Question | undefined => questions.find(q => q.state === "open");

  // _question_payload：選擇題的欄位與順序
  function questionPayload(q: Question) {
    return {
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      test_input: q.test_input,
      explanation: q.explanation,
      source_file: q.source_file,
      line: q.line,
      anchor: clone(q.anchor),
      position: q.position,
      state: q.state,
      opened_at: q.opened_at,
      closed_at: q.closed_at,
      answer_count: q.answer_count,
      correct_count: q.correct_count,
      options: clone(q.options),
      correct_option_id: q.correct_option_id,
      option_counts: { ...q.option_counts }
    };
  }

  function teacherSession(): LiveQuizSession {
    const payloads = questions.map(questionPayload);
    return {
      id: session.id,
      lesson_id: session.lesson_id,
      lesson_version_id: session.lesson_version_id,
      lesson_version: session.lesson_version,
      owner_id: session.owner_id,
      title: session.title,
      state: session.state,
      created_at: session.created_at,
      ended_at: session.ended_at,
      joined_count: participants.size,
      active_question: payloads.find(p => p.state === "open") || null,
      questions: payloads
    };
  }

  // student_question_payload + guest_state 對選擇題的處理：正解與解析只在 closed 之後出現。
  function studentQuestion(q: Question, response: Response | undefined) {
    const closed = q.state === "closed";
    const payload: { [key: string]: any } = {
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      test_input: q.test_input,
      state: q.state,
      source_file: q.source_file,
      line: q.line,
      options: clone(q.options),
      selected_option_id: response ? response.selected : null
    };
    if (closed) {
      payload.result = {
        is_correct: response ? response.isCorrect : null,
        correct_option_id: q.correct_option_id,
        explanation: q.explanation
      };
    }
    return payload;
  }

  function studentState(deviceId: string): StudentState | null {
    const participant = participants.get(deviceId);
    if (!participant) return null;
    // open 優先，否則取 opened_at 最新的 closed 題（時間相同則取較晚開的）
    let chosen: Question | null = null;
    questions.forEach((q, index) => {
      if ((q.state !== "open" && q.state !== "closed") || q.opened_at === null) return;
      if (chosen === null) {
        chosen = q;
        return;
      }
      const chosenRank = chosen.state === "open" ? 0 : 1;
      const rank = q.state === "open" ? 0 : 1;
      if (rank < chosenRank || (rank === chosenRank && q.opened_at! >= chosen.opened_at!)) {
        chosen = q;
      }
    });
    const active = chosen as Question | null;
    const response = active ? (responses.get(active.id) || new Map()).get(deviceId) : undefined;
    return {
      participant_id: deviceId,
      session_id: session.id,
      session_title: session.title,
      nickname: participant.nickname,
      state: "active",
      active_question: active ? studentQuestion(active, response) : null
    };
  }

  return {
    hello(deviceId, nickname) {
      if (typeof nickname !== "string") reject(400, "暱稱必須是文字。");
      const name = nickname.trim();
      if (name.length < 1 || name.length > MAX_NICKNAME_LENGTH) reject(400, "暱稱長度不正確。");
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 32 || code === 127) reject(400, "暱稱不可含控制字元。");
      }
      if (participants.has(deviceId)) return { isNew: false };
      participants.set(deviceId, { nickname: name });
      return { isNew: true };
    },

    trigger(questionId, sourceFile, line, capture, testInput) {
      if (typeof questionId !== "string" || !questionId) reject(400, "缺少題目 ID。");
      const q = findQuestion(questionId);
      if (!q) reject(404, "找不到題目。");
      if (!Number.isInteger(line) || line !== q.line || !sameFile(q.source_file, sourceFile)) {
        reject(400, "觸發位置與題目錨點不符。");
      }
      if (q.state === "ready") {
        const other = questions.find(x => x.state === "open" && x.id !== q.id);
        if (other) reject(409, "上一題尚未結束作答。");
        if (q.kind !== "choice") reject(400, "尚未支援此題型。");
        q.state = "open";
        q.opened_at = now();
      }
      if (typeof testInput === "string") q.test_input = testInput;
      return teacherSession();
    },

    close(questionId) {
      const q = findQuestion(questionId);
      if (!q) reject(404, "找不到題目。");
      if (q.state === "ready") reject(409, "題目尚未開放。");
      if (q.state === "open") {
        q.state = "closed";
        q.closed_at = now();
      }
      return teacherSession();
    },

    answerChoice(deviceId, questionId, optionId) {
      if (typeof questionId !== "string" || !questionId) reject(400, "缺少題目 ID。");
      if (typeof optionId !== "string" || !optionId) reject(400, "缺少答案選項。");
      const q = findQuestion(questionId);
      if (!q) reject(404, "找不到題目。");
      if (!participants.has(deviceId)) reject(409, "找不到可作答的題目。");
      if (q.kind !== "choice") reject(400, "作答格式與題型不符。");
      let byDevice = responses.get(q.id);
      if (!byDevice) {
        byDevice = new Map();
        responses.set(q.id, byDevice);
      }
      const existing = byDevice.get(deviceId);
      if (q.state !== "open") {
        // 關題後已作答的人永遠拿到舊答案；沒作答的人不能補答。
        if (existing) return studentState(deviceId)!;
        reject(409, "這一題目前未開放作答。");
      }
      if (!q.options.some(option => option.id === optionId)) reject(400, "答案選項不存在。");
      const isCorrect = optionId === q.correct_option_id;
      if (existing) {
        // 還開著可改答案：扣舊、加新，answer_count 不變
        if (Object.prototype.hasOwnProperty.call(q.option_counts, existing.selected)) {
          q.option_counts[existing.selected] = Math.max(0, q.option_counts[existing.selected] - 1);
        }
        q.correct_count += (isCorrect ? 1 : 0) - (existing.isCorrect ? 1 : 0);
      } else {
        q.answer_count += 1;
        q.correct_count += isCorrect ? 1 : 0;
      }
      q.option_counts[optionId] = (q.option_counts[optionId] || 0) + 1;
      byDevice.set(deviceId, { selected: optionId, isCorrect });
      return studentState(deviceId)!;
    },

    teacherSession,

    stats() {
      const q = openQuestion();
      if (!q) return null;
      return {
        joined_count: participants.size,
        question_id: q.id,
        state: q.state,
        answer_count: q.answer_count,
        correct_count: q.correct_count,
        option_counts: { ...q.option_counts }
      };
    },

    studentState,

    endedSummary() {
      return {
        questions: questions.map(q => ({
          question_key: q.id,
          opened_at: q.opened_at,
          closed_at: q.closed_at,
          answer_count: q.answer_count,
          correct_count: q.correct_count,
          option_counts: { ...q.option_counts }
        }))
      };
    }
  };
}
