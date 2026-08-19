import { isQuizPlaybackBlocked, lessonQuizRuntime } from "../lessonQuizRuntime";
import Actions from "../Actions";
import GdbApi from "../GdbApi";
import VisualizerHelper from "../VisualizerHelper";
import initialStoreData from "../InitialStoreData";
import { store } from "statorgfc";
import { global_variable } from "../global_variable";

jest.mock("../SourceCode", () => ({
  __esModule: true,
  default: { make_current_line_visible: jest.fn(() => true) }
}));
jest.mock("../process_gdb_response", () => ({ __esModule: true, default: jest.fn() }));

const session = () => ({
  id: 7,
  state: "lobby",
  questions: [{
    id: "q1",
    state: "ready",
    source_file: "main.cpp",
    line: 3,
    anchor: { line_text: "i++;", before_text: "int i = 0;", after_text: "return i;" }
  }],
  active_question: null
});

const tableSession = () => ({
  ...session(),
  questions: [{
    ...session().questions[0],
    kind: "table",
    table_spec: { var_hint: "dp", max_cells: 20 }
  }]
});

function pendingPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

beforeEach(() => {
  lessonQuizRuntime.deactivate();
  store.set("quiz_playback_gate", false);
  store.set("autoplay_enabled", true);
  store.set("autoplay_paused", false);
  jest.restoreAllMocks();
});

test("opens the gate synchronously before trigger promise settles", () => {
  const deferred = pendingPromise<any>();
  const setGate = jest.fn();
  const trigger = jest.fn(() => deferred.promise);
  lessonQuizRuntime.activate(session(), { trigger, setGate });

  expect(lessonQuizRuntime.onGdbPause({ fullname: "/tmp/main.cpp", line: "3" })).toBe(true);
  expect(setGate).toHaveBeenLastCalledWith(true);
  expect(trigger).toHaveBeenCalledWith(7, "q1", "main.cpp", 3);
  expect(lessonQuizRuntime.onGdbPause({ fullname: "/tmp/main.cpp", line: "3" })).toBe(false);
});

test("a table match closes the gate without posting until confirmation", () => {
  const trigger = jest.fn();
  const setGate = jest.fn();
  lessonQuizRuntime.activate(tableSession(), { trigger, setGate });

  expect(lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 })).toBe(true);
  expect(setGate).toHaveBeenLastCalledWith(true);
  expect(trigger).not.toHaveBeenCalled();
  expect(lessonQuizRuntime.state().pendingTable).toMatchObject({
    questionId: "q1",
    sourceFile: "main.cpp",
    line: 3,
    tableSpec: { var_hint: "dp", max_cells: 20 }
  });
});

test("confirming a table sends the captured answer and selected variable", () => {
  const deferred = pendingPromise<any>();
  const trigger = jest.fn(() => deferred.promise);
  lessonQuizRuntime.activate(tableSession(), { trigger, setGate: jest.fn() });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });
  const table = {
    rows: 1, cols: 2, row_labels: ["0"], col_labels: ["0", "1"], values: [["1", "2"]]
  };

  expect(lessonQuizRuntime.confirmTable(table, "dp")).toBe(true);
  expect(trigger).toHaveBeenCalledWith(7, "q1", "main.cpp", 3, { table, var_hint: "dp" });
});

test("a failed table trigger retains the capture and retry sends it again", async () => {
  const table = {
    rows: 1, cols: 1, row_labels: ["0"], col_labels: ["0"], values: [["1"]]
  };
  const trigger = jest.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...tableSession(), questions: [{ id: "q1", state: "open" }] });
  lessonQuizRuntime.activate(tableSession(), { trigger, setGate: jest.fn() });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });
  lessonQuizRuntime.confirmTable(table, "memo");
  await Promise.resolve();
  await Promise.resolve();

  expect(lessonQuizRuntime.state().pendingTable).not.toBeNull();
  expect(lessonQuizRuntime.retryTrigger()).toBe(true);
  expect(trigger).toHaveBeenLastCalledWith(7, "q1", "main.cpp", 3, { table, var_hint: "memo" });
});

test("deactivation clears a pending table capture", () => {
  lessonQuizRuntime.activate(tableSession(), { trigger: jest.fn(), setGate: jest.fn() });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });

  lessonQuizRuntime.deactivate();

  expect(lessonQuizRuntime.state().pendingTable).toBeNull();
});

