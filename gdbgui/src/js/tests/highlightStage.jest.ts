import { HighlightStage, HighlightEntry } from "../highlightStage";

const O = (index: number): HighlightEntry => ({ index, color: "orange" });
const L = (index: number): HighlightEntry => ({ index, color: "lime" });

function setup(initial: Record<string, HighlightEntry[]> = {}) {
  const live = new Map<string, HighlightEntry[]>(Object.entries(initial));
  const onChange = jest.fn();
  return { live, onChange, stage: new HighlightStage(live, onChange) };
}

describe("HighlightStage", () => {
  test("前後兩步亮同樣的格子：陣列不換、不要求重繪、中途沒有空的狀態", () => {
    const before = [O(3), L(2)];
    const { live, onChange, stage } = setup({ dp: before });
    const seen: number[] = [];

    stage.expect("dp");
    stage.expect("dp");
    seen.push(live.get("dp")!.length); // 預掃描之後：畫面上的高亮還在
    stage.add("dp", O(3));
    seen.push(live.get("dp")!.length); // 只算完一個 token：不能露出半套
    stage.add("dp", L(2));
    seen.push(live.get("dp")!.length);

    expect(seen).toEqual([2, 2, 2]);
    expect(live.get("dp")).toBe(before); // 同一個陣列，沒被換掉
    expect(onChange).not.toHaveBeenCalled();
  });

  test("內容有變：等該容器的 token 全部算完才一次換上", () => {
    const { live, onChange, stage } = setup({ dp: [O(3), L(2)] });
    stage.expect("dp");
    stage.expect("dp");

    stage.add("dp", O(4));
    expect(live.get("dp")).toEqual([O(3), L(2)]); // 還是舊的
    expect(onChange).not.toHaveBeenCalled();

    stage.add("dp", L(3));
    expect(live.get("dp")).toEqual([O(4), L(3)]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("顏色不同也算有變", () => {
    const { live, onChange, stage } = setup({ dp: [O(3)] });
    stage.expect("dp");
    stage.add("dp", L(3));
    expect(live.get("dp")).toEqual([L(3)]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("不同容器各自結算，互不等待", () => {
    const { live, stage } = setup({ a: [O(0)], b: [O(0)] });
    stage.expect("a");
    stage.expect("b");
    stage.expect("b");

    stage.add("a", O(1));
    expect(live.get("a")).toEqual([O(1)]); // a 只有一個 token，馬上換
    stage.add("b", O(1));
    expect(live.get("b")).toEqual([O(0)]); // b 還差一個
    stage.add("b", L(2));
    expect(live.get("b")).toEqual([O(1), L(2)]);
  });

  test("skip 也算這個 token 有結果了：其餘 token 照常換上", () => {
    const { live, stage } = setup({ dp: [O(3), L(2)] });
    stage.expect("dp");
    stage.expect("dp");
    stage.skip("dp");
    stage.add("dp", L(5));
    expect(live.get("dp")).toEqual([L(5)]);
  });

  test("這一行沒有任何高亮結果：清成空（原本『一開始就清空』的語意保留）", () => {
    const { live, onChange, stage } = setup({ dp: [O(3)] });
    stage.expect("dp");
    stage.skip("dp");
    expect(live.get("dp")).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("flush 收尾：等不到的 token 不讓舊高亮永遠殘留", () => {
    const { live, stage } = setup({ dp: [O(3), L(2)] });
    stage.expect("dp");
    stage.expect("dp");
    stage.add("dp", O(7)); // 另一個 token 逾時，永遠不會來
    expect(live.get("dp")).toEqual([O(3), L(2)]);
    stage.flush();
    expect(live.get("dp")).toEqual([O(7)]);
  });

  test("flush 對已經換上的容器不會重複動作", () => {
    const { onChange, stage } = setup({ dp: [O(3)] });
    stage.expect("dp");
    stage.add("dp", O(4));
    stage.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("容器原本沒有高亮紀錄：第一次算出來就建立", () => {
    const { live, onChange, stage } = setup();
    stage.expect("dp");
    stage.add("dp", O(1));
    expect(live.get("dp")).toEqual([O(1)]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
