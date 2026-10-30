// 老師端 client：計分在瀏覽器（liveQuizEngine），伺服器只剩中繼與開場/收場的 HTTP。
// 這裡 mock socket.io-client 與 fetch，驗證事件契約（見 task-3-report 的事件表）。
type Handler = (...args: any[]) => void;
const mockSocket = {
  handlers: {} as { [event: string]: Handler },
  emit: jest.fn(),
  disconnect: jest.fn(),
  on(event: string, handler: Handler) {
    this.handlers[event] = handler;
    return this;
  }
};
jest.mock("socket.io-client", () => ({ __esModule: true, default: { connect: jest.fn(() => mockSocket) } }));

import {
  closeLiveQuestion,
  connectTeacherQuizSocket,
  createLiveSession,
  downloadLiveSessionExport,
  endLiveSession,
  fetchQuestionResponses,
  triggerLiveQuestion
} from "../liveQuizClient";

const OPTIONS = [
  { id: "a", text: "A" },
  { id: "b", text: "B" }
];

function choiceQuestion(id: string, position: number, line: number) {
  return {
    id,
    kind: "choice",
    prompt: `題目 ${id}`,
    test_input: null,
    explanation: `解析 ${id} 秘密`,
    source_file: "main.cpp",
    line,
    anchor: { source_file: "main.cpp", line },
    position,
    state: "ready",
    opened_at: null,
    closed_at: null,
    answer_count: 0,
    correct_count: 0,
    options: OPTIONS,
    correct_option_id: "b",
    option_counts: { a: 0, b: 0 }
  };
}

const serverSession = () => ({
  id: 7,
  lesson_id: 3,
  lesson_version_id: 5,
  lesson_version: 2,
  owner_id: 1,
  title: "第一堂",
  state: "lobby",
  created_at: "2026-10-30T00:00:00Z",
  ended_at: null,
  joined_count: 0,
  active_question: null,
  join_url: "http://localhost/join/abc",
  qr_url: "qr-data",
  questions: [choiceQuestion("q1", 0, 3), choiceQuestion("q2", 1, 9)]
});

function jsonResponse(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let endResponses: Array<() => Promise<any>>;
let handlers: { onState: jest.Mock; onStats: jest.Mock; onConnection: jest.Mock; onRefused?: jest.Mock };
let disconnect: (() => void) | null;

function fetchCalls(): any[][] {
  return (global as any).fetch.mock.calls;
}

function emitted(event: string): any[] {
  return mockSocket.emit.mock.calls.filter(call => call[0] === event).map(call => call[1]);
}

function receive(event: string, msg: any) {
  mockSocket.handlers[event](msg);
}

function hello(sid: string, device: string, nickname = "小明", extra: any = {}) {
  receive("relay:student-hello", { sid, data: { device_id: device, nickname, ...extra } });
}

function answer(sid: string, device: string, key: string, choice: any, nonce: string = "n-" + device) {
  receive("relay:student-answer", {
    sid,
    data: { device_id: device, question_key: key, answer: choice, nonce }
  });
}

async function startClass() {
  (global as any).fetch = jest.fn((url: string) => {
    if (url === "/api/live-quiz/sessions") return Promise.resolve(jsonResponse(200, serverSession()));
    if (url.endsWith("/end")) {
      const next = endResponses.shift();
      return next ? next() : Promise.resolve(jsonResponse(200, { id: 7, state: "ended", hint_saved: true }));
    }
    return Promise.reject(new Error("unexpected fetch " + url));
  });
  const created = await createLiveSession(3);
  disconnect = connectTeacherQuizSocket(7, handlers);
  return created;
}

beforeEach(() => {
  mockSocket.handlers = {};
  mockSocket.emit.mockClear();
  mockSocket.disconnect.mockClear();
  endResponses = [];
  disconnect = null;
  handlers = { onState: jest.fn(), onStats: jest.fn(), onConnection: jest.fn() };
});

afterEach(() => {
  if (disconnect) disconnect();
  jest.restoreAllMocks();
});

test("createLiveSession 回傳伺服器的 payload，之後的操作保留 join_url 與 qr_url", async () => {
  const created = await startClass();
  expect(created.join_url).toBe("http://localhost/join/abc");

  const updated = await triggerLiveQuestion(7, "q1", "main.cpp", 3);

  expect(updated.join_url).toBe("http://localhost/join/abc");
  expect(updated.qr_url).toBe("qr-data");
  expect(updated.active_question.id).toBe("q1");
});

test("triggerLiveQuestion 在本機開題，並以 relay:to-students 廣播不含正解的狀態", async () => {
  await startClass();
  const callsBefore = fetchCalls().length;

  await triggerLiveQuestion(7, "q1", "main.cpp", 3, undefined, "5 3");

  expect(fetchCalls().length).toBe(callsBefore); // 開題不再打 HTTP
  const broadcasts = emitted("relay:to-students");
  expect(broadcasts).toHaveLength(1);
  const text = JSON.stringify(broadcasts[0]);
  expect(broadcasts[0].payload.active_question.id).toBe("q1");
  expect(broadcasts[0].payload.active_question.state).toBe("open");
  expect(broadcasts[0].payload.active_question.options).toEqual(OPTIONS);
  expect(text).not.toContain("correct_option_id");
  expect(text).not.toContain("秘密");
  expect(text).not.toContain("option_counts");
  expect(text).not.toContain("answer_count");
});

test("引擎的 EngineError 以帶 status 的 Error 浮現，與舊的 HTTP 錯誤同形", async () => {
  await startClass();

  await expect(triggerLiveQuestion(7, "q1", "main.cpp", 99)).rejects.toMatchObject({
    status: 400,
    message: expect.any(String)
  });
  await expect(triggerLiveQuestion(7, "q1", "main.cpp", 99)).rejects.toBeInstanceOf(Error);
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  await expect(triggerLiveQuestion(7, "q2", "main.cpp", 9)).rejects.toMatchObject({ status: 409 });
});

test("收到 relay:student-answer 後計分，並以 relay:to-student 回 quiz:answer-received（帶原 nonce）", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1");
  mockSocket.emit.mockClear();
  handlers.onStats.mockClear();

  answer("S1", "dev-1", "q1", "b", "nonce-123");

  expect(emitted("relay:to-student")).toEqual([
    { sid: "S1", event: "quiz:answer-received", payload: { nonce: "nonce-123" } }
  ]);
  const stats = handlers.onStats.mock.calls[handlers.onStats.mock.calls.length - 1][0];
  expect(stats.answer_count).toBe(1);
  expect(stats.correct_count).toBe(1);
  expect(stats.option_counts).toEqual({ a: 0, b: 1 });
});

