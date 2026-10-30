/**
 * 老師端的課堂測驗引擎：把原本伺服器（live_quiz.py）上的計分搬進瀏覽器。
 * 純函式式閉包，不碰網路、不碰 storage；回傳的 payload 形狀與伺服器一致，
 * 讓既有面板與學生頁不必知道計分已經換地方。
 *
 * 支援單選題與填表題（kind === "table"）。
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

export type StudentTableResponse = {
  nickname: string;
  answer: string[][] | null;
  correct_cells: number;
  total_cells: number;
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
    /** 填表題開過之後才有；伺服器驗證上傳時沒有 correct_table_json，要靠這兩個數字核對 cell_stats 長度。 */
    rows?: number;
    cols?: number;
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
  answerTable(deviceId: string, questionId: string, answer: string[][]): StudentState;
  responses(questionId: string): { responses: StudentTableResponse[] };
  teacherSession(): LiveQuizSession;
  stats(): LiveQuizStats | null;
  studentState(deviceId: string): StudentState | null;
  endedSummary(): EndUpload;
  exportSession(): object;
};

const MAX_NICKNAME_LENGTH = 50;
const MAX_CELL_LENGTH = 32;
const MAX_VAR_HINT_LENGTH = 128;

type Option = { id: string; text: string; [key: string]: any };
type Captured = {
  rows: number;
  cols: number;
  row_labels: string[];
  col_labels: string[];
  values: string[][];
};
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
  /** 用 Map 存：選項 ID 可以是任何字串（含 __proto__），不能當一般物件的屬性。 */
  option_counts: Map<string, number>;
  /** 填表題的規格（var_hint 會在 trigger 時被老師送來的值取代）。 */
  table_spec?: any;
  /** 填表題 trigger 時收下的表格快照（含正解）；開題前為 null。 */
  captured: Captured | null;
  /** 填表題每格答錯人數，列優先一維；開題前為 null。 */
  cell_stats: number[] | null;
};
type Participant = { nickname: string; joined_at: string; last_seen_at: string };
type Response = {
  answered_at: string;
  selected: string | null;
  isCorrect: boolean | null;
  answer: string[][] | null;
  correct_cells: number | null;
  total_cells: number | null;
};

function reject(status: 400 | 404 | 409, message: string): never {
  const error: EngineError = { status, message };
  throw error;
}

