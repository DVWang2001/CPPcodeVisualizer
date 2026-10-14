// 回報：「程式追蹤表的算式 {n/2}、{3*n+1} 給不出正確的值」。
//
// 根因：重新執行（⟲）時，上一輪 guide 建立的 `expr` 變數物件還留在 store、in_scope
// 仍為 "true"，graphics_instruction 會複用它們——但新的引擎 session 不會更新這些
// 物件，算式就顯示上一輪結束時的值（n=1 → 6/2=0、3*3+1=4）。
// 修法：Actions.inferior_program_starting 呼叫 discard_guide_expressions，丟掉
// expr_type === "expr" 的物件；使用者的 watch 不動。
(global as any)._ = require("lodash");

jest.mock("../Actions", () => ({
  __esModule: true,
  default: {
    add_gdb_response_to_console: jest.fn(),
    add_console_entries: jest.fn(),
  },
}));

import GdbVariable from "../GdbVariable";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

const obj = (expression: string, expr_type: string, value = "1") => ({
  name: `var_${expression}`,
  expression,
  expr_type,
  value,
  in_scope: "true",
});

describe("discard_guide_expressions", () => {
  it("丟掉 guide 建立的 expr 物件，保留 watch 與 hover", () => {
    store.set("expressions", [
      obj("n", "expr"),
      obj("main::n/2", "expr"),
      obj("total", "watch"),
      obj("x", "hover"),
    ]);
    GdbVariable.discard_guide_expressions();
    const left = (store.get("expressions") as any[]).map(e => e.expression);
    expect(left).toEqual(["total", "x"]);
  });

  it("沒有 expr 物件時不動 store（不觸發多餘的重繪）", () => {
    const watchOnly = [obj("total", "watch")];
    store.set("expressions", watchOnly);
    const spy = jest.spyOn(store, "set");
    GdbVariable.discard_guide_expressions();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("window 橋接存在，Actions 才呼叫得到", () => {
    expect(typeof (window as any).gdbgui_discard_guide_expressions).toBe("function");
  });
});