test("學生 payload 內帶的 sid 欄位被忽略，只信信封上的 sid", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);

  hello("S1", "dev-1", "小明", { sid: "EVIL" });
  const helloReplies = emitted("relay:to-student");
  expect(helloReplies).toHaveLength(1);
  expect(helloReplies[0].sid).toBe("S1");

  mockSocket.emit.mockClear();
  receive("relay:student-answer", {
    sid: "S1",
    data: { device_id: "dev-1", question_key: "q1", answer: "b", nonce: "n1", sid: "EVIL" }
  });
  const replies = emitted("relay:to-student");
  expect(replies).toHaveLength(1);
  expect(replies[0].sid).toBe("S1");
  expect(JSON.stringify(mockSocket.emit.mock.calls)).not.toContain("EVIL");
});

test("不得在每個答案後對全體學生廣播", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  const afterTrigger = emitted("relay:to-students").length;

  for (let i = 0; i < 6; i++) {
    hello("S" + i, "dev-" + i, "學生" + i);
    answer("S" + i, "dev-" + i, "q1", i % 2 ? "a" : "b");
  }
  expect(emitted("relay:to-students")).toHaveLength(afterTrigger);

  await closeLiveQuestion(7, "q1");
  expect(emitted("relay:to-students")).toHaveLength(afterTrigger + 1);
});

test("收卷時廣播一次通用狀態，並逐一補發每位學生自己的成績", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1", "小明");
  answer("S1", "dev-1", "q1", "a");
  mockSocket.emit.mockClear();

  await closeLiveQuestion(7, "q1");

  const broadcast = emitted("relay:to-students")[0].payload.active_question;
  expect(broadcast.state).toBe("closed");
  expect(broadcast.selected_option_id).toBeUndefined(); // 個人成績不能進廣播
  const personal = emitted("relay:to-student").find(m => m.sid === "S1" && m.event === "quiz:student-state");
  expect(personal.payload.active_question.selected_option_id).toBe("a");
  expect(personal.payload.active_question.result.is_correct).toBe(false);
});

