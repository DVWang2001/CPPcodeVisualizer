// 無感加載：IDE 頁面閒下來就在背景載入並暖機編譯器（localEngine.prewarm），之後的 Run 沿用同一個引擎。
(global as any)._ = require("lodash");
jest.mock("../SourceCode", () => ({ __esModule: true, default: {} }));
jest.mock("../Visualizer", () => ({ __esModule: true, default: {} }));
jest.mock("../VisualizerHelper", () => ({ __esModule: true, default: {} }));

import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import localEngine, { _test, emptyRunResult } from "../localEngine";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const SRC = "#include <iostream>\n#include <cmath>\nint main() { return 0; }\n";
const LOADING = /正在載入編譯器/;

function fakeGdb() {
  const g: any = {
    session: { pid: 4242 },
    socket: { on: () => undefined, emit: () => undefined, close: () => undefined },
    idle: () => Promise.resolve(),
    setRunToken: () => undefined,
    close: () => undefined,
  };
  return g;
}

function fakeModules(load?: () => Promise<any>) {
  const engine = {
    warmUp: jest.fn(() => Promise.resolve([])),
    runProgram: jest.fn(() => Promise.resolve({ ...emptyRunResult(), steps: [{ line: 3, fn: "main", depth: 1, frame: 1, vars: {} }] })),
    dispose: jest.fn(),
  };
  const okLoad = () => Promise.resolve(engine);
  const mods = {
    engine: { loadEngine: jest.fn(load || okLoad) },
    localgdb: { createLocalGdb: jest.fn(() => fakeGdb()), buildPrerunSnapshots: jest.fn(() => []) },
  };
  return { mods, engine, okLoad };
}

const warmState = () => document.documentElement.getAttribute("data-vgdb-warmup");
const setSaveData = (on: boolean) => Object.defineProperty(navigator, "connection", { value: on ? { saveData: true } : undefined, configurable: true });

beforeEach(() => {
  _test.reset();
  document.documentElement.removeAttribute("data-vgdb-warmup");
  setSaveData(false);
  (window as any).gdbgui_get_editor_value = () => SRC;
});

test("頁面閒下來就載入引擎，並用編輯器程式的 #include 暖機；之後的 Run 沿用同一個引擎，不再提示載入", async () => {
  expect(document.readyState).toBe("complete");
  const f = fakeModules();
  _test.setModules(f.mods as any);
  localEngine.prewarm();
  await flush();
  await flush();
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
  expect(f.engine.warmUp).toHaveBeenCalledWith({ source: SRC, preludes: [["iostream", "vector"]] });
  expect(warmState()).toBe("ready");
  const progress: string[] = [];
  const r = await localEngine.createAndUpload({ code: SRC }, (m) => progress.push(m));
  expect(r.status).toBe("success");
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
  expect(f.engine.runProgram).toHaveBeenCalledTimes(1);
  expect(progress).toEqual(["瀏覽器引擎：正在編譯並執行程式……"]);
});

test("只啟動一次；開啟省流量（Save-Data）時不暖機", async () => {
  const f = fakeModules();
  _test.setModules(f.mods as any);
  setSaveData(true);
  localEngine.prewarm();
  await flush();
  await flush();
  expect(f.mods.engine.loadEngine).not.toHaveBeenCalled();
  expect(warmState()).toBe("skipped");
  setSaveData(false);
  _test.reset();
  _test.setModules(f.mods as any);
  localEngine.prewarm();
  localEngine.prewarm();
  await flush();
  await flush();
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
  expect(f.engine.warmUp).toHaveBeenCalledTimes(1);
});

test("暖機還在載入編譯器時按 Run：Run 沿用它，並照常提示正在載入", async () => {
  let resolveEngine: (e: any) => void = () => undefined;
  const f = fakeModules(() => new Promise((r) => (resolveEngine = r)));
  _test.setModules(f.mods as any);
  localEngine.prewarm();
  await flush();
  await flush();
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
  expect(warmState()).toBe("loading");
  const progress: string[] = [];
  const run = localEngine.createAndUpload({ code: SRC }, (m) => progress.push(m));
  await flush();
  expect(progress.length).toBe(1);
  expect(progress[0]).toMatch(LOADING);
  resolveEngine(f.engine);
  const r = await run;
  expect(r.status).toBe("success");
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
});

test("Run 已經開始時，暖機不另外載入引擎、也不暖機", async () => {
  const f = fakeModules();
  _test.setModules(f.mods as any);
  const run = localEngine.createAndUpload({ code: SRC });
  localEngine.prewarm();
  await run;
  await flush();
  await flush();
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
  expect(f.engine.warmUp).not.toHaveBeenCalled();
  expect(warmState()).toBe("skipped");
});

test("暖機載入失敗不影響之後的 Run：Run 重新載入引擎並提示", async () => {
  let calls = 0;
  const f = fakeModules();
  f.mods.engine.loadEngine = jest.fn(() => (++calls === 1 ? Promise.reject(new Error("offline")) : f.okLoad()));
  _test.setModules(f.mods as any);
  localEngine.prewarm();
  await flush();
  await flush();
  const progress: string[] = [];
  const r = await localEngine.createAndUpload({ code: SRC }, (m) => progress.push(m));
  expect(r.status).toBe("success");
  expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(2);
  expect(progress[0]).toMatch(LOADING);
  expect(warmState()).toBe("failed");
});
