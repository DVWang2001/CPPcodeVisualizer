import { resolveSourceText } from "../sourceText";

describe("resolveSourceText — 程式追蹤表不能因為快取沒同步就顯示「尚未載入源碼」", () => {
  it("有快取就用快取，不去問編輯器", () => {
    const g = { __source_text: "int main(){}" };
    const get = jest.fn(() => "other");
    expect(resolveSourceText(g, get)).toBe("int main(){}");
    expect(get).not.toHaveBeenCalled();
  });

  it("快取是空的（從教案庫載入的路徑）就直接問編輯器，並寫回快取", () => {
    const g: { __source_text?: string } = {};
    const get = jest.fn(() => "int n = 6;");
    expect(resolveSourceText(g, get)).toBe("int n = 6;");
    expect(g.__source_text).toBe("int n = 6;");
    expect(resolveSourceText(g, get)).toBe("int n = 6;");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("編輯器還沒掛載（沒有取值函式）或回傳空字串，回傳空字串", () => {
    expect(resolveSourceText({}, undefined)).toBe("");
    expect(resolveSourceText({}, () => "")).toBe("");
  });

  it("取值函式丟例外（編輯器尚未就緒）不會讓 render 炸掉", () => {
    expect(
      resolveSourceText({}, () => {
        throw new Error("editor not ready");
      })
    ).toBe("");
  });
});
