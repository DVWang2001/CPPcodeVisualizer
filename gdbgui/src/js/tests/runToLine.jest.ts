import { isRunnableLine, nearestRunnableLine } from "../runToLine";

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
