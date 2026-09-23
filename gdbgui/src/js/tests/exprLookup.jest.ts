import { findLatestExpr } from "../exprLookup";

describe("findLatestExpr", () => {
  test("只有一筆相符：直接回傳", () => {
    const expressions = [{ expression: "i - 1", in_scope: "true", value: "2" }];
    expect(findLatestExpr(expressions, "i - 1")?.value).toBe("2");
  });

  test("有兩筆同名（step-out 按太快留下的重複），回傳最後 push 的那筆（最新求值）", () => {
    const expressions = [
      { expression: "i - 1", in_scope: "true", value: "2" }, // 舊任務，第 26 行時的值
      { expression: "i - 1", in_scope: "true", value: "5" }, // 新任務，第 27 行時的值
    ];
    expect(findLatestExpr(expressions, "i - 1")?.value).toBe("5");
  });

  test("三筆同名時一樣取最後一筆，不是巧合取到中間那筆", () => {
    const expressions = [
      { expression: "j", in_scope: "true", value: "0" },
      { expression: "j", in_scope: "true", value: "1" },
      { expression: "j", in_scope: "true", value: "2" },
    ];
    expect(findLatestExpr(expressions, "j")?.value).toBe("2");
  });

  test("不同運算式名稱不互相干擾", () => {
    const expressions = [
      { expression: "i - 1", in_scope: "true", value: "9" },
      { expression: "j", in_scope: "true", value: "3" },
    ];
    expect(findLatestExpr(expressions, "j")?.value).toBe("3");
  });

  test("in_scope 不是 \"true\" 的（出了 scope 的舊 varobj）不算數", () => {
    const expressions = [
      { expression: "i - 1", in_scope: "true", value: "2" },
      { expression: "i - 1", in_scope: "false", value: "999" },
    ];
    expect(findLatestExpr(expressions, "i - 1")?.value).toBe("2");
  });

  test("找不到回 undefined", () => {
    const expressions = [{ expression: "j", in_scope: "true", value: "1" }];
    expect(findLatestExpr(expressions, "k")).toBeUndefined();
  });

  test("空陣列回 undefined", () => {
    expect(findLatestExpr([], "i")).toBeUndefined();
  });
});
