// 執行時期錯誤（P1）：LocalGdb 對「可繼續的錯誤」（溢位、C 陣列越界……）送出 reason "runtime-error" 的停點，
// UI 要像斷點一樣暫停在那一步；它不是訊號，所以不印「收到訊號」。
(global as any)._ = require("lodash");
jest.mock("../SourceCode", () => ({ __esModule: true, default: {} }));
jest.mock("../Visualizer", () => ({ __esModule: true, default: {} }));
jest.mock("../VisualizerHelper", () => ({ __esModule: true, default: {} }));

import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import Actions from "../Actions";
import process_gdb_response from "../process_gdb_response";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

test("runtime-error 停點：UI 暫停在那一步，主控台不說收到訊號", () => {
  const paused = jest.spyOn(Actions, "inferior_program_paused").mockImplementation(() => undefined);
  const add = jest.spyOn(Actions, "add_console_entries").mockImplementation(() => undefined);
  const frame = { line: "3", fullname: "/workspace/main.cpp", file: "main.cpp", func: "main", addr: "0x1", level: "0", arch: "wasm32", args: [] };
  process_gdb_response([
    {
      type: "notify",
      message: "stopped",
      payload: { reason: "runtime-error", frame, "runtime-error": { index: "0", kind: "signed-overflow", fatal: "n" }, "thread-id": "1", "stopped-threads": "all", core: "0" },
    },
  ]);
  expect(paused).toHaveBeenCalledWith(frame);
  expect(add.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/收到訊號/);
  paused.mockRestore();
  add.mockRestore();
});