test("question_key 為 __proto__ 或 constructor 的答案被拒絕且不污染物件", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1");
  mockSocket.emit.mockClear();

  answer("S1", "dev-1", "__proto__", "b");
  answer("S1", "dev-1", "constructor", "b");
  answer("S1", "dev-1", "q1", "__proto__");

  expect(emitted("relay:to-student").filter(m => m.event === "quiz:answer-received")).toHaveLength(0);
  expect(({} as any).polluted).toBeUndefined();
  expect(({} as any).b).toBeUndefined();
  expect(Object.keys(Object.prototype)).toEqual([]);
});

test("格式不對的訊息被丟棄而不丟例外", async () => {
  await startClass();
  expect(() => {
    receive("relay:student-hello", null);
    receive("relay:student-hello", { sid: 5, data: {} });
    receive("relay:student-hello", { sid: "S1", data: "x" });
    receive("relay:student-answer", { sid: "S1" });
    receive("relay:student-answer", { sid: "S1", data: { device_id: 3 } });
    receive("relay:roster", undefined);
    receive("relay:presence", { sid: "S1" });
  }).not.toThrow();
  expect(emitted("relay:to-student")).toHaveLength(0);
});

test("收到 relay:student-hello 後，以 relay:to-student 補發該學生的狀態", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  mockSocket.emit.mockClear();

  hello("S1", "dev-1", "小明");

  expect(emitted("relay:to-student")).toHaveLength(1);
  const msg = emitted("relay:to-student")[0];
  expect(msg.sid).toBe("S1");
  expect(msg.event).toBe("quiz:student-state");
  expect(msg.payload.nickname).toBe("小明");
  expect(msg.payload.active_question.id).toBe("q1");
  expect(JSON.stringify(msg.payload)).not.toContain("correct_option_id");
  expect(emitted("relay:to-students")).toHaveLength(0); // 只補發給這一位
});

test("學生重連（relay:presence connected）時補發已知學生的狀態；沒見過 hello 的等 hello", async () => {
  await startClass();
  receive("relay:roster", { students: [{ sid: "S1", device_id: "dev-1" }] });
  hello("S1", "dev-1", "小明");
  mockSocket.emit.mockClear();

  receive("relay:presence", { sid: "S1", connected: true });
  expect(emitted("relay:to-student").map(m => m.sid)).toEqual(["S1"]);

  receive("relay:presence", { sid: "S1", connected: false });
  mockSocket.emit.mockClear();
  receive("relay:presence", { sid: "S9", connected: true });
  expect(emitted("relay:to-student")).toHaveLength(0);
});

test("onState 與 onStats 在每次狀態改變後都會被呼叫", async () => {
  await startClass();
  const step = async (action: () => any) => {
    handlers.onState.mockClear();
    handlers.onStats.mockClear();
    await action();
    expect(handlers.onState).toHaveBeenCalled();
    expect(handlers.onStats).toHaveBeenCalled();
  };

  await step(() => triggerLiveQuestion(7, "q1", "main.cpp", 3));
  await step(() => hello("S1", "dev-1"));
  await step(() => answer("S1", "dev-1", "q1", "b"));
  await step(() => closeLiveQuestion(7, "q1"));
});

test("fetchQuestionResponses 從引擎讀；題型不符以 409 浮現", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  await closeLiveQuestion(7, "q1");

  await expect(fetchQuestionResponses(7, "q1")).rejects.toMatchObject({ status: 409 });
});

test("endLiveSession 以引擎的 endedSummary 為 body 呼叫 /end", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1");
  answer("S1", "dev-1", "q1", "b");

  const ended = await endLiveSession(7);

  const endCalls = fetchCalls().filter(call => String(call[0]).endsWith("/api/live-quiz/sessions/7/end"));
  expect(endCalls).toHaveLength(1);
  expect(endCalls[0][1].method).toBe("POST");
  const body = JSON.parse(endCalls[0][1].body);
  expect(body.questions.map((q: any) => q.question_key)).toEqual(["q1", "q2"]);
  expect(body.questions[0]).toMatchObject({ answer_count: 1, correct_count: 1, option_counts: { a: 0, b: 1 } });
  expect(ended.state).toBe("ended");
});

test.each([
  ["400", () => Promise.resolve(jsonResponse(400, { error: "上傳不合法" }))],
  ["500", () => Promise.resolve(jsonResponse(500, { error: "boom" }))],
  ["network error", () => Promise.reject(new TypeError("Failed to fetch"))]
])("endLiveSession 在 %s 時以空 body 重試一次，課堂仍會結束", async (_name, failure) => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  endResponses = [failure as any, () => Promise.resolve(jsonResponse(200, { id: 7, state: "ended", hint_saved: false }))];

  const ended = await endLiveSession(7);

  const endCalls = fetchCalls().filter(call => String(call[0]).endsWith("/end"));
  expect(endCalls).toHaveLength(2);
  expect(endCalls[0][1].body).toBeDefined();
  expect(endCalls[1][1].body).toBeUndefined(); // 空 body = 不上傳
  expect(ended.state).toBe("ended");
  expect(ended.hint_saved).toBe(false); // hint_saved:false 不是錯誤
});

