// 教案標註的全域表在每次 Run 之後都要還在。
// run_initial_commands 在每次連線交握時清空 global_variable，只留下教案標註；本地引擎每次 Run 都會重做一次交握。
// 「錯誤診斷」（LineAfterPanel）讀的 __bug 若被清掉，右欄就不顯示教案作者寫的 @bug 說明。
(global as any)._ = require("lodash");

jest.mock("socket.io-client", () => {
  const sock = { on: jest.fn(), emit: jest.fn(), close: jest.fn(), connected: false, disconnected: true };
  return { __esModule: true, default: { connect: jest.fn(() => sock) }, connect: jest.fn(() => sock) };
});
jest.mock("../Actions", () => {
  const fns: any = {};
  return {
    __esModule: true,
    default: new Proxy(fns, {
      get: (t: any, k: string) => (k in t ? t[k] : (t[k] = jest.fn())),
    }),
  };
});
jest.mock("../process_gdb_response", () => ({ __esModule: true, default: jest.fn() }));

import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import GdbApi from "../GdbApi";
import { global_variable } from "../global_variable";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

test("run_initial_commands 保留四個教案標註表（含 @bug），只清掉執行期間的狀態", () => {
  const g = global_variable as any;
  g.__line = { "7": "guide" };
  g.__tts = { "7": "[next] tts" };
  g.__layout = { "7": "open:x" };
  g.__bug = { "7": "錯誤說明" };
  g.__visited_lines = [7];
  const send = jest.spyOn(GdbApi, "run_gdb_command").mockImplementation(() => undefined as any);
  try {
    GdbApi.run_initial_commands();
  } finally {
    send.mockRestore();
  }
  expect(g.__bug).toEqual({ "7": "錯誤說明" });
  expect(g.__line).toEqual({ "7": "guide" });
  expect(g.__tts).toEqual({ "7": "[next] tts" });
  expect(g.__layout).toEqual({ "7": "open:x" });
  expect("__visited_lines" in g).toBe(false);
});
