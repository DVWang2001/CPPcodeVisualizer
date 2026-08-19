import { QuizTrigger } from "./quizSchema";
import { SourceFrame, triggerMatchesFrame } from "./quizTrigger";
import { CapturedTable } from "./tableFromContainer";

export type LiveQuizSession = {
  id: number;
  state: string;
  questions: Array<{ id: string; state: string; [key: string]: any }>;
  active_question?: any;
  [key: string]: any;
};

type RuntimeCallbacks = {
  trigger: (
    sessionId: number,
    questionId: string,
    sourceFile: string,
    line: number,
    capture?: { table: CapturedTable; var_hint: string }
  ) => Promise<LiveQuizSession>;
  setGate: (blocked: boolean) => void;
  onChange?: (state: RuntimeState) => void;
};

type RuntimeQuestion = {
  id: string;
  kind: "choice" | "table";
  trigger: QuizTrigger;
  tableSpec?: { var_hint: string; max_cells: number };
};

export type PendingTable = {
  questionId: string;
  sourceFile: string;
  line: number;
  tableSpec: { var_hint: string; max_cells: number };
};

export type RuntimeState = {
  active: boolean;
  blocked: boolean;
  inFlightQuestionId: string | null;
  error: string | null;
  session: LiveQuizSession | null;
  pendingTable: PendingTable | null;
};

let activeSession: LiveQuizSession | null = null;
let activeQuestions: RuntimeQuestion[] = [];
let callbacks: RuntimeCallbacks | null = null;
let blocked = false;
let inFlightQuestionId: string | null = null;
let failedQuestion: RuntimeQuestion | null = null;
let pendingQuestion: RuntimeQuestion | null = null;
let pendingCapture: { table: CapturedTable; var_hint: string } | null = null;
let error: string | null = null;
let generation = 0;
const triggered = new Set<string>();

function snapshot(): RuntimeState {
  return {
    active: activeSession !== null,
    blocked,
    inFlightQuestionId,
    error,
    session: activeSession,
    pendingTable: pendingQuestion && pendingQuestion.tableSpec ? {
      questionId: pendingQuestion.id,
      sourceFile: pendingQuestion.trigger.source_file,
      line: pendingQuestion.trigger.line,
      tableSpec: pendingQuestion.tableSpec
    } : null
  };
}

function changed() {
  if (callbacks && callbacks.onChange) callbacks.onChange(snapshot());
}

function sessionIsBlocked(session: LiveQuizSession): boolean {
  return Boolean(
    session.active_question?.state === "open" ||
    session.questions.some(question => question.state === "open")
  );
}

function questionsFromSession(session: LiveQuizSession): RuntimeQuestion[] {
  return session.questions.map(question => ({
    id: question.id,
    kind: question.kind === "table" ? "table" : "choice",
    tableSpec: question.kind === "table" ? question.table_spec : undefined,
    trigger: {
      kind: "source_line",
      source_file: question.source_file,
      line: question.line,
      anchor: question.anchor
    }
  }));
}

function openQuestion(
  question: RuntimeQuestion,
  capture?: { table: CapturedTable; var_hint: string }
): boolean {
  if (!activeSession || !callbacks || inFlightQuestionId) return false;
  const currentGeneration = generation;
  const sessionId = activeSession.id;
  blocked = true;
  error = null;
  failedQuestion = null;
  inFlightQuestionId = question.id;
  triggered.add(question.id);
  callbacks.setGate(true);
  changed();
  const request = capture
    ? callbacks.trigger(sessionId, question.id, question.trigger.source_file, question.trigger.line, capture)
    : callbacks.trigger(sessionId, question.id, question.trigger.source_file, question.trigger.line);
  request
    .then(session => {
      if (generation !== currentGeneration || !activeSession) return;
      activeSession = session;
      inFlightQuestionId = null;
      pendingQuestion = null;
      pendingCapture = null;
      changed();
    })
    .catch(() => {
      if (generation !== currentGeneration || !activeSession) return;
      triggered.delete(question.id);
      failedQuestion = question;
      inFlightQuestionId = null;
      error = "無法開啟題目。請檢查連線後重試，或結束課堂。";
      changed();
    });
  return true;
}