test("endLiveSession 兩次都失敗時以重試那次的錯誤 reject", async () => {
  await startClass();
  endResponses = [
    () => Promise.resolve(jsonResponse(400, { error: "first" })),
    () => Promise.resolve(jsonResponse(500, { error: "second" }))
  ];

  await expect(endLiveSession(7)).rejects.toMatchObject({ status: 500, message: "second" });
  expect(fetchCalls().filter(call => String(call[0]).endsWith("/end"))).toHaveLength(2);
});

test("結束之後不再處理中繼事件", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  await endLiveSession(7);
  mockSocket.emit.mockClear();

  hello("S1", "dev-1");

  expect(mockSocket.emit).not.toHaveBeenCalled();
});

test("downloadLiveSessionExport 在瀏覽器內由引擎產生 JSON 並下載", async () => {
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1", "小明");
  answer("S1", "dev-1", "q1", "b");
  const blobs: Blob[] = [];
  (URL as any).createObjectURL = jest.fn((blob: Blob) => {
    blobs.push(blob);
    return "blob:x";
  });
  (URL as any).revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const callsBefore = fetchCalls().length;

  downloadLiveSessionExport();

  expect(click).toHaveBeenCalledTimes(1);
  expect(fetchCalls().length).toBe(callsBefore);
  const text = await new Promise<string>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blobs[0]);
  });
  const exported = JSON.parse(text);
  expect(exported.participants[0].nickname).toBe("小明");
  expect(exported.responses).toHaveLength(1);
});

test("老師端從不寫入 localStorage 或 sessionStorage", async () => {
  const setItem = jest.spyOn(Storage.prototype, "setItem");
  await startClass();
  await triggerLiveQuestion(7, "q1", "main.cpp", 3);
  hello("S1", "dev-1");
  answer("S1", "dev-1", "q1", "b");
  receive("relay:roster", { students: [{ sid: "S1", device_id: "dev-1" }] });
  receive("relay:presence", { sid: "S1", connected: false });
  await closeLiveQuestion(7, "q1");
  (URL as any).createObjectURL = jest.fn(() => "blob:x");
  (URL as any).revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  downloadLiveSessionExport();
  await endLiveSession(7);

  expect(setItem).not.toHaveBeenCalled();
});

test("connect / disconnect 事件轉成 onConnection", async () => {
  await startClass();

  mockSocket.handlers["connect"]();
  mockSocket.handlers["disconnect"]();
  mockSocket.handlers["connect_error"]({ type: "TransportError", message: "xhr poll error" });

  expect(handlers.onConnection.mock.calls.map(call => call[0])).toEqual([true, false, false]);
});

test("伺服器拒絕老師連線（connect_error 且 socket 不再自動重連）時呼叫 onRefused；網路層錯誤與一般斷線不會", async () => {
  await startClass();
  handlers.onRefused = jest.fn();
  disconnect!();
  disconnect = connectTeacherQuizSocket(7, handlers);
  (mockSocket as any).active = true;

  mockSocket.handlers["disconnect"]("transport close");
  mockSocket.handlers["connect_error"]({ type: "TransportError", message: "websocket error" });
  (mockSocket as any).active = true; // 4.x：傳輸錯誤時 socket 仍會自動重試
  mockSocket.handlers["connect_error"](new Error("xhr poll error"));
  expect(handlers.onRefused).not.toHaveBeenCalled();

  (mockSocket as any).active = false; // 伺服器 handshake 拒絕：socket.io 不會重連
  mockSocket.handlers["connect_error"](new Error("Connection rejected by server"));
  expect(handlers.onRefused).toHaveBeenCalledTimes(1);
  delete (mockSocket as any).active;
});

test("開新一堂後，舊一堂 socket 的事件不會套到新的引擎上", async () => {
  await startClass();
  await createLiveSession(3); // 第二堂；第一堂的 socket 仍掛著 handler
  mockSocket.emit.mockClear();
  handlers.onState.mockClear();

  hello("S1", "dev-1");

  expect(mockSocket.emit).not.toHaveBeenCalled();
  expect(handlers.onState).not.toHaveBeenCalled();
});
