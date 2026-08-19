import * as React from "react";
import * as ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
jest.mock("../../css/liveQuiz.css", () => ({}));
jest.mock("../liveQuizClient", () => ({
  closeLiveQuestion: jest.fn(),
  connectTeacherQuizSocket: jest.fn(() => jest.fn()),
  createLiveSession: jest.fn(),
  endLiveSession: jest.fn(),
  getLiveSession: jest.fn(),
  triggerLiveQuestion: jest.fn()
}));

import LiveQuizPanel, { closeQuizContainer, restoreQuizContainer, TableTriggerConfirm } from "../LiveQuizPanel";
import { lessonQuizRuntime, PendingTable } from "../lessonQuizRuntime";
import { global_variable } from "../global_variable";
import * as liveQuizClient from "../liveQuizClient";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

const pending: PendingTable = {
  questionId: "q1",
  sourceFile: "main.cpp",
  line: 3,
  tableSpec: { var_hint: "dp", max_cells: 20 }
};
const panelSession = () => ({
  id: 7,
  lesson_id: 2,
  lesson_version: 1,
  state: "lobby",
  join_url: "http://localhost/join",
  qr_url: "qr",
  questions: [{
    id: "q1", state: "ready", kind: "table", prompt: "填 dp",
    source_file: "main.cpp", line: 3,
    table_spec: { var_hint: "dp", max_cells: 20 }
  }],
  active_question: null
});
let root: HTMLDivElement;

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  (global_variable as any).__latest_containers = new Map();
  sessionStorage.clear();
  lessonQuizRuntime.deactivate();
  jest.clearAllMocks();
});

afterEach(() => {
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  root.remove();
});

function render(onConfirm = jest.fn()) {
  act(() => {
    ReactDOM.render(
      React.createElement(TableTriggerConfirm, { pending, busy: false, onConfirm }),
      root
    );
  });
  return onConfirm;
}

async function mountPanel(session = panelSession()) {
  (liveQuizClient.getLiveSession as jest.Mock).mockResolvedValue(session);
  sessionStorage.setItem("gdbgui_live_quiz_session_id", "7");
  await act(async () => {
    ReactDOM.render(React.createElement(LiveQuizPanel, {
      lessonId: 2,
      startError: () => null,
      prepareVersion: () => Promise.resolve(),
      onSessionEnded: () => Promise.resolve(),
      onClose: jest.fn()
    }), root);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
  act(() => { lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 }); });
}

test("no captured container disables confirmation with the required message", () => {
  render();

  expect(root.textContent).toContain("程式需先停在容器有值的位置");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
});

test("capture choices refresh when the paused debugger publishes containers", () => {
  jest.useFakeTimers();
  render();
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[5]] }]]);

  act(() => { jest.advanceTimersByTime(1000); });

  expect((root.querySelector("select") as HTMLSelectElement).value).toBe("dp");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  jest.useRealTimers();
});

test("preferred variable previews a valid table and confirms it explicitly", () => {
  (global_variable as any).__latest_containers = new Map([
    ["other", { values: [["9"]] }],
    ["dp", { values: [[1, 2], [3, 4]] }]
  ]);
  const onConfirm = render();

  expect((root.querySelector("select") as HTMLSelectElement).value).toBe("dp");
  expect(root.textContent).toContain("1");
  expect(root.textContent).toContain("4");
  act(() => Simulate.click(root.querySelector("button")!));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ rows: 2, cols: 2 }), "dp");
});

