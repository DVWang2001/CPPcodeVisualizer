import { nextScrollLeft } from "../traceScroll";

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
