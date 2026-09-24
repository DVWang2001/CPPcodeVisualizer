import { splitForPairing } from "../containerPairing";

describe("splitForPairing", () => {
  test("both named containers present: pairs them, excludes them from rest", () => {
    const r = splitForPairing(["h", "dp", "g", "w"], ["dp", "g"]);
    expect(r.paired).toEqual(["dp", "g"]);
    expect(r.rest).toEqual(["h", "w"]);
  });

  test("rest keeps the original relative order", () => {
    const r = splitForPairing(["a", "dp", "b", "g", "c"], ["dp", "g"]);
    expect(r.rest).toEqual(["a", "b", "c"]);
  });

  test("only one of the pair currently has data: no pairing, nothing dropped", () => {
    const r = splitForPairing(["dp"], ["dp", "g"]);
    expect(r.paired).toBeNull();
    expect(r.rest).toEqual(["dp"]);
  });

  test("neither name present yet: no pairing", () => {
    const r = splitForPairing(["h", "w"], ["dp", "g"]);
    expect(r.paired).toBeNull();
    expect(r.rest).toEqual(["h", "w"]);
  });

  test("no pair set (null): everything stays in rest, unchanged", () => {
    const r = splitForPairing(["dp", "g"], null);
    expect(r.paired).toBeNull();
    expect(r.rest).toEqual(["dp", "g"]);
  });

  test("degenerate pair of the same name twice: refuses to pair a container with itself", () => {
    const r = splitForPairing(["dp", "g"], ["dp", "dp"]);
    expect(r.paired).toBeNull();
    expect(r.rest).toEqual(["dp", "g"]);
  });
});

describe("splitForPairing — 三欄", () => {
  test("三個都有資料：三欄並排，其餘照原順序留在下面", () => {
    const r = splitForPairing(["h", "cost", "dp", "w", "nxt"], ["cost", "dp", "nxt"]);
    expect(r.paired).toEqual(["cost", "dp", "nxt"]);
    expect(r.rest).toEqual(["h", "w"]);
  });

  test("三個名字但只有兩個有資料（nxt 還沒建立）：那兩個先並排，不漏畫", () => {
    const r = splitForPairing(["cost", "dp"], ["cost", "dp", "nxt"]);
    expect(r.paired).toEqual(["cost", "dp"]);
    expect(r.rest).toEqual([]);
  });

  test("三個名字但只有一個有資料：不並排", () => {
    const r = splitForPairing(["cost", "x"], ["cost", "dp", "nxt"]);
    expect(r.paired).toBeNull();
    expect(r.rest).toEqual(["cost", "x"]);
  });

  test("並排的順序照 pair: 寫的順序，不是容器出現的順序", () => {
    expect(splitForPairing(["nxt", "dp", "cost"], ["cost", "dp", "nxt"]).paired).toEqual(["cost", "dp", "nxt"]);
  });

  test("兩個名字時維持原規則：缺一個就整組不排", () => {
    expect(splitForPairing(["dp"], ["dp", "nxt"]).paired).toBeNull();
  });

  test("重複名字或超過三個：不並排", () => {
    expect(splitForPairing(["a", "b", "c"], ["a", "b", "a"]).paired).toBeNull();
    expect(splitForPairing(["a", "b", "c", "d"], ["a", "b", "c", "d"]).paired).toBeNull();
  });
});
