// 學生端經由中繼（thin relay）加入與作答。socket.io-client 以假 socket 取代，
// 事件契約見 task-3-report 的事件表與 task-5-report 的廣播形狀。
import * as React from "react";
import * as ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
import { loadDraft } from "../tableDraft";

type Handler = (...args: any[]) => void;
const mockSocket = {
  handlers: {} as { [event: string]: Handler },
  emit: jest.fn(),
  disconnect: jest.fn(),
  connect: jest.fn(),
  active: false,
  on(event: string, handler: Handler) {
    this.handlers[event] = handler;
    return this;
  }
};
jest.mock("socket.io-client", () => ({
  __esModule: true,
  default: { connect: jest.fn(() => mockSocket) }
}));
jest.mock("../../css/studentQuiz.css", () => ({}));

import io from "socket.io-client";
import StudentQuizApp, {
  ANSWER_ACK_TIMEOUT_MS,
  newDeviceId,
  tableResultClass
} from "../studentQuiz";

const DEVICE_KEY = "gdbgui_quiz_device";
const answer = [["0", "1"], ["1", "2"]];
let root: HTMLElement;

const choiceBroadcast = (state: "open" | "closed" = "open", id = "q1") => ({
  state: "active",
  session_id: 7,
  session_title: "迴圈課堂",
  active_question: {
    id,
    kind: "choice",
    prompt: "i 最後是多少？",
    options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    source_file: "main.cpp",
    line: 4,
    state,
    ...(state === "closed" ? { result: { correct_option_id: "b", explanation: "i++" } } : {})
  }
});

const tableBroadcast = (state: "open" | "closed" = "open") => ({
  state: "active",
  session_id: 7,
  session_title: "DP 課堂",
  active_question: {
    id: "table-1",
    kind: "table",
    prompt: "填完 dp",
    rows: 2,
    cols: 2,
    row_labels: ["i=0", "i=1"],
    col_labels: ["j=0", "j=1"],
    source_file: "main.cpp",
    line: 8,
    state,
    ...(state === "closed" ? { correct_values: answer, result: { explanation: "看轉移式。" } } : {})
  }
});

const mount = () => {
  act(() => {
    ReactDOM.render(
      React.createElement(StudentQuizApp, { data: { token: "tok-1", session_title: "課堂" } }),
      root
    );
  });
};

const fire = (event: string, payload?: any) => {
  act(() => { mockSocket.handlers[event](payload); });
};

const text = () => root.textContent || "";
const statusLine = () => root.querySelector(".status-line")!.textContent || "";
const button = (label: string) =>
  Array.from(root.querySelectorAll("button")).find(b => (b.textContent || "").includes(label))!;
const emitted = (event: string) =>
  mockSocket.emit.mock.calls.filter(call => call[0] === event).map(call => call[1]);

function storeDevice(nickname = "小明", device_id = "dev-1") {
  localStorage.setItem(DEVICE_KEY, JSON.stringify({ device_id, nickname }));
}

function joinWithNickname(nickname: string) {
  const input = root.querySelector("#quiz-nickname") as HTMLInputElement;
  act(() => { Simulate.change(input, { target: { value: nickname } } as any); });
  act(() => { Simulate.submit(root.querySelector("form")!); });
}

function submitChoice(optionId: string) {
  act(() => { Simulate.change(root.querySelector(`input[value="${optionId}"]`)!); });
  act(() => { Simulate.submit(root.querySelector("form")!); });
  act(() => { Simulate.click(button("確認送出")); });
}

