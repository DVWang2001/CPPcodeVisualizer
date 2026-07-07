import { lineIdentifiers, insertAtCursor, filterCandidates } from "../lineIdentifiers";

describe("lineIdentifiers", () => {
  test("extracts variable-like identifiers, drops keywords/types", () => {
    expect(lineIdentifiers("    if (n % 2 == 0) {")).toEqual(["n"]);
    expect(lineIdentifiers("    int sum = a + b;")).toEqual(["sum", "a", "b"]);
  });
  test("dedupes and ignores numbers/operators", () => {
    expect(lineIdentifiers("x = x + x;")).toEqual(["x"]);
  });
  test("empty / comment-only line returns []", () => {
    expect(lineIdentifiers("    // just a comment")).toEqual([]);
    expect(lineIdentifiers("")).toEqual([]);
  });
});

describe("insertAtCursor", () => {
  test("inserts at caret and advances pos", () => {
    expect(insertAtCursor("ab", 1, "X")).toEqual({ text: "aXb", pos: 2 });
  });
  test("insert at end", () => {
    expect(insertAtCursor("hi", 2, "{n}")).toEqual({ text: "hi{n}", pos: 5 });
  });
});

describe("filterCandidates", () => {
  test("prefix match, case-insensitive, order preserved", () => {
    expect(filterCandidates("s", ["sum", "n", "size", "S2"])).toEqual(["sum", "size", "S2"]);
  });
  test("empty prefix returns all (deduped)", () => {
    expect(filterCandidates("", ["a", "b", "a"])).toEqual(["a", "b"]);
  });
});
