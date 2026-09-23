// 真的掛載 ContainerVisualizer，驗證 pull: 的幾個行為：
// 1. 只有數字（span）飛出去、淡出，格子本身的外框/底色不跟著動。
// 2. 目標格浮出「暫時的計算結果」（兩個來源值相加），且**不是限時收掉**——
//    450ms 的飛行動畫結束後仍要繼續蓋著，等輪詢偵測到目標格的真實值真的變了
//    才收掉（不然會出現「合併完又變回舊值」的閃爍，這是這個測試檔案要顧的
//    使用者回報情境）。
// 純函式邏輯（parsePullToken/computePullOffsets/formatPullPreview）已經在
// pullAnim.jest.ts 驗過；這裡補的是「元件真的照這個邏輯串起來」這一層。
import React from "react";
import * as TestRenderer from "react-test-renderer";
const { act } = TestRenderer;
import ContainerVisualizer from "../ContainerVisualizer";
import { global_variable } from "../global_variable";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

function seedDp() {
  // 3x3 dp 表：(0,1)=orange「上面」=3，(1,0)=lime「左邊」=5，(1,1)=lightblue 目標（舊值 0）
  (global_variable as any).__latest_containers = new Map([
    ["dp", { name: "dp", type: "vector", isContainer: true, values: [[0, 3, 0], [5, 0, 0], [0, 0, 0]] }],
  ]);
  (global_variable as any).__latest_highlights = new Map([
    ["dp", [{ index: 1, color: "orange" }, { index: 3, color: "lime" }, { index: 4, color: "lightblue" }]],
  ]);
}

/** 只有動畫中的數字 span 會帶 opacity（見 ContainerVisualizer.tsx 的 numberStyle）。 */
function findFlyingNumbers(json: any): any[] {
  const found: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "span" && n.props?.style && "opacity" in n.props.style) found.push(n);
    (n.children || []).forEach(walk);
  };
  walk(json);
  return found;
}

/** 暫時計算結果的浮動小標籤：唯一一個 position: absolute 的 span。 */
function findPreviewBadge(json: any): any | null {
  let found: any = null;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "span" && n.props?.style?.position === "absolute") found = n;
    (n.children || []).forEach(walk);
  };
  walk(json);
  return found;
}

// 不能用 jest.runAllTimers()：ContainerVisualizer 自己的 setInterval(輪詢容器，
// 1000ms 一次) 在假時鐘底下會無限重排程，runAllTimers 會直接判定成無窮迴圈而中止。
// 只推進剛好蓋過 pull 的 450ms 延遲、推進到 1000ms 那個輪詢節點之前就好。
const flushAll = async (ms = 500, step = 50) => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    jest.advanceTimersByTime(step);
    await Promise.resolve();
  }
};

describe("pull:dp:orange,lime->lightblue", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("觸發時只有數字飛出去，目標格浮出兩數相加的暫時結果；450ms 飛行動畫結束後暫時結果還在（真實值沒變）", async () => {
    seedDp();
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ContainerVisualizer as any));
    });

    expect(findFlyingNumbers(renderer.toJSON())).toHaveLength(0);
    expect(findPreviewBadge(renderer.toJSON())).toBeNull();

    act(() => {
      (window as any).gdbgui_trigger_pull("dp", "orange", "lime", "lightblue");
    });

    const flying = findFlyingNumbers(renderer.toJSON());
    expect(flying).toHaveLength(2);
    flying.forEach(s => {
      expect(s.props.style.opacity).toBe(0);
      expect(String(s.props.style.transform)).toContain("translate(");
    });

    const badge = findPreviewBadge(renderer.toJSON());
    expect(badge).not.toBeNull();
    expect(badge.children).toEqual(["8"]);
    // 回歸測試：badge 曾經用 top:"-10px" + translate(-50%,-100%) 浮在目標格
    // 上方，在直向排列的表格裡會伸進正上方那一格的範圍，看起來像長在來源格
    // 上而不是目標格（使用者實測回報）。inset:0 才是待在目標格「裡面」，不會
    // 溢出到別格——react-test-renderer 不跑真的排版，這條斷言是唯一能擋住
    // 這類「資料是對的、但視覺位置溢出到別格」的地方。
    expect(badge.props.style.inset).toBe(0);
    expect(badge.props.style.top).toBeUndefined();

    // 過了 450ms：飛行動畫（來源格數字位移）結束，但目標格的真實值
    // （dp[1][1]）在 __latest_containers 裡還是原本的 0，暫時結果不能收掉。
    await act(async () => {
      await flushAll(500);
    });

    expect(findFlyingNumbers(renderer.toJSON())).toHaveLength(0);
    const badgeAfter = findPreviewBadge(renderer.toJSON());
    expect(badgeAfter).not.toBeNull();
    expect(badgeAfter.children).toEqual(["8"]);

    act(() => {
      renderer.unmount();
    });
  });

  it("目標格的真實值後來真的變了（下一次輪詢）：暫時結果才收掉", async () => {
    seedDp();
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ContainerVisualizer as any));
    });

    act(() => {
      (window as any).gdbgui_trigger_pull("dp", "orange", "lime", "lightblue");
    });
    expect(findPreviewBadge(renderer.toJSON())).not.toBeNull();

    // 模擬使用者步進到下一行，GDB 真的把 dp[1][1] 寫成 8 了。
    (global_variable as any).__latest_containers = new Map([
      ["dp", { name: "dp", type: "vector", isContainer: true, values: [[0, 3, 0], [5, 8, 0], [0, 0, 0]] }],
    ]);

    // 推進到下一次輪詢節點（1000ms）：_pollContainers 應該發現目標格的值
    // 從 0 變成 8，跟觸發當下記錄的 beforeValue 不一樣，收掉暫時結果。
    await act(async () => {
      await flushAll(1100);
    });

    expect(findPreviewBadge(renderer.toJSON())).toBeNull();

    act(() => {
      renderer.unmount();
    });
  });

  it("來源值不是數字時：照樣飛，但沒有暫時結果", async () => {
    (global_variable as any).__latest_containers = new Map([
      ["dp", { name: "dp", type: "string", isContainer: true, values: [["", "ab", ""], ["cd", "", ""], ["", "", ""]] }],
    ]);
    (global_variable as any).__latest_highlights = new Map([
      ["dp", [{ index: 1, color: "orange" }, { index: 3, color: "lime" }, { index: 4, color: "lightblue" }]],
    ]);
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ContainerVisualizer as any));
    });

    act(() => {
      (window as any).gdbgui_trigger_pull("dp", "orange", "lime", "lightblue");
    });

    expect(findFlyingNumbers(renderer.toJSON())).toHaveLength(2);
    expect(findPreviewBadge(renderer.toJSON())).toBeNull();

    await act(async () => {
      await flushAll();
    });
    act(() => {
      renderer.unmount();
    });
  });
});
