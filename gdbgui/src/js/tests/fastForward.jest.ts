import {
  parseFastDirective,
  stripFastDirective,
  isFastTargetExpr,
  fastTargetExpr,
  toFastTarget,
  decideFastState,
  armFastForward,
  disarmFastForward,
  getFastForward,
  isFastForwarding,
  FAST_FORWARD_STEP_LIMIT,
  FastForwardState,
} from "../fastForward";

/** 模仿 play_tts 的 `|` 分段 + `@N` 門檻選段（VisualizerHelper.js 內的既有邏輯）。 */
function selectSegment(raw: string, visitCount: number): string {
  if (!raw.includes("|")) return raw;
  const parts = raw.split("|").map(s => s.trim());
  let nextDefault = 1;
  const segments = parts.map(part => {
    const atMatch = part.match(/^@(\d+)\s*/);
    if (atMatch) {
      const threshold = parseInt(atMatch[1]);
      nextDefault = threshold + 1;
      return { threshold, text: part.slice(atMatch[0].length) };
    }
    return { threshold: nextDefault++, text: part };
  });
  let selected = segments[0].text;
  for (const seg of segments) {
    if (visitCount >= seg.threshold) selected = seg.text;
  }
  return selected;
}

describe("parseFastDirective", () => {
  test("常數引數", () => {
    expect(parseFastDirective("[fast @5] 最後一圈")).toEqual({ target: "5" });
  });
  test("{變數} 引數原樣回傳（求值是呼叫端的事）", () => {
    expect(parseFastDirective("[fast @{n}] 這是第 {n} 圈")).toEqual({ target: "{n}" });
  });
  test("其他指令前綴不誤判", () => {
    expect(parseFastDirective("[next] 下一行")).toBeNull();
    expect(parseFastDirective("[continue] 跳到斷點")).toBeNull();
  });
  test("沒有引數的 [fast] 不成立", () => {
    expect(parseFastDirective("[fast] 忘了寫次數")).toBeNull();
    expect(parseFastDirective("[fast @] 空引數")).toBeNull();
  });
  test("必須寫在最前面", () => {
    expect(parseFastDirective("先講一句 [fast @5]")).toBeNull();
    expect(parseFastDirective("@3 [fast @5] 門檻沒被剝掉時不成立")).toBeNull();
  });
  test("非字串輸入回 null", () => {
    expect(parseFastDirective(undefined)).toBeNull();
    expect(parseFastDirective("")).toBeNull();
  });
});

describe("parseFastDirective 與 | 多段、@N 門檻混用", () => {
  const raw = "[next] 第一圈慢慢看 | @4 [fast @6] 最後一圈了，i={i}";

  test("只解析被選中的那一段：次數未達 @4 時選到第一段，沒有 [fast]", () => {
    expect(parseFastDirective(selectSegment(raw, 1))).toBeNull();
  });
  test("次數達 @4 時選到第二段，解析得出 [fast @6]", () => {
    expect(parseFastDirective(selectSegment(raw, 4))).toEqual({ target: "6" });
  });
  test("直接餵原始整串會漏掉後面的段落（所以必須先選段）", () => {
    expect(parseFastDirective(raw)).toBeNull();
  });
});

describe("stripFastDirective", () => {
  test("去掉指令前綴留下說話文字", () => {
    expect(stripFastDirective("[fast @{n}] 最後一圈，i={i}")).toBe("最後一圈，i={i}");
  });
  test("沒有指令時原樣回傳", () => {
    expect(stripFastDirective("[next] 一般文字")).toBe("[next] 一般文字");
  });
});

describe("引數求值輔助", () => {
  test("isFastTargetExpr / fastTargetExpr", () => {
    expect(isFastTargetExpr("{n}")).toBe(true);
    expect(isFastTargetExpr("5")).toBe(false);
    expect(fastTargetExpr("{ n }")).toBe("n");
  });
  test("toFastTarget 只接受正整數", () => {
    expect(toFastTarget("5")).toBe(5);
    expect(toFastTarget(" 12 ")).toBe(12);
    expect(toFastTarget(7)).toBe(7);
    expect(toFastTarget("0")).toBeNull();
    expect(toFastTarget("-3")).toBeNull();
    expect(toFastTarget("2.5")).toBeNull();
    expect(toFastTarget("n")).toBeNull();
    expect(toFastTarget("<optimized out>")).toBeNull();
    expect(toFastTarget(undefined)).toBeNull();
  });
});

describe("decideFastState", () => {
  const armed = (over: Partial<FastForwardState> = {}): FastForwardState => ({
    line: 10,
    target: 4,
    steps: 0,
    ...over,
  });

  test("未武裝且 count < target → arm", () => {
    expect(decideFastState(10, 1, null, 4)).toBe("arm");
  });
  test("已武裝且停在非目標行 → hold（抑制是全域的）", () => {
    expect(decideFastState(11, 99, armed())).toBe("hold");
    expect(decideFastState(12, 1, armed())).toBe("hold");
  });
  test("已武裝且停在目標行但次數未達 → 仍然 hold", () => {
    expect(decideFastState(10, 3, armed())).toBe("hold");
  });
  test("已武裝且目標行 count >= target → disarm", () => {
    expect(decideFastState(10, 4, armed())).toBe("disarm");
    expect(decideFastState(10, 5, armed())).toBe("disarm");
  });
  test("未武裝且 count >= target → none（不武裝，直接正常播放）", () => {
    expect(decideFastState(10, 4, null, 4)).toBe("none");
    expect(decideFastState(10, 9, null, 4)).toBe("none");
  });
  test("未武裝且 target 求值失敗 → none", () => {
    expect(decideFastState(10, 1, null, null)).toBe("none");
    expect(decideFastState(10, 1, null, 0)).toBe("none");
    expect(decideFastState(10, 1, null)).toBe("none");
  });

  test("步數上限：steps > 5000 → disarm（即使還沒到目標行）", () => {
    expect(FAST_FORWARD_STEP_LIMIT).toBe(5000);
    expect(decideFastState(11, 1, armed({ steps: FAST_FORWARD_STEP_LIMIT + 1 }))).toBe("disarm");
    // 上限之內照常 hold
    expect(decideFastState(11, 1, armed({ steps: FAST_FORWARD_STEP_LIMIT }))).toBe("hold");
  });
});

describe("快轉全域狀態", () => {
  afterEach(() => disarmFastForward());

  test("arm / disarm 切換 isFastForwarding", () => {
    expect(isFastForwarding()).toBe(false);
    armFastForward(10, 4);
    expect(isFastForwarding()).toBe(true);
    expect(getFastForward()).toEqual({ line: 10, target: 4, steps: 0 });
    disarmFastForward();
    expect(isFastForwarding()).toBe(false);
    expect(getFastForward()).toBeNull();
  });

  test("blob 沒回來時武裝會自己逾時解除", () => {
    jest.useFakeTimers();
    try {
      armFastForward(10, 4);
      expect(isFastForwarding()).toBe(true);
      jest.advanceTimersByTime(20000);
      // 沒有這條保險絲，armed 會永遠卡著，而 armed 期間每個停駐點都被吃掉
      expect(isFastForwarding()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
