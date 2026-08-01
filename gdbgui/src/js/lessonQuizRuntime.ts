import { QuizQuestion, QuizSpec } from "./quizSchema";
import { SourceFrame, triggerMatchesFrame } from "./quizTrigger";

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
    line: number
  ) => Promise<LiveQuizSession>;
  setGate: (blocked: boolean) => void;
  onChange?: (state: RuntimeState) => void;
};

export type RuntimeState = {
  active: boolean;
  blocked: boolean;
  inFlightQuestionId: string | null;
  error: string | null;
  session: LiveQuizSession | null;
};

let activeSession: LiveQuizSession | null = null;
let activeQuiz: QuizSpec | null = null;
let callbacks: RuntimeCallbacks | null = null;
let blocked = false;
let inFlightQuestionId: string | null = null;
let failedQuestion: QuizQuestion | null = null;
let error: string | null = null;
let generation = 0;
const triggered = new Set<string>();

function snapshot(): RuntimeState {
  return {
    active: activeSession !== null,
    blocked,
    inFlightQuestionId,
    error,
    session: activeSession
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

function openQuestion(question: QuizQuestion): boolean {
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
  callbacks
    .trigger(
      sessionId,
      question.id,
      question.trigger.source_file,
      question.trigger.line
    )
    .then(session => {
      if (generation !== currentGeneration || !activeSession) return;
      activeSession = session;
      inFlightQuestionId = null;
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
    quiz: QuizSpec,
    nextCallbacks: RuntimeCallbacks
  ) {
    this.deactivate();
    activeSession = session;
    activeQuiz = quiz;
    callbacks = nextCallbacks;
    blocked = sessionIsBlocked(session);
    callbacks.setGate(blocked);
    changed();
  },

  deactivate() {
    generation += 1;
    if (callbacks) callbacks.setGate(false);
    activeSession = null;
    activeQuiz = null;
    callbacks = null;
    blocked = false;
    inFlightQuestionId = null;
    failedQuestion = null;
    error = null;
    triggered.clear();
  },

  onGdbPause(frame: SourceFrame): boolean {
    if (!activeSession || !activeQuiz || !callbacks || blocked) return false;
    const question = activeQuiz.questions.find(candidate => {
      const serverQuestion = activeSession!.questions.find(value => value.id === candidate.id);
      return (
        serverQuestion &&
        serverQuestion.state === "ready" &&
        !triggered.has(candidate.id) &&
        triggerMatchesFrame(candidate.trigger, frame)
      );
    });
    return question ? openQuestion(question) : false;
  },

  retryTrigger(): boolean {
    return failedQuestion ? openQuestion(failedQuestion) : false;
  },

  clearGate() {
    generation += 1;
    blocked = false;
    inFlightQuestionId = null;
    failedQuestion = null;
    error = null;
    if (callbacks) callbacks.setGate(false);
    changed();
  },

  syncSession(session: LiveQuizSession) {
    if (!activeSession || session.id !== activeSession.id) return;
    activeSession = session;
    const nextBlocked = sessionIsBlocked(session);
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
    error = null;
    callbacks.setGate(false);
    changed();
  },

  state: snapshot
};