/** Python 的 len(str) 以 code point 計；JS 的 .length 是 UTF-16 單位。 */
function charLength(text: string): number {
  return Array.from(text).length;
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
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Map 轉成 payload 用的物件；用 defineProperty 才能放 __proto__ 這種 key。 */
function countsObject(counts: Map<string, number>): { [id: string]: number } {
  const out: { [id: string]: number } = {};
  counts.forEach((value, key) => {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  });
  return out;
}

/** 依 code point 比大小，等同 SQLite 預設（BINARY）對 UTF-8 的排序。 */
function compareText(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

// ---- 填表題計分：照搬 live_quiz.py 的同名函式 ----

function isPlainObject(value: any): value is { [key: string]: any } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInt(value: any): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** validate_captured_table：驗證教師端送上來的表格快照。 */
function validateCapturedTable(raw: any, maxCells: number): Captured {
  if (!isPlainObject(raw)) reject(400, "表格格式不正確。");
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== ["col_labels", "cols", "row_labels", "rows", "values"].join(",")) {
    reject(400, "表格含有未知欄位或缺少必要欄位。");
  }
  const { rows, cols, values } = raw;
  if (!isPositiveInt(rows) || !isPositiveInt(cols)) reject(400, "表格維度必須是正整數。");
  if (rows * cols > maxCells) {
    reject(400, `表格有 ${rows}×${cols}=${rows * cols} 格，超過上限 ${maxCells} 格。`);
  }
  if (!Array.isArray(values) || values.length !== rows) reject(400, "表格列數與內容不符。");
  const normalized: string[][] = [];
  values.forEach((row: any, index: number) => {
    if (!Array.isArray(row) || row.length !== cols) {
      reject(400, `第 ${index + 1} 列有 ${Array.isArray(row) ? row.length : "?"} 格，與其他列不一致。`);
    }
    for (const cell of row) {
      if (typeof cell !== "string") reject(400, "表格內容必須是字串。");
      if (charLength(cell) > MAX_CELL_LENGTH) {
        reject(400, `單格內容不可超過 ${MAX_CELL_LENGTH} 字元。填表題只適用純量。`);
      }
    }
    normalized.push(row.slice());
  });
  const labels: string[][] = [];
  for (const [key, expected] of [["row_labels", rows], ["col_labels", cols]] as Array<[string, number]>) {
    const label = raw[key];
    if (!Array.isArray(label) || label.length !== expected) reject(400, "表格標籤數量與維度不符。");
    for (const text of label) {
      if (typeof text !== "string" || charLength(text) > MAX_CELL_LENGTH) {
        reject(400, "表格標籤格式不正確。");
      }
    }
    labels.push(label.slice());
  }
  return { rows, cols, values: normalized, row_labels: labels[0], col_labels: labels[1] };
}

function cellIsCorrect(given: string, expected: string): boolean {
  const trimmed = given.trim();
  return trimmed !== "" && trimmed === expected.trim();
}

/** grade_table：回傳 [答對格數, 總格數]。 */
function gradeTable(answer: string[][], correct: string[][]): [number, number] {
  let right = 0;
  let total = 0;
  correct.forEach((row, r) =>
    row.forEach((expected, c) => {
      total += 1;
      if (cellIsCorrect(answer[r][c], expected)) right += 1;
    })
  );
  return [right, total];
}

/** accumulate_cell_stats（delta = 1）與 reverse_cell_stats（delta = -1，不低於 0）。 */
function adjustCellStats(stats: number[], answer: string[][], correct: string[][], delta: 1 | -1) {
  const cols = correct.length ? correct[0].length : 0;
  correct.forEach((row, r) =>
    row.forEach((expected, c) => {
      if (cellIsCorrect(answer[r][c], expected)) return;
      const index = r * cols + c;
      stats[index] = delta === 1 ? stats[index] + 1 : Math.max(0, stats[index] - 1);
    })
  );
}

export function createEngine(
  session: LiveQuizSession,
  now: () => string = () => new Date().toISOString()
): LiveQuizEngine {
  const questions: Question[] = session.questions.map(raw => {
    const q = clone(raw) as any;
    const counts = new Map<string, number>();
    for (const option of q.options || []) counts.set(option.id, 0);
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
      option_counts: counts,
      table_spec: q.table_spec,
      captured: null,
      cell_stats: null
    };
  });
  const participants = new Map<string, Participant>();
  const answers = new Map<string, Map<string, Response>>();

  const findQuestion = (id: string): Question | undefined => questions.find(q => q.id === id);
  const openQuestion = (): Question | undefined => questions.find(q => q.state === "open");
  /** _latest_question：opened_at 最大者；時間相同取先出現的（與 Python max 相同）。 */
  const latestQuestion = (): Question | undefined => {
    let best: Question | undefined;
    for (const q of questions) {
      if (q.opened_at && (!best || q.opened_at > best.opened_at!)) best = q;
    }
    return best;
  };

  // _question_payload
  function questionPayload(q: Question) {
    const base = {
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
      correct_count: q.correct_count
    };
    if (q.kind === "table") {
      const payload: { id: string; state: string; [key: string]: any } = {
        ...base,
        table_spec: clone(q.table_spec)
      };
      if (q.captured) {
        payload.rows = q.captured.rows;
        payload.cols = q.captured.cols;
        payload.row_labels = clone(q.captured.row_labels);
        payload.col_labels = clone(q.captured.col_labels);
        payload.cell_stats = q.cell_stats!.slice();
        // 正解只給老師；學生端走 studentQuestion，收卷前不會有它。
        payload.correct_values = clone(q.captured.values);
      }
      return payload;
    }
    return {
      ...base,
      options: clone(q.options),
      correct_option_id: q.correct_option_id,
      option_counts: countsObject(q.option_counts)
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

  // student_question_payload + guest_state：正解與解析只在 closed 之後出現。
  function studentQuestion(q: Question, response: Response | undefined) {
    const closed = q.state === "closed";
    const payload: { [key: string]: any } = {
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      test_input: q.test_input,
      state: q.state,
      source_file: q.source_file,
      line: q.line
    };
    if (q.kind === "table") {
      if (q.captured) {
        payload.rows = q.captured.rows;
        payload.cols = q.captured.cols;
        payload.row_labels = clone(q.captured.row_labels);
        payload.col_labels = clone(q.captured.col_labels);
        if (closed) payload.correct_values = clone(q.captured.values);
      }
      payload.answer = response && response.answer ? clone(response.answer) : null;
      if (closed) {
        payload.result = {
          correct_cells: response ? response.correct_cells : null,
          total_cells: response ? response.total_cells : null,
          explanation: q.explanation
        };
      }
      return payload;
    }
    payload.options = clone(q.options);
    payload.selected_option_id = response ? response.selected : null;
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
    const response = active ? (answers.get(active.id) || new Map()).get(deviceId) : undefined;
    return {
      participant_id: deviceId,
      session_id: session.id,
      session_title: session.title,
      nickname: participant.nickname,
      state: "active",
      active_question: active ? studentQuestion(active, response) : null
    };
  }

  function responsesFor(q: Question): Map<string, Response> {
    let byDevice = answers.get(q.id);
    if (!byDevice) {
      byDevice = new Map();
      answers.set(q.id, byDevice);
    }
    return byDevice;
  }

  return {
    hello(deviceId, nickname) {
      if (typeof nickname !== "string") reject(400, "暱稱必須是文字。");
      const name = nickname.trim();
      const length = charLength(name);
      if (length < 1 || length > MAX_NICKNAME_LENGTH) reject(400, "暱稱長度不正確。");
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 32 || code === 127) reject(400, "暱稱不可含控制字元。");
      }
      const existing = participants.get(deviceId);
      if (existing) {
        existing.last_seen_at = now();
        return { isNew: false };
      }
      const at = now();
      participants.set(deviceId, { nickname: name, joined_at: at, last_seen_at: at });
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
        if (q.kind === "table") {
          // 全部驗證完才改狀態，失敗時題目維持 ready。
          const spec = q.table_spec;
          const captured = validateCapturedTable(capture ? capture.table : undefined, spec.max_cells);
          const hint = capture && typeof capture.var_hint === "string" ? capture.var_hint : spec.var_hint;
          if (charLength(hint) > MAX_VAR_HINT_LENGTH) reject(400, "變數提示過長。");
          q.captured = captured;
          q.cell_stats = new Array(captured.rows * captured.cols).fill(0);
          q.table_spec = { ...spec, var_hint: hint };
        } else if (q.kind !== "choice") {
          reject(400, "尚未支援此題型。");
        }
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
      const byDevice = responsesFor(q);
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
        const old = q.option_counts.get(existing.selected!);
        if (old !== undefined) q.option_counts.set(existing.selected!, Math.max(0, old - 1));
        q.correct_count += (isCorrect ? 1 : 0) - (existing.isCorrect ? 1 : 0);
      } else {
        q.answer_count += 1;
        q.correct_count += isCorrect ? 1 : 0;
      }
      q.option_counts.set(optionId, (q.option_counts.get(optionId) || 0) + 1);
      byDevice.set(deviceId, {
        answered_at: now(),
        selected: optionId,
        isCorrect,
        answer: null,
        correct_cells: null,
        total_cells: null
      });
      return studentState(deviceId)!;
    },

    answerTable(deviceId, questionId, answer) {
      if (typeof questionId !== "string" || !questionId) reject(400, "缺少題目 ID。");
      const q = findQuestion(questionId);
      if (!q) reject(404, "找不到題目。");
      if (!participants.has(deviceId)) reject(409, "找不到可作答的題目。");
      if (q.kind !== "table") reject(400, "作答格式與題型不符。");
      const byDevice = responsesFor(q);
      const existing = byDevice.get(deviceId);
      if (q.state !== "open") {
        // 關題後已作答的人永遠拿到舊答案；沒作答的人不能補答。
        if (existing) return studentState(deviceId)!;
        reject(409, "這一題目前未開放作答。");
      }
      const correct = q.captured!;
      if (!Array.isArray(answer) || answer.length !== correct.rows) {
        reject(400, "作答的表格維度與題目不符。");
      }
      for (const line of answer) {
        if (!Array.isArray(line) || line.length !== correct.cols) {
          reject(400, "作答的表格維度與題目不符。");
        }
        if (line.some(cell => typeof cell !== "string")) reject(400, "表格內容必須是字串。");
      }
      const clean = answer.map(line =>
        line.map(cell => Array.from(cell).slice(0, MAX_CELL_LENGTH).join(""))
      );
      const [right, total] = gradeTable(clean, correct.values);
      const stats = q.cell_stats!;
      if (existing) {
        // 題目還開著：允許改答案。先把舊答案算進去的答錯次數扣掉，answer_count 不變。
        adjustCellStats(stats, existing.answer!, correct.values, -1);
        const oldAllCorrect = existing.correct_cells === existing.total_cells;
        adjustCellStats(stats, clean, correct.values, 1);
        q.correct_count += (right === total ? 1 : 0) - (oldAllCorrect ? 1 : 0);
      } else {
        adjustCellStats(stats, clean, correct.values, 1);
        q.answer_count += 1;
        q.correct_count += right === total ? 1 : 0;
      }
      byDevice.set(deviceId, {
        answered_at: now(),
        selected: null,
        isCorrect: null,
        answer: clean,
        correct_cells: right,
        total_cells: total
      });
      return studentState(deviceId)!;
    },

    // responses_for_question：收卷後、僅填表題才能看個別作答
    responses(questionId) {
      const q = typeof questionId === "string" ? findQuestion(questionId) : undefined;
      if (!q) reject(404, "找不到題目。");
      if (q.kind !== "table" || q.state !== "closed") reject(409, "這一題沒有可檢視的個別作答。");
      const list: StudentTableResponse[] = [];
      responsesFor(q).forEach((response, deviceId) => {
        list.push({
          nickname: participants.get(deviceId)!.nickname,
          answer: clone(response.answer),
          correct_cells: response.correct_cells!,
          total_cells: response.total_cells!
        });
      });
      list.sort((a, b) => a.correct_cells - b.correct_cells || compareText(a.nickname, b.nickname));
      return { responses: list };
    },

    teacherSession,

    // 進行中的題；沒有就取最近開過的（含已收卷）——與伺服器 emit_teacher_state 相同。
    stats() {
      const q = openQuestion() || latestQuestion();
      if (!q) return null;
      const stats: LiveQuizStats = {
        joined_count: participants.size,
        question_id: q.id,
        state: q.state,
        answer_count: q.answer_count,
        correct_count: q.correct_count
      };
      if (q.kind === "table") stats.cell_stats = q.cell_stats ? q.cell_stats.slice() : undefined;
      else stats.option_counts = countsObject(q.option_counts);
      return stats;
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
          ...(q.kind === "choice" ? { option_counts: countsObject(q.option_counts) } : {}),
          ...(q.kind === "table"
            ? {
                var_hint: q.table_spec.var_hint,
                ...(q.captured
                  ? { cell_stats: q.cell_stats!.slice(), rows: q.captured.rows, cols: q.captured.cols }
                  : {})
              }
            : {})
        }))
      };
    },

    // export_session：逐筆作答快照（欄位與順序照伺服器）
    exportSession() {
      const ordered = questions.slice().sort((a, b) => a.position - b.position);
      const nicknames = (deviceId: string) => participants.get(deviceId)!.nickname;
      const rows: Array<{ position: number; nickname: string; body: any }> = [];
      for (const q of ordered) {
        responsesFor(q).forEach((r, deviceId) => {
          rows.push({
            position: q.position,
            nickname: nicknames(deviceId),
            body: {
              question_key: q.id,
              kind: q.kind,
              nickname: nicknames(deviceId),
              answered_at: r.answered_at,
              selected_option_id: r.selected,
              is_correct: r.isCorrect === null ? null : r.isCorrect ? 1 : 0,
              answer: clone(r.answer),
              correct_cells: r.correct_cells,
              total_cells: r.total_cells
            }
          });
        });
      }
      rows.sort((a, b) => a.position - b.position || compareText(a.nickname, b.nickname));
      const people = Array.from(participants.values()).sort((a, b) => compareText(a.nickname, b.nickname));
      return {
        exported_at: now(),
        session: {
          id: session.id,
          title: session.title,
          state: session.state,
          created_at: session.created_at,
          ended_at: session.ended_at
        },
        participants: people.map(p => ({
          nickname: p.nickname,
          joined_at: p.joined_at,
          last_seen_at: p.last_seen_at
        })),
        questions: ordered.map(q => ({
          question_key: q.id,
          kind: q.kind,
          prompt: q.prompt,
          position: q.position,
          state: q.state,
          opened_at: q.opened_at,
          closed_at: q.closed_at,
          answer_count: q.answer_count,
          correct_count: q.correct_count,
          correct_option_id: q.kind === "choice" ? q.correct_option_id : null,
          option_counts: q.kind === "choice" ? countsObject(q.option_counts) : null,
          table_spec: q.kind === "table" ? clone(q.table_spec) : null,
          correct_table: q.captured ? clone(q.captured) : null,
          cell_stats: q.cell_stats ? q.cell_stats.slice() : null
        })),
        responses: rows.map(r => r.body)
      };
    }
  };
}
