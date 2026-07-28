import { parseForHeader, decideForSegment, segRange, ForSegments } from "../forHeader";

/** 把回傳的字元範圍還原成文字，斷言起來比裸數字好讀。 */
function texts(line: string, segs: ForSegments | null) {
  if (!segs) return null;
  return {
    a: line.slice(segs.a[0], segs.a[1]),
    b: line.slice(segs.b[0], segs.b[1]),
    c: line.slice(segs.c[0], segs.c[1]),
  };
}

describe("parseForHeader", () => {
  test("1. 標準 for 三段範圍正確", () => {
    const line = "    for (int i = 0; i < 3; i++) {";
    const segs = parseForHeader(line);
    expect(texts(line, segs)).toEqual({ a: "int i = 0", b: "i < 3", c: "i++" });
    // 位移本身也檢一次，確認是「該行的」而非 trim 過的字串位置
    expect(segs!.a).toEqual([9, 18]);
  });

  test("2. 巢狀括號不被內層逗號/括號騙到", () => {
    const line = "for (int i = f(a, b); i < g(c); i += h(d))";
    expect(texts(line, parseForHeader(line))).toEqual({
      a: "int i = f(a, b)",
      b: "i < g(c)",
      c: "i += h(d)",
    });
  });

  test("3. 字串常值裡的分號不會被誤切", () => {
    const line = 'for (int i = 0; s != "a;b"; i++)';
    expect(texts(line, parseForHeader(line))).toEqual({
      a: "int i = 0",
      b: 's != "a;b"',
      c: "i++",
    });
  });

  test("3b. 字元常值裡的分號不會被誤切", () => {
    const line = "for (int i = 0; c != ';'; i++)";
    expect(texts(line, parseForHeader(line))).toEqual({
      a: "int i = 0",
      b: "c != ';'",
      c: "i++",
    });
  });

  test("4. range-for 回 null", () => {
    expect(parseForHeader("for (auto x : v) {")).toBeNull();
    expect(parseForHeader("    for (const auto& kv : m) {")).toBeNull();
  });

  test("5. while 回 null", () => {
    expect(parseForHeader("while (i < 3) {")).toBeNull();
    expect(parseForHeader("    } while (i < 3);")).toBeNull();
    expect(parseForHeader("    int sum = 0;")).toBeNull();
  });

  test("6. for (;;) 解析成功、三段皆為空範圍", () => {
    const segs = parseForHeader("for (;;) {");
    expect(segs).not.toBeNull();
    expect(segs!.a).toEqual([5, 5]);
    expect(segs!.b).toEqual([6, 6]);
    expect(segs!.c).toEqual([7, 7]);
  });

  test("7. 多行 for 標頭（該行無配對右括號）回 null", () => {
    expect(parseForHeader("for (int i = 0; i < 3;")).toBeNull();
  });

  test("8. 同一行有 for 之外的分號時取到正確的那組", () => {
    const line = "int a = 1; for (int i = 0; i < a; i++) sum += i;";
    expect(texts(line, parseForHeader(line))).toEqual({
      a: "int i = 0",
      b: "i < a",
      c: "i++",
    });
  });

  test("註解裡的 for 不會被當成程式碼", () => {
    expect(parseForHeader("// for (int i = 0; i < 3; i++)")).toBeNull();
    expect(parseForHeader('    printf("for (i;i;i)");')).toBeNull();
  });

  test("行尾 //@ 標註不影響解析", () => {
    const line = "  for (int i = 0; i < 3; i++) { //@guide 迴圈開始; 注意 i";
    expect(texts(line, parseForHeader(line))).toEqual({
      a: "int i = 0",
      b: "i < 3",
      c: "i++",
    });
  });

  test("非字串/空字串輸入回 null", () => {
    expect(parseForHeader("")).toBeNull();
    expect(parseForHeader(undefined as any)).toBeNull();
    expect(parseForHeader(null as any)).toBeNull();
  });

  test("forsomething 這種識別字不算 for 關鍵字", () => {
    expect(parseForHeader("format(a; b; c)")).toBeNull();
  });
});

describe("segRange", () => {
  test("依 seg 取出對應範圍", () => {
    const segs = parseForHeader("for (int i = 0; i < 3; i++)")!;
    expect(segRange(segs, "A")).toEqual(segs.a);
    expect(segRange(segs, "B")).toEqual(segs.b);
    expect(segRange(segs, "C")).toEqual(segs.c);
  });
});

describe("decideForSegment", () => {
  const A_ADDR = "0x0000555555555158"; // 初始化區塊
  const C_ADDR = "0x0000555555555167"; // 遞增區塊

  test("正常序列：A, C, C, C", () => {
    const min: { [line: number]: bigint } = {};
    const seq = [A_ADDR, C_ADDR, C_ADDR, C_ADDR].map(a => decideForSegment(min, 7, a));
    expect(seq).toEqual(["A", "C", "C", "C"]);
  });

  test("迴圈重新進入（回到最小位址）重新判為 A", () => {
    const min: { [line: number]: bigint } = {};
    const seq = [A_ADDR, C_ADDR, C_ADDR, A_ADDR, C_ADDR].map(a =>
      decideForSegment(min, 7, a)
    );
    expect(seq).toEqual(["A", "C", "C", "A", "C"]);
  });

  test("中斷點設在迴圈中間：第一次誤報 A，重新進入後自我修正", () => {
    const min: { [line: number]: bigint } = {};
    // 第一次停到的是遞增區塊 → 因為還沒看過更小的位址，會誤報 A（已知限制）
    expect(decideForSegment(min, 7, C_ADDR)).toBe("A");
    // 迴圈重新進入，初始化區塊的較低位址把 min 拉下來
    expect(decideForSegment(min, 7, A_ADDR)).toBe("A");
    // 之後判定恢復正確
    expect(decideForSegment(min, 7, C_ADDR)).toBe("C");
    expect(decideForSegment(min, 7, C_ADDR)).toBe("C");
  });

  test("不同行各自獨立計算最小位址", () => {
    const min: { [line: number]: bigint } = {};
    expect(decideForSegment(min, 7, A_ADDR)).toBe("A");
    expect(decideForSegment(min, 9, C_ADDR)).toBe("A"); // 第 9 行第一次看到
    expect(decideForSegment(min, 7, C_ADDR)).toBe("C");
  });

  test("十六進位比較不受字串長度影響（不能用字串比大小）", () => {
    const min: { [line: number]: bigint } = {};
    // "0x9" 字串上大於 "0x10"，但數值上較小
    expect(decideForSegment(min, 7, "0x9")).toBe("A");
    expect(decideForSegment(min, 7, "0x10")).toBe("C");
  });

  test("frame.addr 缺失時退回「該行第一次停 → A」", () => {
    const min: { [line: number]: bigint } = {};
    expect(decideForSegment(min, 7, undefined)).toBe("A");
    expect(decideForSegment(min, 7, undefined)).toBe("C");
    expect(decideForSegment(min, 7, "")).toBe("C");
    expect(decideForSegment(min, 7, "not-an-address")).toBe("C");
  });
});
