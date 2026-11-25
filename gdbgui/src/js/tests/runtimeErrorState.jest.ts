// 執行錯誤圖解（P2）的接線：停點帶著錯誤時，右側欄「執行錯誤」要勾選並展開、自動播放要停住；
// 之後的停點沒有錯誤時面板留著、錯誤行的標記拿掉；重新執行時清空。
(global as any)._ = require("lodash");
jest.mock("../SourceCode", () => ({ __esModule: true, default: {} }));
jest.mock("../Visualizer", () => ({ __esModule: true, default: {} }));
jest.mock("../VisualizerHelper", () => ({ __esModule: true, default: {} }));
jest.mock("../localEngine", () => {
  // 面板用的是「畫面顯示哪一步」（currentViewStep）；這裡兩個用同一個假函式，各測試照舊只設一個值
  const step = jest.fn();
  return { __esModule: true, runtimeErrorRun: jest.fn(), currentStepIndex: step, currentViewStep: step };
});

import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import Actions from "../Actions";
import process_gdb_response from "../process_gdb_response";
import * as localEngine from "../localEngine";
import { noteRuntimeStop, resetRuntimeErrors } from "../runtimeErrorState";
import LineAfterPanel from "../LineAfterPanel";

const FIX = require("./fixtures/runtimeRuns.json");
function runOf(id: string): any {
  const r = FIX.runs[id];
  const steps: any[] = new Array(r.nSteps);
  r.steps.forEach((p: [number, any]) => {
    steps[p[0]] = p[1];
  });
  return { errors: r.runtimeErrors, exit: r.exit, steps, source: r.src, functions: r.functions, decls: r.decls, classes: r.classes };
}

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

const runMock = (localEngine as any).runtimeErrorRun as jest.Mock;
const stepMock = (localEngine as any).currentStepIndex as jest.Mock;
const frame = { line: "10", fullname: "/workspace/main.cpp", file: "main.cpp", func: "factorial", addr: "0x1", level: "0", arch: "wasm32", args: [] };
let registry: any;

beforeEach(() => {
  runMock.mockReset();
  stepMock.mockReset();
  registry = { runtime_errors: { open: jest.fn(), close: jest.fn() } };
  (window as any).gdbgui_collapser_registry = registry;
  store.set("runtime_error", null);
  store.set("sidebar_selection", { runtime_errors: false, line_after: true });
  store.set("autoplay_enabled", true);
  store.set("autoplay_paused", false);
});

