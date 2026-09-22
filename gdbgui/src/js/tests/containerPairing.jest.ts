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
