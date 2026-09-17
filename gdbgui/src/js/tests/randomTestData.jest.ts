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