test("lobby socket updates keep a pending table selection stable", () => {
  lessonQuizRuntime.activate(tableSession(), { trigger: jest.fn(), setGate: jest.fn() });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });

  lessonQuizRuntime.syncSession({ ...tableSession(), joined_count: 4 });

  expect(lessonQuizRuntime.state().blocked).toBe(true);
  expect(lessonQuizRuntime.state().pendingTable!.questionId).toBe("q1");
});

test("an open socket snapshot clears a stale pending table selection", () => {
  lessonQuizRuntime.activate(tableSession(), { trigger: jest.fn(), setGate: jest.fn() });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });

  lessonQuizRuntime.syncSession({
    ...tableSession(),
    active_question: { id: "q1", state: "open" },
    questions: [{ ...tableSession().questions[0], state: "open" }]
  });

  expect(lessonQuizRuntime.state().pendingTable).toBeNull();
  expect(lessonQuizRuntime.state().blocked).toBe(true);
});

test.each(["closed", "ended"])("a server %s snapshot releases a pending table gate", state => {
  const setGate = jest.fn();
  lessonQuizRuntime.activate(tableSession(), { trigger: jest.fn(), setGate });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });

  lessonQuizRuntime.syncSession({
    ...tableSession(),
    state: state === "ended" ? "ended" : "lobby",
    questions: [{ ...tableSession().questions[0], state }]
  });

  expect(lessonQuizRuntime.state().pendingTable).toBeNull();
  expect(lessonQuizRuntime.state().blocked).toBe(false);
  expect(setGate).toHaveBeenLastCalledWith(false);
});

test("failed trigger keeps the gate and exposes retry", async () => {
  const setGate = jest.fn();
  const trigger = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...session(), questions: [{ id: "q1", state: "open" }] });
  lessonQuizRuntime.activate(session(), { trigger, setGate });
  setGate.mockClear();
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });
  await Promise.resolve();
  await Promise.resolve();

  expect(lessonQuizRuntime.state().error).toContain("無法開啟題目");
  expect(setGate).not.toHaveBeenCalledWith(false);
  expect(lessonQuizRuntime.retryTrigger()).toBe(true);
  expect(trigger).toHaveBeenCalledTimes(2);
});

test("only a successful close or deactivation clears the playback gate", () => {
  const setGate = jest.fn();
  lessonQuizRuntime.activate(session(), {
    trigger: jest.fn(() => Promise.resolve(session())),
    setGate
  });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });
  setGate.mockClear();

  lessonQuizRuntime.questionClosed({
    ...session(),
    questions: [{ id: "q1", state: "closed" }]
  });
  expect(setGate).toHaveBeenCalledWith(false);
  expect(lessonQuizRuntime.state().blocked).toBe(false);

  lessonQuizRuntime.deactivate();
  expect(setGate).toHaveBeenLastCalledWith(false);
});

test("restart clears a stuck gate without abandoning the live session", () => {
  const setGate = jest.fn();
  lessonQuizRuntime.activate(session(), {
    trigger: jest.fn(() => new Promise<any>(() => undefined)),
    setGate
  });
  lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 });

  lessonQuizRuntime.clearGate();

  expect(setGate).toHaveBeenLastCalledWith(false);
  expect(lessonQuizRuntime.state().blocked).toBe(false);
  expect(lessonQuizRuntime.state().active).toBe(true);
});

test("recovering an open question restores the playback gate", () => {
  const setGate = jest.fn();
  lessonQuizRuntime.activate(
    {
      ...session(),
      active_question: { id: "q1", state: "open" },
      questions: [{ id: "q1", state: "open" }]
    },
    { trigger: jest.fn(), setGate }
  );

  expect(setGate).toHaveBeenLastCalledWith(true);
  expect(lessonQuizRuntime.state().blocked).toBe(true);

  lessonQuizRuntime.syncSession({
    ...session(),
    active_question: null,
    questions: [{ id: "q1", state: "closed" }]
  });
  expect(setGate).toHaveBeenLastCalledWith(false);
  expect(lessonQuizRuntime.state().blocked).toBe(false);
});

test("recovery derives triggers from the immutable session snapshot", () => {
  const setGate = jest.fn();
  const trigger = jest.fn(() => Promise.resolve(session()));

  lessonQuizRuntime.activate(session(), { trigger, setGate });

  expect(lessonQuizRuntime.onGdbPause({ fullname: "main.cpp", line: 3 })).toBe(true);
  expect(trigger).toHaveBeenCalledWith(7, "q1", "main.cpp", 3);
});

