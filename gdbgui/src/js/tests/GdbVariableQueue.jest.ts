// 回報：「step-in 按太快，容器和變數會顯示不正常」。
//
// 根因：GdbVariable.tsx 內部的 VarCreator（還有結構一樣的 ChildVarFetcher）
// 用單一佇列＋_is_fetching 旗標把 -var-create 請求序列化，靠唯一一個共用的
// 可變欄位（expr_being_created）記「現在這筆在等的回應是哪個 expression」。
// VisualizerHelper.graphics_instruction 每次真的停到新的一行（也就是每次
// step）都會呼叫 clear_visualizer_queues() 清掉上一個任務留下的排隊項目。
//
// 舊版不分青紅皂白把 _is_fetching 也一起重置成 false：如果上一個任務的
// -var-create 已經送出去、GDB 還沒回應（in-flight），這個重置會讓新任務誤以為
// 「現在沒人在等回應」而搶著送出下一筆——兩筆請求共用同一個 expr_being_created，
// GDB 回應一到就會被歸屬到「後來」那個 expression，而後來那筆自己的回應反而因為
// 欄位已經被清空、被當成「非預期的變數」直接丟棄，永遠不會解析出來。這就是
// 使用者說的「容器和變數顯示不正常」。
//
// 修法：clear_visualizer_queues(hard) 只有 hard=true（Actions.inferior_program_starting，
// 真的殺掉舊 GDB process 時）才重置 _is_fetching；graphics_instruction 每次新停駐點
// 用 hard=false，只清「還沒送出」的排隊項目，讓 in-flight 那筆自然收尾、正確歸屬，
// 佇列自己會在那之後才處理新任務排進來的項目。
// 正式環境靠 <script> 標籤把 lodash 掛成全域 `_`（GdbVariable.tsx 裡一堆
// `_.isString`/`_.trim` 都是這樣用，webpack 沒有 ProvidePlugin 注入），
// jsdom 測試環境沒有那個 script，用真的 lodash 補上就好。
(global as any)._ = require("lodash");

// GdbVariable.tsx imports Actions.ts，Actions.ts 的匯入鏈會拉到某個帶 .css
// 匯入的元件（例如即時課堂面板），jest 沒有設定 CSS 的 transform/mock 就會直接
// 炸掉。這個測試只用得到 GdbVariable 對 Actions 的兩個呼叫（都在錯誤/未建構
// 完成的分支，不在這裡驗的快樂路徑上），mock 掉整個模組最省事。
jest.mock("../Actions", () => ({
  __esModule: true,
  default: {
    add_gdb_response_to_console: jest.fn(),
    add_console_entries: jest.fn(),
  },
}));

import GdbVariable from "../GdbVariable";
import GdbApi from "../GdbApi";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

beforeEach(() => {
  store.set("expressions", []);
  // 每個測試從乾淨的佇列狀態開始，不受前一個測試殘留的 _is_fetching 影響。
  GdbVariable.clear_visualizer_queues(true);
  jest.restoreAllMocks();
});

function findExpr(expression: string) {
  return (store.get("expressions") as any[]).find(e => e.expression === expression);
}

describe("clear_visualizer_queues(false) — 修 step-in 按太快的錯位", () => {
  it("前一筆 -var-create 還在等回應時，新任務的請求要排隊，不能搶著送出", () => {
    const runCmd = jest.spyOn(GdbApi, "run_gdb_command").mockImplementation(() => {});

    // Task N：要求建立 "up"，GDB 還沒回應（in-flight）。
    GdbVariable.create_variable("up", "expr", "foo::up");
    expect(runCmd).toHaveBeenCalledTimes(1);

    // Task N+1（模擬 step-in 按太快、又停到新的一行）：graphics_instruction
    // 開頭會呼叫這個，清掉還沒送出的排隊項目——但 "up" 那筆已經送出去了，
    // 不在佇列裡，不受影響。
    GdbVariable.clear_visualizer_queues(false);

    // 新任務要建立 "left"。此時 "up" 還沒收到回應，"left" 不能立刻送出，
    // 否則兩者會共用同一個「目前這筆是誰」的欄位。
    GdbVariable.create_variable("left", "expr", "foo::left");
    expect(runCmd).toHaveBeenCalledTimes(1); // 還是只送出過一次（"up" 那筆）

    // GDB 回應「up」那筆的建立結果。
    GdbVariable.gdb_created_root_variable({
      payload: { name: "var1", numchild: "0", value: "3", type: "int" },
    });

    // 正確歸屬到 "foo::up"，不是被後來排隊的 "foo::left" 搶走。
    expect(findExpr("foo::up")?.value).toBe("3");
    expect(findExpr("foo::left")).toBeUndefined();

    // "up" 收尾後，佇列自己接著送出 "left" 那筆。
    expect(runCmd).toHaveBeenCalledTimes(2);

    // GDB 回應「left」那筆。
    GdbVariable.gdb_created_root_variable({
      payload: { name: "var2", numchild: "0", value: "5", type: "int" },
    });

    // 兩個 expression 都要正確解析，值不能互相污染、也不能有一個永遠卡住。
    expect(findExpr("foo::up")?.value).toBe("3");
    expect(findExpr("foo::left")?.value).toBe("5");
  });

  it("前一筆已經回應完畢時（沒有 in-flight 請求），新任務照常立刻送出，沒有變慢", () => {
    const runCmd = jest.spyOn(GdbApi, "run_gdb_command").mockImplementation(() => {});

    GdbVariable.create_variable("up", "expr", "foo::up");
    GdbVariable.gdb_created_root_variable({
      payload: { name: "var1", numchild: "0", value: "3", type: "int" },
    });
    expect(runCmd).toHaveBeenCalledTimes(1);

    GdbVariable.clear_visualizer_queues(false);
    GdbVariable.create_variable("left", "expr", "foo::left");
    // 沒有 in-flight 請求要等，soft clear 不該讓後面的請求平白排隊等待。
    expect(runCmd).toHaveBeenCalledTimes(2);
  });
});

describe("clear_visualizer_queues(true) — Run/重啟時真的要重置", () => {
  it("舊 GDB process 被殺掉、in-flight 請求永遠不會回應時，hard reset 讓新請求能立刻送出", () => {
    const runCmd = jest.spyOn(GdbApi, "run_gdb_command").mockImplementation(() => {});

    GdbVariable.create_variable("up", "expr", "foo::up");
    expect(runCmd).toHaveBeenCalledTimes(1);
    // 模擬舊 GDB process 被殺掉：這筆永遠不會有回應。

    GdbVariable.clear_visualizer_queues(true);
    GdbVariable.create_variable("left", "expr", "foo::left");
    // hard reset 把 _is_fetching 重置回 false，"left" 能立刻送出，
    // 不會被永遠不會回應的 "up" 卡死。
    expect(runCmd).toHaveBeenCalledTimes(2);
  });
});
