import { randomTestDataFor } from "../randomTestData";

test("unsupported lessons get no generator", () => {
  expect(randomTestDataFor(null)).toBeNull();
  expect(randomTestDataFor("")).toBeNull();
  expect(randomTestDataFor("dp3_knapsack.cpp")).toBeNull();
});

test("matches by basename regardless of path prefix", () => {
  expect(randomTestDataFor("grid_paths.cpp")).not.toBeNull();
  expect(randomTestDataFor("/workspace/grid_paths.cpp")).not.toBeNull();
  expect(randomTestDataFor("C:\\run\\grid_paths.cpp")).not.toBeNull();
  expect(randomTestDataFor("grid_derivation.cpp")).not.toBeNull();
});

test("grid_paths generator matches its cin sequence: h w, then h lines of w chars", () => {
  const generator = randomTestDataFor("grid_paths.cpp")!;
  const sequence = [0.9, 0.1, /* h=8, w=3 */
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let i = 0;
  const rng = () => sequence[i++];

  const output = generator(rng);
  const lines = output.split("\n");
  expect(lines[0]).toBe("8 3");
  expect(lines.length).toBe(1 + 8 + 1); // "h w" + 8 map rows + trailing empty line from final \n
  for (let row = 1; row <= 8; row++) expect(lines[row]).toHaveLength(3);
});

test("start and end cells are never walls, even when the rng always rolls a wall", () => {
  const generator = randomTestDataFor("grid_paths.cpp")!;
  const rng = () => 0; // < wallRate every time -> every cell would be '#'
  const lines = generator(rng).split("\n");
  const [h, w] = lines[0].split(" ").map(Number);

  expect(lines[1][0]).toBe(".");
  expect(lines[h][w - 1]).toBe(".");
});

test("h and w stay within the 3..8 range across the rng domain", () => {
  const generator = randomTestDataFor("grid_paths.cpp")!;
  for (const edge of [0, 0.999999]) {
    const [h, w] = generator(() => edge).split("\n")[0].split(" ").map(Number);
    expect(h).toBeGreaterThanOrEqual(3);
    expect(h).toBeLessThanOrEqual(8);
    expect(w).toBeGreaterThanOrEqual(3);
    expect(w).toBeLessThanOrEqual(8);
  }
});

describe("// @random script", () => {
  const { runRandomScript } = require("../randomTestData");
  const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

  test("fixed size, matrix with values in range", () => {
    const out = runRandomScript("// @random h = 2\n// @random w = 3\n// @random print h w\n// @random matrix h w 1..9", seq(0, 0.99));
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("2 3");
    expect(lines).toHaveLength(3);
    lines.slice(1).forEach((l: string) => l.split(" ").forEach(x => expect(+x).toBeGreaterThanOrEqual(1)));
  });

  test("distinct gives a permutation", () => {
    const out = runRandomScript("// @random matrix 3 3 1..9 distinct");
    expect(out.trim().split(/\s+/).map(Number).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("errors carry the line number", () => {
    expect(() => runRandomScript("x\n// @random matrix 3 3 1..4 distinct")).toThrow("第 2 行");
    expect(() => runRandomScript("// @random print nope")).toThrow("未宣告");
    expect(() => runRandomScript("// @random bogus 1")).toThrow("不認得");
  });

  test("grid corners; no script -> null", () => {
    const g = runRandomScript("// @random grid 3 3 .# 1 corners", () => 0.5).trim().split("\n");
    expect(g[0][0]).toBe("."); expect(g[2][2]).toBe(".");
    expect(runRandomScript("int main(){}")).toBeNull();
  });

  test("real lessons carry a valid script", () => {
    const fs = require("fs"), path = require("path");
    const root = path.resolve(__dirname, "../../../../examples/lessons");
    for (const dir of fs.readdirSync(root).filter((d: string) => /^技巧[一二]/.test(d))) {
      const f = fs.readdirSync(path.join(root, dir)).find((n: string) => n.endsWith(".cpp"));
      const out = runRandomScript(fs.readFileSync(path.join(root, dir, f), "utf8"));
      expect(out.split("\n")[0]).toMatch(/^\d+ \d+$/);
    }
  });
});