test("gate helper treats only an explicit true store value as blocked", () => {
  expect(isQuizPlaybackBlocked({ get: () => true })).toBe(true);
  expect(isQuizPlaybackBlocked({ get: () => false })).toBe(false);
  expect(isQuizPlaybackBlocked({ get: () => undefined })).toBe(false);
});

test("a matched pause suppresses narration", () => {
  jest.spyOn(lessonQuizRuntime, "onGdbPause").mockReturnValue(true);
  const narration = jest.spyOn(VisualizerHelper, "play_tts").mockImplementation(() =>
    Promise.resolve()
  );
  jest.spyOn(VisualizerHelper, "processing_guide").mockImplementation(() => undefined);
  jest.spyOn(VisualizerHelper, "detect_container_op").mockImplementation(() => undefined);
  const SourceCode = require("../SourceCode").default;
  jest.spyOn(SourceCode, "make_current_line_visible").mockImplementation(() => true);
  jest.spyOn(Actions, "refresh_state_for_gdb_pause").mockImplementation(() => undefined);

  Actions.inferior_program_paused({ fullname: "/tmp/main.cpp", line: "3", func: "main" });

  expect(narration).not.toHaveBeenCalled();
});

test("a table pause clears stale containers before current-stop processing", () => {
  lessonQuizRuntime.activate(tableSession(), { trigger: jest.fn(), setGate: jest.fn() });
  (global_variable as any).__latest_containers = new Map([["stale", { values: [[0]] }]]);
  const processing = jest.spyOn(VisualizerHelper, "processing_guide").mockImplementation(() => {
    expect((global_variable as any).__latest_containers.size).toBe(0);
    (global_variable as any).__latest_containers.set("dp", { values: [[1]] });
  });
  jest.spyOn(VisualizerHelper, "detect_container_op").mockImplementation(() => undefined);
  jest.spyOn(VisualizerHelper, "play_tts").mockImplementation(() => Promise.resolve());
  jest.spyOn(Actions, "refresh_state_for_gdb_pause").mockImplementation(() => undefined);
  jest.spyOn(require("../SourceCode").default, "make_current_line_visible").mockImplementation(() => true);

  Actions.inferior_program_paused({ fullname: "main.cpp", line: 3, func: "main" });

  expect(processing).toHaveBeenCalled();
  expect(Array.from((global_variable as any).__latest_containers.keys())).toEqual(["dp"]);
});

test("a choice pause keeps the latest container snapshot", () => {
  lessonQuizRuntime.activate(session(), {
    trigger: jest.fn(() => new Promise<any>(() => undefined)),
    setGate: jest.fn()
  });
  const stale = new Map([["keep", { values: [[0]] }]]);
  (global_variable as any).__latest_containers = stale;
  jest.spyOn(VisualizerHelper, "processing_guide").mockImplementation(() => undefined);
  jest.spyOn(VisualizerHelper, "detect_container_op").mockImplementation(() => undefined);
  jest.spyOn(Actions, "refresh_state_for_gdb_pause").mockImplementation(() => undefined);
  jest.spyOn(require("../SourceCode").default, "make_current_line_visible").mockImplementation(() => true);

  Actions.inferior_program_paused({ fullname: "main.cpp", line: 3, func: "main" });

  expect((global_variable as any).__latest_containers).toBe(stale);
});

test.each([
  "click_continue_button",
  "click_next_button",
  "click_step_button",
  "click_return_button"
])("%s sends no command while the quiz gate is closed", name => {
  store.set("quiz_playback_gate", true);
  const send = jest.spyOn(GdbApi, "run_gdb_command").mockImplementation(() => undefined);
  const resume = jest.spyOn(Actions, "inferior_program_resuming").mockImplementation(() => undefined);

  (GdbApi as any)[name]();

  expect(send).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test("autoplay rechecks the gate after an animation barrier", async () => {
  jest.useFakeTimers();
  const deferred = pendingPromise<void>();
  const advance = jest.spyOn(GdbApi, "click_next_button").mockImplementation(() => undefined);
  (window as any).gdbgui_bst_anim_done = deferred.promise;

  (window as any).gdbgui_execute_autoplay_command("next");
  jest.runOnlyPendingTimers();
  store.set("quiz_playback_gate", true);
  deferred.resolve(undefined);
  await Promise.resolve();
  await Promise.resolve();

  expect(advance).not.toHaveBeenCalled();
  jest.useRealTimers();
});
