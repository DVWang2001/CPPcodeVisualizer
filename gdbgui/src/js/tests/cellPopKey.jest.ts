import { popCellKey } from "../cellPopKey";

describe("popCellKey", () => {
  test("disabled: key untouched, no className, regardless of highlight", () => {
    expect(popCellKey("2,3", false, { bg: "lightblue" })).toEqual({ key: "2,3", className: undefined });
    expect(popCellKey("2,3", false, null)).toEqual({ key: "2,3", className: undefined });
  });

  test("enabled but no highlight on this cell: key untouched, no className", () => {
    expect(popCellKey("2,3", true, null)).toEqual({ key: "2,3", className: undefined });
  });

  test("enabled and highlighted: key gets the color suffix, cell-pop class applied", () => {
    expect(popCellKey("2,3", true, { bg: "lightblue" })).toEqual({
      key: "2,3-pop-lightblue",
      className: "cell-pop",
    });
  });

  test("same cell, same color across renders: identical key → React won't remount, no repeated pop", () => {
    const a = popCellKey("2,3", true, { bg: "orange" });
    const b = popCellKey("2,3", true, { bg: "orange" });
    expect(a.key).toBe(b.key);
  });

  test("same cell, color changes: key changes → replays the animation", () => {
    const a = popCellKey("2,3", true, { bg: "orange" });
    const b = popCellKey("2,3", true, { bg: "pink" });
    expect(a.key).not.toBe(b.key);
  });

  test("cell becomes unhighlighted: reverts to the bare key, no className", () => {
    expect(popCellKey("2,3", true, undefined)).toEqual({ key: "2,3", className: undefined });
  });
});
