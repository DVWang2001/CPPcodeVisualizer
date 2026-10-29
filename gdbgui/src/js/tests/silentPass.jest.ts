import {
  guideLineNumbers,
  insertGuideBreakpointCmds,
  deleteBreakpointCmd,
  classifyStop,
  nextResume,
} from "../silentPass";

describe("guideLineNumbers", () => {
  test("取 guide/tts/layout 任一欄有內容的行號，升冪、去重", () => {
    expect(guideLineNumbers({ line: { 5: "a" }, tts: { 9: "b", 5: "c" }, layout: { 2: "" } })).toEqual([5, 9]);
  });

  test("空白內容的行不算", () => {
    expect(guideLineNumbers({ line: { 4: "" }, tts: {} })).toEqual([]);
  });
});

describe("insertGuideBreakpointCmds", () => {
  test("略過使用者斷點所在行", () => {
    expect(insertGuideBreakpointCmds("/w/main.cpp", [3, 7], new Set([7]))).toEqual([
      '-break-insert -f "/w/main.cpp:3"',
    ]);
  });
});

describe("deleteBreakpointCmd", () => {
  test("沒有編號回傳空字串", () => {
    expect(deleteBreakpointCmd([])).toBe("");
  });

  test("多個編號以空白串接", () => {
    expect(deleteBreakpointCmd(["11", "12"])).toBe("-break-delete 11 12");
  });
});

describe("classifyStop", () => {
  const base = { line: 7, userBreakpointNumbers: new Set(["4"]), guideBreakpointNumbers: new Set(["9"]) };

  test("使用者斷點命中為正常", () => {
    expect(classifyStop({ ...base, bkptno: "4", quizMatched: false })).toBe("normal");
  });

  test("出題閘門命中即使是指導斷點也為正常", () => {
    expect(classifyStop({ ...base, bkptno: "9", quizMatched: true })).toBe("normal");
  });

  test("只有指導斷點命中為靜默", () => {
    expect(classifyStop({ ...base, bkptno: "9", quizMatched: false })).toBe("silent");
  });
});

describe("nextResume", () => {
  test("continue 恆續行", () => {
    expect(nextResume("continue", 1, 1)).toBe("continue");
    expect(nextResume("continue", 1, 5)).toBe("continue");
  });

  test("next 仍在深層框架內續行", () => {
    expect(nextResume("next", 2, 3)).toBe("next");
  });

  test("next 回到起點深度即為目標", () => {
    expect(nextResume("next", 2, 2)).toBe("done");
    expect(nextResume("next", 2, 1)).toBe("done");
  });

  test("finish 仍在被結束的框架或更深時續行", () => {
    expect(nextResume("finish", 2, 3)).toBe("finish");
    expect(nextResume("finish", 2, 2)).toBe("finish");
  });

  test("finish 落到呼叫者（深度低於起點）即為目標", () => {
    expect(nextResume("finish", 2, 1)).toBe("done");
  });
});