function submitTable(values: string[][]) {
  values.forEach((line, row) => line.forEach((value, col) => {
    const input = root.querySelector(`input[name="cell-${row}-${col}"]`) as HTMLInputElement;
    input.value = value;
    act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  }));
  act(() => {
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  act(() => { Simulate.click(button("確認送出")); });
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  mockSocket.handlers = {};
  mockSocket.emit.mockClear();
  mockSocket.disconnect.mockClear();
  mockSocket.connect.mockClear();
  mockSocket.active = false;
  (io as any).connect.mockClear();
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  root.remove();
  jest.useRealTimers();
});

test("加入時以 auth.token 連線，連上後送 student:hello，帶 localStorage 的 device_id", () => {
  storeDevice("小明", "dev-1");
  mount();

  expect((io as any).connect).toHaveBeenCalledWith("/lesson_quiz", {
    auth: { role: "student", token: "tok-1" }
  });
  expect(emitted("student:hello")).toEqual([]);
  fire("connect");
  expect(emitted("student:hello")).toEqual([{ device_id: "dev-1", nickname: "小明" }]);
});

test("第一次加入：輸入暱稱後產生 device_id 存進 localStorage，hello 用同一個", () => {
  mount();
  expect((io as any).connect).not.toHaveBeenCalled();
  joinWithNickname("小華");

  const stored = JSON.parse(localStorage.getItem(DEVICE_KEY)!);
  expect(stored.nickname).toBe("小華");
  expect(stored.device_id).toMatch(/^[0-9a-f-]{36}$/);
  fire("connect");
  expect(emitted("student:hello")).toEqual([{ device_id: stored.device_id, nickname: "小華" }]);
});

test("重新整理後沿用同一個 device_id 與暱稱，不再詢問暱稱", () => {
  mount();
  joinWithNickname("小華");
  const first = JSON.parse(localStorage.getItem(DEVICE_KEY)!);
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  mockSocket.handlers = {};
  mockSocket.emit.mockClear();

  mount();

  expect(root.querySelector("#quiz-nickname")).toBeNull();
  fire("connect");
  expect(emitted("student:hello")).toEqual([{ device_id: first.device_id, nickname: "小華" }]);
  expect(JSON.parse(localStorage.getItem(DEVICE_KEY)!)).toEqual(first);
});

test("沒有 crypto.randomUUID（http 區網）時退回 Math.random 的 UUID v4", () => {
  const original = (global as any).crypto;
  Object.defineProperty(global, "crypto", { value: {}, configurable: true });
  try {
    const a = newDeviceId();
    const b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  } finally {
    Object.defineProperty(global, "crypto", { value: original, configurable: true });
  }
});

test("每次 connect（含斷線重連）與 relay:teacher-online 都重送 student:hello", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("relay:teacher-online", {});
  fire("connect");

  expect(emitted("student:hello")).toHaveLength(3);
  expect(new Set(emitted("student:hello").map(h => h.device_id))).toEqual(new Set(["dev-1"]));
});

test("送出答案後，收到相同 nonce 的 quiz:answer-received 才顯示已收到", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", choiceBroadcast());
  submitChoice("b");

  const sent = emitted("student:answer");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ device_id: "dev-1", question_key: "q1", answer: "b" });
  expect(typeof sent[0].nonce).toBe("string");
  expect(statusLine()).not.toContain("已收到");

  fire("quiz:answer-received", { nonce: "someone-else" });
  expect(statusLine()).not.toContain("已收到");

  fire("quiz:answer-received", { nonce: sent[0].nonce });
  expect(statusLine()).toContain("已收到");
  // 已收到之後，逾時計時器不能再把畫面改成未送達。
  act(() => { jest.advanceTimersByTime(ANSWER_ACK_TIMEOUT_MS + 1000); });
  expect(text()).not.toContain("答案未送達");
});

test("5 秒內沒收到回覆就顯示「老師連線中斷，答案未送達」，並可重送", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", choiceBroadcast());
  submitChoice("b");
  const first = emitted("student:answer")[0];

  act(() => { jest.advanceTimersByTime(ANSWER_ACK_TIMEOUT_MS - 1); });
  expect(text()).not.toContain("答案未送達");
  act(() => { jest.advanceTimersByTime(1); });
  expect(text()).toContain("老師連線中斷，答案未送達");
  expect(statusLine()).not.toContain("已收到");

  act(() => { Simulate.click(button("重送")); });
  const sent = emitted("student:answer");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ device_id: "dev-1", question_key: "q1", answer: "b" });
  expect(sent[1].nonce).not.toBe(first.nonce);

  // 舊 nonce 的遲到回覆不算數；新 nonce 才算。
  fire("quiz:answer-received", { nonce: first.nonce });
  expect(statusLine()).not.toContain("已收到");
  fire("quiz:answer-received", { nonce: sent[1].nonce });
  expect(statusLine()).toContain("已收到");
  expect(text()).not.toContain("答案未送達");
});

test("填表題：收到相同 nonce 的回覆才清草稿；逾時則草稿保留", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", tableBroadcast());
  submitTable(answer);
  const first = emitted("student:answer")[0];
  expect(first).toMatchObject({ question_key: "table-1", answer });
  expect(loadDraft("table-1", 2, 2)).toEqual(answer);

  act(() => { jest.advanceTimersByTime(ANSWER_ACK_TIMEOUT_MS); });
  expect(text()).toContain("答案未送達");
  expect(loadDraft("table-1", 2, 2)).toEqual(answer);

  act(() => { Simulate.click(button("重送")); });
  fire("quiz:answer-received", { nonce: emitted("student:answer")[1].nonce });
  expect(statusLine()).toContain("已收到");
  expect(loadDraft("table-1", 2, 2)).toEqual([["", ""], ["", ""]]);
});

test("收到 {state:'ended'} 顯示本次課堂已結束", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", choiceBroadcast());
  fire("quiz:student-state", { state: "ended" });

  expect(statusLine()).toContain("本次課堂已結束");
});

