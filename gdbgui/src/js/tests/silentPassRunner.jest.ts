import {
  startSilentPass,
  recordInsertedNumber,
  finishSilentPass,
  onSilentStop,
  isSilentPassActive,
} from "../silentPassRunner";

const guideStop = (bkptno: string, line: number) => ({
  bkptno,
  line,
  userBreakpointNumbers: new Set<string>(),
  guideBreakpointNumbers: new Set([bkptno]),
  quizMatched: false,
});

beforeEach(() => {
  finishSilentPass();
});

describe("startSilentPass / finishSilentPass", () => {
  test("啟動回傳插入命令，結束回傳刪除命令並清空狀態", () => {
    const cmds = startSilentPass("continue", 1, "/w/main.cpp", [3, 5], new Set());
    expect(cmds).toEqual([
      '-break-insert -f "/w/main.cpp:3"',
      '-break-insert -f "/w/main.cpp:5"',
    ]);
    recordInsertedNumber("11");
    recordInsertedNumber("12");
    expect(isSilentPassActive()).toBe(true);
    expect(finishSilentPass()).toBe("-break-delete 11 12");
    expect(isSilentPassActive()).toBe(false);
    expect(finishSilentPass()).toBe("");
  });

  test("未啟用時 recordInsertedNumber 不影響狀態", () => {
    recordInsertedNumber("99");
    expect(isSilentPassActive()).toBe(false);
    expect(finishSilentPass()).toBe("");
  });
});

describe("onSilentStop", () => {
  test("未啟用時一律正常", () => {
    expect(onSilentStop(1, guideStop("11", 3))).toEqual({ action: "normal" });
  });

  test("continue 途中的指導斷點為靜默並續行", () => {
    startSilentPass("continue", 1, "/w/main.cpp", [3], new Set());
    recordInsertedNumber("11");
    expect(onSilentStop(1, guideStop("11", 3))).toEqual({ action: "silent", resume: "-exec-continue" });
  });

  test("使用者斷點命中為正常，且狀態保留到呼叫端 finish", () => {
    startSilentPass("continue", 1, "/w/main.cpp", [3], new Set());
    recordInsertedNumber("11");
    const userStop = {
      bkptno: "2",
      line: 8,
      userBreakpointNumbers: new Set(["2"]),
      guideBreakpointNumbers: new Set(["11"]),
      quizMatched: false,
    };
    expect(onSilentStop(1, userStop)).toEqual({ action: "normal" });
    expect(isSilentPassActive()).toBe(true);
  });

  test("next 回到起點深度為目標，回傳正常", () => {
    startSilentPass("next", 2, "/w/main.cpp", [3], new Set());
    recordInsertedNumber("11");
    expect(onSilentStop(2, guideStop("11", 3))).toEqual({ action: "normal" });
  });

  test("next 在更深的呼叫內為靜默並續 next", () => {
    startSilentPass("next", 2, "/w/main.cpp", [3], new Set());
    recordInsertedNumber("11");
    expect(onSilentStop(3, guideStop("11", 3))).toEqual({ action: "silent", resume: "-exec-next" });
  });

  test("finish 仍在被結束的框架內為靜默並續 finish", () => {
    startSilentPass("finish", 2, "/w/main.cpp", [3], new Set());
    recordInsertedNumber("11");
    expect(onSilentStop(2, guideStop("11", 3))).toEqual({ action: "silent", resume: "-exec-finish" });
  });
});
