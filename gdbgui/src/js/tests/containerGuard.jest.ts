import { looksUnconstructed, MAX_SANE_ELEMENTS } from "../containerGuard";

describe("containerGuard.looksUnconstructed", () => {
  it("擋下負長度 —— 這是實測抓到的真實字串", () => {
    expect(
      looksUnconstructed(
        "std::vector of length -1177, capacity 1953396601734698187"
      )
    ).toBe(true);
  });

  it("擋下荒謬的容量，即使長度看起來正常", () => {
    expect(
      looksUnconstructed("std::vector of length 3, capacity 1953396601734698187")
    ).toBe(true);
  });

  it("擋下 map/set 那種 with N elements 的寫法", () => {
    expect(looksUnconstructed("std::set with -5 elements")).toBe(true);
    expect(looksUnconstructed("std::map with 99999999999 elements")).toBe(true);
  });

  it("放行正常容器", () => {
    expect(looksUnconstructed("std::vector of length 0, capacity 0")).toBe(false);
    expect(looksUnconstructed("std::vector of length 5, capacity 8")).toBe(false);
    expect(looksUnconstructed("std::set with 3 elements")).toBe(false);
    expect(looksUnconstructed("std::map with 1 element")).toBe(false);
  });

  it("放行非容器的值，不誤傷一般變數", () => {
    expect(looksUnconstructed("42")).toBe(false);
    expect(looksUnconstructed("0x7fff1234")).toBe(false);
    expect(looksUnconstructed('"hello"')).toBe(false);
    expect(looksUnconstructed("{...}")).toBe(false);
  });

  it("非字串或空字串一律放行，不因缺值就擋掉展開", () => {
    expect(looksUnconstructed(undefined)).toBe(false);
    expect(looksUnconstructed(null)).toBe(false);
    expect(looksUnconstructed("")).toBe(false);
    expect(looksUnconstructed(123)).toBe(false);
  });

  it("剛好在上限之內放行，超過才擋", () => {
    expect(looksUnconstructed(`std::vector of length ${MAX_SANE_ELEMENTS}, capacity ${MAX_SANE_ELEMENTS}`)).toBe(false);
    expect(looksUnconstructed(`std::vector of length ${MAX_SANE_ELEMENTS + 1}, capacity 0`)).toBe(true);
  });
});