export function isQuizPlaybackBlocked(storeLike: { get: (key: string) => any }): boolean {
  return storeLike.get("quiz_playback_gate") === true;
}

export const lessonQuizRuntime = {
  activate(
    session: LiveQuizSession,
    nextCallbacks: RuntimeCallbacks
  ) {
    this.deactivate();
    activeSession = session;
    activeQuestions = questionsFromSession(session);
    callbacks = nextCallbacks;
    blocked = sessionIsBlocked(session);
    callbacks.setGate(blocked);
    changed();
  },

  deactivate() {
    generation += 1;
    if (callbacks) callbacks.setGate(false);
    activeSession = null;
    activeQuestions = [];
    callbacks = null;
    blocked = false;
    inFlightQuestionId = null;
    failedQuestion = null;
    pendingQuestion = null;
    pendingCapture = null;
    error = null;
    triggered.clear();
  },

  onGdbPause(frame: SourceFrame): boolean {
    if (!activeSession || !callbacks || blocked) return false;
    const question = activeQuestions.find(candidate => {
      const serverQuestion = activeSession!.questions.find(value => value.id === candidate.id);
      return (
        serverQuestion &&
        serverQuestion.state === "ready" &&
        !triggered.has(candidate.id) &&
        triggerMatchesFrame(candidate.trigger, frame)
      );
    });
    if (!question) return false;
    if (question.kind === "choice") return openQuestion(question);
    blocked = true;
    error = null;
    pendingQuestion = question;
    pendingCapture = null;
    triggered.add(question.id);
    callbacks.setGate(true);
    changed();
    return true;
  },

  confirmTable(table: CapturedTable, varHint: string): boolean {
    if (!pendingQuestion || inFlightQuestionId) return false;
    pendingCapture = { table, var_hint: varHint };
    return openQuestion(pendingQuestion, pendingCapture);
  },

  retryTrigger(): boolean {
    if (pendingQuestion && pendingCapture) return openQuestion(pendingQuestion, pendingCapture);
    return failedQuestion ? openQuestion(failedQuestion) : false;
  },

  clearGate() {
    generation += 1;
    blocked = false;
    inFlightQuestionId = null;
    failedQuestion = null;
    pendingQuestion = null;
    pendingCapture = null;
    error = null;
    if (callbacks) callbacks.setGate(false);
    changed();
  },

  syncSession(session: LiveQuizSession) {
    if (!activeSession || session.id !== activeSession.id) return;
    activeSession = session;
    const serverBlocked = session.state !== "ended" && sessionIsBlocked(session);
    const pendingServerQuestion = pendingQuestion &&
      session.questions.find(question => question.id === pendingQuestion!.id);
    const pendingIsReady = Boolean(
      pendingQuestion && session.state !== "ended" && pendingServerQuestion?.state === "ready"
    );
    if ((pendingQuestion && !pendingIsReady) || (serverBlocked && (pendingQuestion || inFlightQuestionId))) {
      if (pendingQuestion && pendingIsReady && serverBlocked) triggered.delete(pendingQuestion.id);
      if (inFlightQuestionId) generation += 1;
      pendingQuestion = null;
      pendingCapture = null;
      inFlightQuestionId = null;
      failedQuestion = null;
      error = null;
    }
    const nextBlocked = serverBlocked || pendingQuestion !== null;
    if (blocked !== nextBlocked && callbacks) {
      blocked = nextBlocked;
      if (!blocked) {
        inFlightQuestionId = null;
        failedQuestion = null;
        error = null;
      }
      callbacks.setGate(blocked);
    }
    changed();
  },

  questionClosed(session: LiveQuizSession) {
    if (!activeSession || session.id !== activeSession.id || !callbacks) return;
    activeSession = session;
    blocked = false;
    inFlightQuestionId = null;
    failedQuestion = null;
    pendingQuestion = null;
    pendingCapture = null;
    error = null;
    callbacks.setGate(false);
    changed();
  },

  state: snapshot
};
