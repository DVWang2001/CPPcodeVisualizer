import { nextScrollLeft, keepRightEdge } from "../traceScroll";

describe("nextScrollLeft — 追蹤表新增一欄時捲到最右邊", () => {
  it("步數增加就捲到最右（scrollWidth - clientWidth）", () => {
    expect(nextScrollLeft(3, 4, 1200, 700)).toBe(500);
  });

  it("步數沒變不捲：使用者往左翻回去看時不會被每秒的重繪拉回來", () => {
    expect(nextScrollLeft(4, 4, 1200, 700)).toBeNull();
  });

  it("重新執行（步數變少）不捲，只重設記錄", () => {
    expect(nextScrollLeft(8, 1, 900, 700)).toBeNull();
  });

  it("內容沒有超出面板寬度時捲動位置為 0", () => {
    expect(nextScrollLeft(0, 1, 500, 700)).toBe(0);
  });
});

describe("keepRightEdge — 步驟欄寬跟著數值長度變，表格變寬時繼續看得到最新一欄", () => {
  it("原本停在最右邊、表格變寬：捲到新的最右邊", () => {
    // 之前 scrollWidth 1000、clientWidth 700，停在 300（最右）；同一欄填進較長的數值後變成 1040
    expect(keepRightEdge(1000, 700, 300, 1040, 700)).toBe(340);
  });

  it("縮放造成不到 1px 的小數差，也算停在最右邊", () => {
    expect(keepRightEdge(1000, 700, 299.2, 1040, 700)).toBe(340);
  });

  it("使用者往左翻回去看舊欄位時，表格變寬也不動", () => {
    expect(keepRightEdge(1000, 700, 120, 1040, 700)).toBeNull();
  });

  it("表格沒有變寬（每秒的重繪）不動", () => {
    expect(keepRightEdge(1040, 700, 340, 1040, 700)).toBeNull();
  });

  it("原本整張表放得下、變寬後才超出面板：捲到最右", () => {
    expect(keepRightEdge(600, 700, 0, 760, 700)).toBe(60);
  });

  it("變寬後仍放得下：捲動位置維持 0", () => {
    expect(keepRightEdge(500, 700, 0, 600, 700)).toBe(0);
  });
});
