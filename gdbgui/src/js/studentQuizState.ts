export type StudentQuizStatus =
  | "joining"
  | "waiting"
  | "open"
  | "answered"
  | "closed"
  | "ended"
  | "error";

export type StudentQuizChoiceResult = {
  is_correct: boolean | null;
  correct_option_id: string;
  explanation: string;
};

export type StudentQuizTableResult = {
  correct_cells: number | null;
  total_cells: number | null;
  explanation: string;
};

type StudentQuizQuestionBase = {
  id: string;
  prompt: string;
  source_file: string;
  line: number;
  state: "open" | "closed";
};

export type StudentQuizChoiceQuestion = StudentQuizQuestionBase & {
  kind: "choice";
  options: Array<{ id: string; text: string }>;
  result?: StudentQuizChoiceResult;
};

export type StudentQuizTableQuestion = StudentQuizQuestionBase & {
  kind: "table";
  rows: number;
  cols: number;
  row_labels: string[];
  col_labels: string[];
  answer: string[][] | null;
  correct_values?: string[][];
  result?: StudentQuizTableResult;
};

export type StudentQuizQuestion = StudentQuizChoiceQuestion | StudentQuizTableQuestion;

export type StudentQuizState = {
  status: StudentQuizStatus;
  session_title: string;
  nickname: string;
  participant_id: number | null;
  session_id: number | null;
  active_question: StudentQuizQuestion | null;
  selected_option_id: string | null;
  reconnecting: boolean;
  message: string | null;
};

export function initialStudentState(sessionTitle: string): StudentQuizState {
  return {
    status: "joining",
    session_title: sessionTitle,
    nickname: "",
    participant_id: null,
    session_id: null,
    active_question: null,
    selected_option_id: null,
    reconnecting: false,
    message: null
  };
}

function text(value: any): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: any): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nonnegativeInteger(value: any): number | null {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function labels(value: any, length: number): string[] {
  return Array.isArray(value) && value.length === length
    ? value.map(text)
    : Array.from({ length }, (_, index) => String(index));
}

function tableValues(value: any, rows: number, cols: number): string[][] | null {
  if (!Array.isArray(value) || value.length !== rows) return null;
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== cols || row.some(cell => typeof cell !== "string")) {
      return null;
    }
  }
  return value;
}

export function reduceStudentState(
  previous: StudentQuizState,
  snapshot: any
): StudentQuizState {
  if (!snapshot || snapshot.state === "ended" || snapshot.status === "ended") {
    return {
      ...initialStudentState(previous.session_title),
      status: "ended"
    };
  }

  const sessionTitle = text(snapshot.session_title) || previous.session_title;
  const common = {
    session_title: sessionTitle,
    nickname: text(snapshot.nickname),
    participant_id: positiveInteger(snapshot.participant_id),
    session_id: positiveInteger(snapshot.session_id),
    reconnecting: false,
    message: null
  };
  const raw = snapshot.active_question;
  if (!raw) {
    return {
      ...common,
      status: "waiting",
      active_question: null,
      selected_option_id: null
    };
  }

  const state = raw.state === "closed" ? "closed" : "open";
  const base = {
    id: text(raw.id),
    prompt: text(raw.prompt),
    source_file: text(raw.source_file),
    line: positiveInteger(raw.line) || 0,
    state
  };

  if (raw.kind === "table") {
    const rows = positiveInteger(raw.rows) || 0;
    const cols = positiveInteger(raw.cols) || 0;
    const answer = tableValues(raw.answer, rows, cols);
    const question: StudentQuizTableQuestion = {
      ...base,
      kind: "table",
      rows,
      cols,
      row_labels: labels(raw.row_labels, rows),
      col_labels: labels(raw.col_labels, cols),
      answer
    };
    if (state === "closed") {
      const correctValues = tableValues(raw.correct_values, rows, cols);
      if (correctValues) question.correct_values = correctValues;
      if (raw.result) {
        question.result = {
          correct_cells: nonnegativeInteger(raw.result.correct_cells),
          total_cells: positiveInteger(raw.result.total_cells),
          explanation: text(raw.result.explanation)
        };
      }
    }
    return {
      ...common,
      status: state === "closed" ? "closed" : answer ? "answered" : "open",
      active_question: question,
      selected_option_id: null
    };
  }

  const selected = typeof raw.selected_option_id === "string" ? raw.selected_option_id : null;
  const question: StudentQuizChoiceQuestion = {
    ...base,
    kind: "choice",
    options: Array.isArray(raw.options)
      ? raw.options
          .filter((option: any) => option && typeof option.id === "string")
          .map((option: any) => ({ id: option.id, text: text(option.text) }))
      : []
  };
  if (state === "closed" && raw.result) {
    question.result = {
      is_correct: typeof raw.result.is_correct === "boolean" ? raw.result.is_correct : null,
      correct_option_id: text(raw.result.correct_option_id),
      explanation: text(raw.result.explanation)
    };
  }
  return {
    ...common,
    status: state === "closed" ? "closed" : selected ? "answered" : "open",
    active_question: question,
    selected_option_id: selected
  };
}

export function markSubmitted(
  state: StudentQuizState,
  optionId?: string
): StudentQuizState {
  return {
    ...state,
    status: "answered",
    active_question: state.active_question ? { ...state.active_question } : null,
    selected_option_id: state.active_question && state.active_question.kind === "choice"
      ? optionId || state.selected_option_id
      : null,
    message: null
  };
}

export function markReconnecting(state: StudentQuizState): StudentQuizState {
  return {
    ...state,
    reconnecting: true,
    message: null
  };
}

export function markStudentError(
  state: StudentQuizState,
  message: string
): StudentQuizState {
  return {
    ...state,
    status: "error",
    reconnecting: false,
    active_question: null,
    selected_option_id: null,
    message
  };
}
