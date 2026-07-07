import { lineIdentifiers, insertAtCursor, filterCandidates, replaceRange, activeTokenStart } from "../lineIdentifiers";

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

describe("replaceRange", () => {
  test("replaces a partial `{na` token with the completed variable", () => {
    expect(replaceRange("Look at {na", 8, 11, "{name}")).toEqual({ text: "Look at {name}", pos: 14 });
  });
  test("empty range behaves like an insert", () => {
    expect(replaceRange("ab", 1, 1, "X")).toEqual({ text: "aXb", pos: 2 });
  });
  test("out-of-order/oob range clamps safely", () => {
    expect(replaceRange("hi", 5, 1, "Z")).toEqual({ text: "hiZ", pos: 3 });
  });
});

describe("activeTokenStart", () => {
  test("in-progress token ending at caret returns its `{` index", () => {
    expect(activeTokenStart("Look at {na")).toBe(8);
  });
  test("closed token (caret not inside it) returns null", () => {
    expect(activeTokenStart("Look at {name} done")).toBeNull();
  });
  test("no brace at all returns null", () => {
    expect(activeTokenStart("no brace here")).toBeNull();
  });
  test("bare `{` at end of text returns its index", () => {
    expect(activeTokenStart("x {")).toBe(2);
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
