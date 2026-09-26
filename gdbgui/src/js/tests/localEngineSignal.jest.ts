// Actions.send_signal 的旗標分支：關閉 → $.ajax /send_signal；開啟 → localEngine（不連網）。
(global as any)._ = require("lodash");
jest.mock("../SourceCode", () => ({ __esModule: true, default: {} }));
jest.mock("../Visualizer", () => ({ __esModule: true, default: {} }));
jest.mock("../VisualizerHelper", () => ({ __esModule: true, default: {} }));
jest.mock("../process_gdb_response", () => ({ __esModule: true, default: jest.fn() }));

import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import Actions from "../Actions";
import { _test } from "../localEngine";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const ajax = jest.fn();
(window as any).$ = { ajax };

beforeEach(() => {
  _test.reset();
  ajax.mockClear();
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
});

test("旗標關閉：$.ajax POST /send_signal {signal_name, target}", () => {
  Actions.send_signal("SIGINT", "inferior");
  expect(ajax).toHaveBeenCalledTimes(1);
  expect(ajax.mock.calls[0][0]).toMatchObject({ url: "/send_signal", type: "POST", data: { signal_name: "SIGINT", target: "inferior" } });
});

test("旗標開啟：不連網，訊息進主控台", async () => {
  window.history.pushState({}, "", "/?engine=wasm");
  const add = jest.spyOn(Actions, "add_console_entries").mockImplementation(() => undefined);
  Actions.send_signal("SIGINT", "inferior");
  await flush();
  expect(ajax).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledTimes(1);
  expect(String(add.mock.calls[0][0])).toMatch(/瀏覽器引擎/);
  add.mockRestore();
});