test("invalid selected container shows the capture reason verbatim and never confirms", () => {
  (global_variable as any).__latest_containers = new Map([
    ["flat", { values: [1, 2] }],
    ["matrix", { values: [[7]] }]
  ]);
  const onConfirm = render();
  const select = root.querySelector("select") as HTMLSelectElement;

  act(() => Simulate.change(select, { target: { value: "flat" } } as any));

  expect(root.textContent).toContain("填表題需要二維容器，這個是一維的。");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("container visibility is restored only when the quiz flow closed an open panel", () => {
  const open = jest.fn();
  const close = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close }
  };

  const changed = closeQuizContainer();
  restoreQuizContainer(changed);

  expect(close).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);

  close.mockClear();
  open.mockClear();
  (window as any).gdbgui_collapser_registry.container.isOpen = () => false;
  restoreQuizContainer(closeQuizContainer());
  expect(close).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

test("table POST hides preview and container, then HTTP 400 restores both for retry", async () => {
  let rejectTrigger!: (reason: Error) => void;
  const triggerPromise = new Promise<any>((_, reject) => { rejectTrigger = reject; });
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  const close = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close }
  };
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockImplementation(() => {
    expect(close).toHaveBeenCalledTimes(1);
    expect(root.querySelector("select")).toBeNull();
    return triggerPromise;
  });
  await mountPanel();

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });

  expect(root.querySelector("select")).toBeNull();
  const rejected: any = new Error("invalid");
  rejected.status = 400;
  rejectTrigger(rejected);
  await act(async () => { await triggerPromise.catch(() => undefined); await Promise.resolve(); });
  expect(root.querySelector("select")).not.toBeNull();
  expect(open).toHaveBeenCalledTimes(1);
});

test("a socket-open snapshot before a statusless rejection keeps the table hidden", async () => {
  let rejectTrigger!: (reason: Error) => void;
  const triggerPromise = new Promise<any>((_, reject) => { rejectTrigger = reject; });
  const session = panelSession();
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockReturnValue(triggerPromise);
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close: jest.fn() }
  };
  await mountPanel(session);

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  const opened = {
    ...session,
    questions: [{ ...session.questions[0], state: "open" }],
    active_question: { ...session.questions[0], state: "open" }
  };
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(opened);
  });
  rejectTrigger(new Error("offline"));
  await act(async () => { await triggerPromise.catch(() => undefined); await Promise.resolve(); });

  expect(open).not.toHaveBeenCalled();
  expect((window as any).gdbgui_table_quiz_hides_container).toBe(true);
});

test("an unrelated ready socket snapshot cannot reveal a table while its POST is pending", async () => {
  const triggerPromise = new Promise<any>(() => undefined);
  const session = panelSession();
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockReturnValue(triggerPromise);
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close: jest.fn() }
  };
  await mountPanel(session);

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(session);
  });

  expect(open).not.toHaveBeenCalled();
  expect(root.querySelector("select")).toBeNull();
});

test("a socket-open snapshot during statusless rejection reconciliation prevents stale restore", async () => {
  let rejectTrigger!: (reason: Error) => void;
  let resolveReconcile!: (session: any) => void;
  const triggerPromise = new Promise<any>((_, reject) => { rejectTrigger = reject; });
  const reconcilePromise = new Promise<any>(resolve => { resolveReconcile = resolve; });
  const session = panelSession();
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockReturnValue(triggerPromise);
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close: jest.fn() }
  };
  await mountPanel(session);
  (liveQuizClient.getLiveSession as jest.Mock).mockReturnValue(reconcilePromise);

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  rejectTrigger(new Error("offline"));
  await act(async () => { await triggerPromise.catch(() => undefined); await Promise.resolve(); });
  expect(open).not.toHaveBeenCalled();

  const opened = {
    ...session,
    questions: [{ ...session.questions[0], state: "open" }],
    active_question: { ...session.questions[0], state: "open" }
  };
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(opened);
  });
  resolveReconcile(session);
  await act(async () => { await reconcilePromise; await Promise.resolve(); });

  expect(open).not.toHaveBeenCalled();
  expect((window as any).gdbgui_table_quiz_hides_container).toBe(true);
});

test("a ready join snapshot cannot reveal a reconciled uncertain trigger before delayed open", async () => {
  let rejectTrigger!: (reason: Error) => void;
  const triggerPromise = new Promise<any>((_, reject) => { rejectTrigger = reject; });
  const session = panelSession();
  (liveQuizClient.triggerLiveQuestion as jest.Mock)
    .mockReturnValueOnce(triggerPromise)
    .mockReturnValueOnce(new Promise<any>(() => undefined));
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close: jest.fn() }
  };
  await mountPanel(session);

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  rejectTrigger(new Error("offline"));
  await act(async () => {
    await triggerPromise.catch(() => undefined);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

  const retry = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "重試")!;
  expect(retry).toBeDefined();
  expect(root.querySelector("select")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(session);
  });
  expect(root.querySelector("select")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(root.textContent).toContain("重試");

  act(() => { Simulate.click(retry); });
  await act(async () => { await Promise.resolve(); });
  expect(liveQuizClient.triggerLiveQuestion).toHaveBeenCalledTimes(2);

  const opened = {
    ...session,
    questions: [{ ...session.questions[0], state: "open" }],
    active_question: { ...session.questions[0], state: "open" }
  };
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(opened);
  });
  expect(open).not.toHaveBeenCalled();
  expect(root.textContent).not.toContain("重試");
});

