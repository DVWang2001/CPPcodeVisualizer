import { ContentChange, dropOutOfRange, mapLine, shiftBreakpoints } from "../breakpointShift";

const bp = (line: number, extra: any = {}) => ({
  line: String(line), number: `frontend_${line}`, enabled: "y", is_normal_breakpoint: true,
  is_child_breakpoint: false, fullname_to_display: "", ...extra,
});
const lines = (bkpts: any[]) => bkpts.map((b) => parseInt(b.line, 10));
const change = (sl: number, sc: number, el: number, ec: number, text = ""): ContentChange => ({
  range: { startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec },
  text,
});

describe("deleting the line that carries a breakpoint (the reported bug)", () => {
  test("whole-line delete (Ctrl+Shift+K): its breakpoint goes away and later ones move up", () => {
    // 10 行的程式，斷點在 3 與 6；刪掉第 3 行
    const out = shiftBreakpoints([bp(3), bp(6)], [change(3, 1, 4, 1)], { prevLineCount: 10, lineCount: 9 });
    expect(lines(out)).toEqual([5]);
  });

  test("deleting the LAST line: the breakpoint is removed, not left past the end of the program", () => {
    // 10 行，斷點在最後一行與第 4 行；刪最後一行（Monaco 從上一行行尾刪到這一行行尾）
    const out = shiftBreakpoints([bp(4), bp(10)], [change(9, 20, 10, 15)], { prevLineCount: 10, lineCount: 9 });
    expect(lines(out)).toEqual([4]);
  });

  test("deleting several trailing lines removes every breakpoint on them", () => {
    const out = shiftBreakpoints([bp(2), bp(8), bp(9), bp(10)], [change(7, 30, 10, 12)], {
      prevLineCount: 10, lineCount: 7,
    });
    expect(lines(out)).toEqual([2]);
  });

  test("a block delete from mid-line to mid-line drops breakpoints on the merged lines, keeps the first", () => {
    const out = shiftBreakpoints([bp(3), bp(4), bp(5), bp(8)], [change(3, 5, 5, 3)], { prevLineCount: 10, lineCount: 8 });
    expect(lines(out)).toEqual([3, 6]);
  });

  test("Backspace at column 1 of a breakpoint line (joins it to the line above) removes that breakpoint", () => {
    const out = shiftBreakpoints([bp(4), bp(7)], [change(3, 12, 4, 1)], { prevLineCount: 10, lineCount: 9 });
    expect(lines(out)).toEqual([6]);
  });

  test("deleting an empty line just above a breakpoint line moves the breakpoint up with its line", () => {
    const out = shiftBreakpoints([bp(5)], [change(4, 1, 5, 1)], { prevLineCount: 10, lineCount: 9 });
    expect(lines(out)).toEqual([4]);
  });
});

describe("ordinary edits", () => {
  test("inserting lines above shifts breakpoints down; below leaves them", () => {
    const out = shiftBreakpoints([bp(2), bp(6)], [change(4, 5, 4, 5, "\nfoo\nbar")], { prevLineCount: 10, lineCount: 12 });
    expect(lines(out)).toEqual([2, 8]);
  });

  test("Enter in the middle of a breakpoint line keeps it on that line; lines below move down", () => {
    const out = shiftBreakpoints([bp(3), bp(5)], [change(3, 8, 3, 8, "\n")], { prevLineCount: 10, lineCount: 11 });
    expect(lines(out)).toEqual([3, 6]);
  });

  test("typing within a line changes nothing and returns the very same array", () => {
    const input = [bp(3), bp(5)];
    expect(shiftBreakpoints(input, [change(3, 2, 3, 2, "x")], { prevLineCount: 10, lineCount: 10 })).toBe(input);
  });

  test("multi-cursor edits are mapped against the pre-edit coordinates", () => {
    // 同時在第 2 行下面插一行、刪掉第 6 行
    const out = shiftBreakpoints([bp(1), bp(4), bp(6), bp(9)], [change(2, 3, 2, 3, "\n"), change(6, 1, 7, 1)], {
      prevLineCount: 10, lineCount: 10,
    });
    expect(lines(out)).toEqual([1, 5, 9]);
  });

  test("two breakpoints that end up on the same line collapse into one", () => {
    const out = shiftBreakpoints([bp(3), bp(4)], [change(3, 1, 4, 1)], { prevLineCount: 6, lineCount: 5 });
    // 第 3 行被刪、第 4 行上移成第 3 行
    expect(lines(out)).toEqual([3]);
  });

  test("non-normal (child / thread) breakpoints are left alone", () => {
    const child = bp(8, { is_child_breakpoint: true });
    const out = shiftBreakpoints([child, bp(8)], [change(3, 1, 4, 1)], { prevLineCount: 10, lineCount: 9 });
    expect(out[0]).toBe(child);
    expect(lines(out)).toEqual([8, 7]);
  });
});

describe("replacing the whole document is not an edit", () => {
  test("setValue (flush): breakpoints are not shifted or deleted, only capped to the new length", () => {
    const out = shiftBreakpoints([bp(3), bp(30)], [change(1, 1, 12, 5, "new text\n".repeat(20))], {
      prevLineCount: 12, lineCount: 21, isFlush: true,
    });
    expect(lines(out)).toEqual([3, 30].filter((n) => n <= 21));
  });

  test("replace-all via edit operations behaves the same", () => {
    const out = shiftBreakpoints([bp(3), bp(5)], [change(1, 1, 12, 5, "a\nb\nc\nd\ne\nf")], {
      prevLineCount: 12, lineCount: 6,
    });
    expect(lines(out)).toEqual([3, 5]);
  });
});

describe("stale breakpoints from before the fix", () => {
  test("dropOutOfRange removes breakpoints beyond the last line (the ghost drawn at the end)", () => {
    expect(lines(dropOutOfRange([bp(2), bp(40), bp(41)], 12))).toEqual([2]);
  });

  test("nothing out of range → same array", () => {
    const input = [bp(2), bp(12)];
    expect(dropOutOfRange(input, 12)).toBe(input);
  });
});

describe("mapLine", () => {
  test("a line before every change is untouched", () => {
    expect(mapLine(2, [change(5, 1, 6, 1)])).toBe(2);
  });
});