describe("noteRuntimeStop", () => {
  test("停在可繼續的錯誤：store 記下圖解，面板勾選並展開，自動播放暫停", () => {
    runMock.mockReturnValue(runOf("ex_err_int_overflow"));
    stepMock.mockReturnValue(48);
    noteRuntimeStop({ reason: "runtime-error", "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, frame });
    const rt = store.get("runtime_error");
    expect(rt).toMatchObject({ which: 0, here: true, stepNow: 48 });
    expect(rt.diag.kind).toBe("signed-overflow");
    expect(store.get("sidebar_selection").runtime_errors).toBe(true);
    expect(registry.runtime_errors.open).toHaveBeenCalled();
    expect(store.get("autoplay_paused")).toBe(true);
  });

  test("之後的停點沒有錯誤：面板留著，錯誤行的標記拿掉", () => {
    runMock.mockReturnValue(runOf("ex_err_int_overflow"));
    stepMock.mockReturnValue(48);
    noteRuntimeStop({ reason: "runtime-error", "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, frame });
    stepMock.mockReturnValue(49);
    noteRuntimeStop({ reason: "end-stepping-range", frame });
    const rt = store.get("runtime_error");
    expect(rt).toMatchObject({ which: 0, here: false, stepNow: 49 });
    expect(rt.ended).toBeFalsy();
    expect(rt.diag.kind).toBe("signed-overflow");
  });

  test("程式跑完（exited）：圖解留著、面板不收，記下程式已經結束", () => {
    runMock.mockReturnValue(runOf("ex_err_array_oob"));
    stepMock.mockReturnValue(11);
    noteRuntimeStop({ reason: "runtime-error", "runtime-error": { index: "0", kind: "array-bounds", fatal: "n" }, frame });
    stepMock.mockReturnValue(null);
    noteRuntimeStop({ reason: "exited-normally" });
    const rt = store.get("runtime_error");
    expect(rt).toMatchObject({ which: 0, here: false, ended: true });
    expect(rt.diag.kind).toBe("array-bounds");
    expect(registry.runtime_errors.close).not.toHaveBeenCalled();
  });

  test("堆疊用完：訊號停點，加上這次執行的 exit 是 stack-overflow", () => {
    runMock.mockReturnValue(runOf("inf_recursion"));
    stepMock.mockReturnValue(62127);
    noteRuntimeStop({ reason: "signal-received", "signal-name": "SIGSEGV", "signal-meaning": "Segmentation fault", frame });
    const rt = store.get("runtime_error");
    expect(rt).toMatchObject({ which: "stack-overflow", here: true });
    expect(rt.diag.kind).toBe("stack-overflow");
  });

  test("沒有錯誤的停點、也沒有先前的錯誤：什麼都不做", () => {
    runMock.mockReturnValue(runOf("ex_err_int_overflow"));
    stepMock.mockReturnValue(3);
    noteRuntimeStop({ reason: "end-stepping-range", frame });
    expect(store.get("runtime_error")).toBeNull();
    expect(registry.runtime_errors.open).not.toHaveBeenCalled();
  });

  test("沒開自動播放：不動暫停狀態", () => {
    store.set("autoplay_enabled", false);
    runMock.mockReturnValue(runOf("div0_input"));
    stepMock.mockReturnValue(1);
    noteRuntimeStop({ reason: "signal-received", "signal-name": "SIGFPE", "runtime-error": { index: "0", kind: "div-by-zero", fatal: "y" }, frame });
    expect(store.get("runtime_error").diag.kind).toBe("div-by-zero");
    expect(store.get("autoplay_paused")).toBe(false);
  });

  test("重新執行：清掉錯誤並收起面板", () => {
    runMock.mockReturnValue(runOf("div0_input"));
    stepMock.mockReturnValue(1);
    noteRuntimeStop({ reason: "signal-received", "runtime-error": { index: "0", kind: "div-by-zero", fatal: "y" }, frame });
    resetRuntimeErrors();
    expect(store.get("runtime_error")).toBeNull();
    expect(registry.runtime_errors.close).toHaveBeenCalled();
  });
});

test("process_gdb_response 把每個停點交給 noteRuntimeStop（在 UI 暫停之前）", () => {
  const paused = jest.spyOn(Actions, "inferior_program_paused").mockImplementation(() => {
    expect(store.get("runtime_error")).not.toBeNull(); // 自動播放要在 TTS 開始前就停住
  });
  runMock.mockReturnValue(runOf("ex_err_int_overflow"));
  stepMock.mockReturnValue(48);
  process_gdb_response([
    {
      type: "notify",
      message: "stopped",
      payload: { reason: "runtime-error", frame, "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, "thread-id": "1", "stopped-threads": "all", core: "0" },
    },
  ]);
  expect(paused).toHaveBeenCalledWith(frame);
  expect(store.get("runtime_error").diag.kind).toBe("signed-overflow");
  paused.mockRestore();
});

test("程式結束的停點（exited-normally）也先交給 noteRuntimeStop：圖解留著、標成已經結束", () => {
  const exited = jest.spyOn(Actions, "inferior_program_exited").mockImplementation(() => undefined);
  runMock.mockReturnValue(runOf("ex_err_int_overflow"));
  stepMock.mockReturnValue(48);
  noteRuntimeStop({ reason: "runtime-error", "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, frame });
  stepMock.mockReturnValue(null);
  process_gdb_response([{ type: "notify", message: "stopped", payload: { reason: "exited-normally" } }]);
  expect(exited).toHaveBeenCalled();
  expect(store.get("runtime_error")).toMatchObject({ here: false, ended: true });
  exited.mockRestore();
});

test("「執行這行的結果」面板：停在錯誤那一步時多一行錯誤標記，離開那一步就拿掉", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    ReactDOM.render(React.createElement(LineAfterPanel), host);
  });
  act(() => {
    window.dispatchEvent(new CustomEvent("gdbgui-line-after", { detail: { line: 10, fn: "factorial", depth: 2, after: { kind: "stop", line: 9, changed: [] }, stdout: null, stderr: null } }));
  });
  runMock.mockReturnValue(runOf("ex_err_int_overflow"));
  stepMock.mockReturnValue(48);
  act(() => {
    noteRuntimeStop({ reason: "runtime-error", "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, frame });
  });
  expect(host.textContent).toContain("這一行發生執行錯誤：有號整數溢位");
  stepMock.mockReturnValue(49);
  act(() => {
    noteRuntimeStop({ reason: "end-stepping-range", frame });
  });
  expect(host.textContent).not.toContain("這一行發生執行錯誤");
  ReactDOM.unmountComponentAtNode(host);
  host.remove();
});
