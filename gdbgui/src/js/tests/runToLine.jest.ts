import { isRunnableLine, nearestRunnableLine, decideEnter, Visit } from "../runToLine";

describe("decideEnter", () => {
  const v: Visit = { requested: 7, line: 7, code: "A", k: 1, n: 3 };
  test("same line, same code, still paused there, not last → continue", () => {
    expect(decideEnter(v, 7, "A", 7)).toBe("continue");
    expect(decideEnter({ ...v, k: 2 }, 7, "A", 7)).toBe("continue");
  });
  test("last visit wraps back to the first (fresh run)", () => {
    expect(decideEnter({ ...v, k: 3 }, 7, "A", 7)).toBe("fresh");
  });
  test("edited code, other line, not paused there, or n unknown → fresh", () => {
    expect(decideEnter(v, 7, "B", 7)).toBe("fresh");
    expect(decideEnter(v, 5, "A", 7)).toBe("fresh");
    expect(decideEnter(v, 7, "A", 9)).toBe("fresh");
    expect(decideEnter(v, 7, "A", null)).toBe("fresh");
    expect(decideEnter({ ...v, n: null }, 7, "A", 7)).toBe("fresh");
    expect(decideEnter(null, 7, "A", 7)).toBe("fresh");
  });
  test("n = 1 never continues", () => {
    expect(decideEnter({ ...v, n: 1 }, 7, "A", 7)).toBe("fresh");
  });
});

describe("isRunnableLine", () => {
  test.each([
    ["    int sum = 0;", true],
    ["    for (int i = 1; i <= 3; i++) {   //@ @tts hi", true],
    ["    sum += i;   //@ @tts hi", true],
    ["    cout << sum << endl;", true],
    ["    return 0;", true],
    ["    if (n <= 1) return 1;", true],
    ["", false],
    ["#include <iostream>", false],
    ["using namespace std;", false],
    ["}", false],
    ["    } else {", false],
    ["int main() {", false],
    ["int main() {   //@ @layout open:visualizer", false],
    ["void f(int a, int b) const {", false],
    ["// 只是註解", false],
  ])("%j -> %s", (text, expected) => {
    expect(isRunnableLine(text as string)).toBe(expected);
  });
});

describe("nearestRunnableLine", () => {
  const src = ["#include <iostream>", "using namespace std;", "", "int main() {", "    int sum = 0;", "}"];
  test("blank / include / header lines move to the next runnable line", () => {
    expect(nearestRunnableLine(src, 1)).toBe(5);
    expect(nearestRunnableLine(src, 3)).toBe(5);
    expect(nearestRunnableLine(src, 4)).toBe(5);
  });
  test("a runnable line stays", () => {
    expect(nearestRunnableLine(src, 5)).toBe(5);
  });
  test("nothing runnable below: keep the original line", () => {
    expect(nearestRunnableLine(src, 6)).toBe(6);
  });
});