test("token 被拒絕（connect_error）時顯示課堂不存在或已結束，不無限重連", () => {
  storeDevice();
  mount();
  fire("connect_error", new Error("refused"));

  expect(text()).toContain("課堂不存在或已結束");
  expect(mockSocket.disconnect).toHaveBeenCalled();
});

test("網路層連線錯誤（TransportError）只顯示重新連線中，不當成 token 被拒", () => {
  storeDevice();
  mount();
  fire("quiz:student-state", choiceBroadcast());
  const error: any = new Error("xhr poll error");
  error.type = "TransportError";
  fire("connect_error", error);

  expect(text()).not.toContain("課堂不存在或已結束");
  expect(mockSocket.disconnect).not.toHaveBeenCalled();
  expect(statusLine()).toContain("重新連線");
});

test("收卷後送出的填表題：顯示已收卷，草稿保留", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", tableBroadcast());
  submitTable(answer);
  // 老師端因為已收卷而拒絕（409）：沒有 answer-received，只有一份刷新後的狀態。
  fire("quiz:student-state", tableBroadcast("closed"));

  expect(text()).toContain("已收卷");
  expect(text()).not.toContain("課堂不存在");
  expect(loadDraft("table-1", 2, 2)).toEqual(answer);
  act(() => { jest.advanceTimersByTime(ANSWER_ACK_TIMEOUT_MS * 2); });
  expect(text()).not.toContain("答案未送達");
});

test("答案確認前收到全班廣播（同一題仍開放）不會取消等待，也不洗掉選擇", () => {
  storeDevice();
  mount();
  fire("connect");
  fire("quiz:student-state", choiceBroadcast());
  submitChoice("b");
  fire("quiz:student-state", choiceBroadcast());
  const nonce = emitted("student:answer")[0].nonce;

  expect((root.querySelector('input[value="b"]') as HTMLInputElement).checked).toBe(true);
  act(() => { jest.advanceTimersByTime(ANSWER_ACK_TIMEOUT_MS); });
  expect(text()).toContain("答案未送達");
  fire("quiz:answer-received", { nonce });
  expect(statusLine()).toContain("已收到");
  // 已作答後再收到同題廣播，仍是已作答。
  fire("quiz:student-state", choiceBroadcast());
  expect(statusLine()).toContain("已收到");
  expect((root.querySelector('input[value="b"]') as HTMLInputElement).checked).toBe(true);
});

test("不把 token 或答案寫進 console", () => {
  const spies = ["log", "info", "warn", "error", "debug"].map(name => jest.spyOn(console, name as any).mockImplementation(() => undefined));
  try {
    storeDevice();
    mount();
    fire("connect");
    fire("quiz:student-state", choiceBroadcast());
    submitChoice("b");
    fire("connect_error", new Error("refused"));
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  } finally {
    spies.forEach(spy => spy.mockRestore());
  }
});

test("unanswered table result stays neutral instead of comparing null counts equal", () => {
  expect(tableResultClass({ correct_cells: null, total_cells: null, explanation: "" })).toBe("");
  expect(tableResultClass({ correct_cells: 0, total_cells: 4, explanation: "" })).toBe("is-wrong");
  expect(tableResultClass({ correct_cells: 4, total_cells: 4, explanation: "" })).toBe("is-correct");
});

test("暱稱含控制字元（如 Tab）時不寫 localStorage、不連線，按鈕停用並說明原因", () => {
  mount();
  const setItem = jest.spyOn(Storage.prototype, "setItem");
  try {
    const input = root.querySelector("#quiz-nickname") as HTMLInputElement;
    act(() => { Simulate.change(input, { target: { value: "小\t明" } } as any); });
    expect((root.querySelector("button.primary-action") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("控制字元");
    act(() => { Simulate.submit(root.querySelector("form")!); });

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect((io as any).connect).not.toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
});

test("DEL(127) 與超過 50 個字元的暱稱同樣被擋下", () => {
  mount();
  const input = root.querySelector("#quiz-nickname") as HTMLInputElement;
  for (const bad of ["a\u007fb", "x".repeat(51)]) {
    act(() => { Simulate.change(input, { target: { value: bad } } as any); });
    act(() => { Simulate.submit(root.querySelector("form")!); });
  }
  expect((io as any).connect).not.toHaveBeenCalled();
  expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
});

test("localStorage 裡的暱稱不合規則（舊版寫入或手改）時視為沒有，重新顯示暱稱表單", () => {
  storeDevice("小\t明", "dev-1");
  mount();

  expect(root.querySelector("#quiz-nickname")).not.toBeNull();
  expect((io as any).connect).not.toHaveBeenCalled();
});