test("HTTP 409 stays hidden until a socket snapshot reveals the other open question", async () => {
  let rejectTrigger!: (reason: Error) => void;
  let resolveReconcile!: (session: any) => void;
  const triggerPromise = new Promise<any>((_, reject) => { rejectTrigger = reject; });
  const reconcilePromise = new Promise<any>(resolve => { resolveReconcile = resolve; });
  const session = panelSession();
  const second = {
    id: "q2", state: "ready", kind: "choice", prompt: "另一題",
    source_file: "main.cpp", line: 8
  };
  session.questions.push(second as any);
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockReturnValue(triggerPromise);
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close: jest.fn() }
  };
  await mountPanel(session);
  (liveQuizClient.getLiveSession as jest.Mock).mockReturnValue(reconcilePromise);

  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  const conflict: any = new Error("conflict");
  conflict.status = 409;
  rejectTrigger(conflict);
  await act(async () => {
    await triggerPromise.catch(() => undefined);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(open).not.toHaveBeenCalled();
  expect(root.querySelector("select")).toBeNull();
  expect(liveQuizClient.getLiveSession).toHaveBeenCalledTimes(3);

  const otherOpened = {
    ...session,
    questions: [session.questions[0], { ...second, state: "open" }],
    active_question: { ...second, state: "open" }
  };
  act(() => {
    (liveQuizClient.connectTeacherQuizSocket as jest.Mock).mock.calls[0][1].onState(otherOpened);
  });
  resolveReconcile(otherOpened);
  await act(async () => { await reconcilePromise; await Promise.resolve(); });

  expect(open).not.toHaveBeenCalled();
  expect(root.textContent).not.toContain("重試");
  expect(root.textContent).toContain("另一題");
});

test("a late successful trigger cannot hide the container after panel cleanup", async () => {
  let resolveTrigger!: (session: any) => void;
  const triggerPromise = new Promise<any>(resolve => { resolveTrigger = resolve; });
  const session = panelSession();
  (liveQuizClient.triggerLiveQuestion as jest.Mock).mockReturnValue(triggerPromise);
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[1]] }]]);
  const close = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open: jest.fn(), close }
  };

  await mountPanel(session);
  const confirm = Array.from(root.querySelectorAll("button"))
    .find(button => button.textContent === "確認出題")!;
  act(() => { Simulate.click(confirm); });
  await act(async () => { await Promise.resolve(); });
  expect(liveQuizClient.triggerLiveQuestion).toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);

  act(() => { ReactDOM.unmountComponentAtNode(root); });
  resolveTrigger({ ...session, active_question: { id: "q1", state: "open", kind: "table" } });
  await act(async () => { await triggerPromise; await Promise.resolve(); });

  expect(close).toHaveBeenCalledTimes(1);
});

// ── restart 開新課堂 ──────────────────────────────────────────────────────
//
// 使用者選定的行為：每按一次「重新執行」就換一堂新課（新 session、新 QR）。
// 已加入的學生會被踢出、必須重掃，所以開好之後要主動把 QR 放大層彈出來。

test("restart 會結束舊課堂並建立新的", async () => {
  await mountPanel();
  (liveQuizClient.endLiveSession as jest.Mock).mockResolvedValue({ ...panelSession(), state: "ended" });
  (liveQuizClient.createLiveSession as jest.Mock).mockResolvedValue({ ...panelSession(), id: 8 });

  await act(async () => {
    await (window as any).gdbgui_live_quiz_restart();
  });

  expect(liveQuizClient.endLiveSession).toHaveBeenCalledWith(7);
  expect(liveQuizClient.createLiveSession).toHaveBeenCalledWith(2);
});

test("面板卸載後 restart 橋接不再存在", async () => {
  await mountPanel();
  expect(typeof (window as any).gdbgui_live_quiz_restart).toBe("function");

  act(() => { ReactDOM.unmountComponentAtNode(root); });

  expect((window as any).gdbgui_live_quiz_restart).toBeUndefined();
});
