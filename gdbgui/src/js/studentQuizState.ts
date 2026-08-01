export type StudentQuizStatus =
  | "joining"
  | "waiting"
  | "open"
  | "answered"
  | "closed"
  | "ended"
  | "error";

export type StudentQuizResult = {
  is_correct: boolean | null;
  correct_option_id: string;
  explanation: string;
};

export type StudentQuizQuestion = {
  id: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  source_file: string;
  line: number;
  state: "open" | "closed";
  result?: StudentQuizResult;
};

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
  const selected = typeof raw.selected_option_id === "string" ? raw.selected_option_id : null;
  const question: StudentQuizQuestion = {
    id: text(raw.id),
    prompt: text(raw.prompt),
    options: Array.isArray(raw.options)
      ? raw.options
          .filter((option: any) => option && typeof option.id === "string")
          .map((option: any) => ({ id: option.id, text: text(option.text) }))
      : [],
    source_file: text(raw.source_file),
    line: positiveInteger(raw.line) || 0,
    state
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
  optionId: string
): StudentQuizState {
  return {
    ...state,
    status: "answered",
    active_question: state.active_question
      ? { ...state.active_question, options: state.active_question.options.map(option => ({ ...option })) }
      : null,
    selected_option_id: optionId,
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
