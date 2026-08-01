import io from "socket.io-client";
import { LiveQuizSession } from "./lessonQuizRuntime";

export type LiveQuizStats = {
  joined_count: number;
  question_id: string;
  state: string;
  answer_count: number;
  correct_count: number;
  option_counts: { [optionId: string]: number };
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

export const createLiveSession = (lessonId: number): Promise<LiveQuizSession> =>
  request("POST", "/api/live-quiz/sessions", { lesson_id: lessonId });

export const getLiveSession = (sessionId: number): Promise<LiveQuizSession> =>
  request("GET", `/api/live-quiz/sessions/${sessionId}`);

export const triggerLiveQuestion = (
  sessionId: number,
  questionId: string,
  sourceFile: string,
  line: number
): Promise<LiveQuizSession> =>
  request(
    "POST",
    `/api/live-quiz/sessions/${sessionId}/questions/${encodeURIComponent(questionId)}/trigger`,
    { source_file: sourceFile, line }
  );

export const closeLiveQuestion = (
  sessionId: number,
  questionId: string
): Promise<LiveQuizSession> =>
  request(
    "POST",
    `/api/live-quiz/sessions/${sessionId}/questions/${encodeURIComponent(questionId)}/close`
  );

export const endLiveSession = (sessionId: number): Promise<LiveQuizSession> =>
  request("POST", `/api/live-quiz/sessions/${sessionId}/end`);

export function connectTeacherQuizSocket(
  sessionId: number,
  handlers: {
    onState: (session: LiveQuizSession) => void;
    onStats: (stats: LiveQuizStats) => void;
    onConnection: (connected: boolean) => void;
  }
): () => void {
  const socket: any = (io as any).connect("/lesson_quiz", {
    auth: { role: "teacher", session_id: sessionId }
  });
  socket.on("connect", () => handlers.onConnection(true));
  socket.on("disconnect", () => handlers.onConnection(false));
  socket.on("connect_error", () => handlers.onConnection(false));
  socket.on("quiz:teacher-state", handlers.onState);
  socket.on("quiz:stats", handlers.onStats);
  return () => socket.disconnect();
}
