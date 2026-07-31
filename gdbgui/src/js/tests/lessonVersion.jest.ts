import {
  hasSnapshotChanges,
  layoutVersionGraph,
  LessonBundle,
  LessonSnapshot,
  VersionSummary
} from "../lessonVersion";

const bundle = (overrides: Partial<LessonBundle> = {}): LessonBundle => ({
  version: "2.0",
  fullname_to_render: "main.cpp",
  source_code: "int main() { return 0; }",
  breakpoints: [],
  program_input: "",
  ...overrides
});

const snapshot = (overrides: Partial<LessonSnapshot> = {}): LessonSnapshot => ({
  version: 1,
  parentVersion: null,
  title: "Original title",
  bundle: bundle(),
  createdAt: "2026-08-01T00:00:00Z",
  ...overrides
});

test("detects a title-only lesson change", () => {
  const original = snapshot();

  expect(
    hasSnapshotChanges(original, { title: "Renamed lesson", bundle: original.bundle })
  ).toBe(true);
});

test("detects source code and inline annotation changes", () => {
  const original = snapshot();

  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ source_code: "int main() { return 1; }" })
    })
  ).toBe(true);
  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ source_code: "int main() { return 0; } //@guide=explain" })
    })
  ).toBe(true);
});

test("detects program input and breakpoint changes", () => {
  const original = snapshot();

  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ program_input: "42" })
    })
  ).toBe(true);
  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ breakpoints: [{ line: 3 }] })
    })
  ).toBe(true);
});

test("ignores recursively reordered object keys", () => {
  const original = snapshot({
    bundle: bundle({
      breakpoints: [{ line: 3, options: { enabled: true, color: "blue" } }],
      extra: { second: { b: 2, a: 1 }, first: "kept" }
    })
  });
  const reordered = bundle({
    extra: { first: "kept", second: { a: 1, b: 2 } },
    breakpoints: [{ options: { color: "blue", enabled: true }, line: 3 }]
  });

  expect(hasSnapshotChanges(original, { title: original.title, bundle: reordered })).toBe(
    false
  );
});

test("lays out a single-parent branch with the current HEAD", () => {
  const versions: VersionSummary[] = [
    { version: 1, parentVersion: null, createdAt: "1" },
    { version: 2, parentVersion: 1, createdAt: "2" },
    { version: 3, parentVersion: 2, createdAt: "3" },
    { version: 4, parentVersion: 3, createdAt: "4" },
    { version: 5, parentVersion: 3, createdAt: "5" }
  ];

  const graph = layoutVersionGraph(versions, 5);

  expect(graph.nodes.map(node => node.version)).toEqual([5, 4, 3, 2, 1]);
  expect(graph.edges).toEqual(
    expect.arrayContaining([
      { from: 2, to: 1 },
      { from: 3, to: 2 },
      { from: 4, to: 3 },
      { from: 5, to: 3 }
    ])
  );
  expect(graph.edges).toHaveLength(4);
  expect(graph.laneCount).toBeGreaterThanOrEqual(2);
  expect(graph.nodes.filter(node => node.isHead).map(node => node.version)).toEqual([5]);
});

test("skips missing or malformed parent edges without throwing", () => {
  const versions: VersionSummary[] = [
    { version: 1, parentVersion: null, createdAt: "1" },
    { version: 2, parentVersion: 99, createdAt: "2" },
    { version: 3, parentVersion: 3, createdAt: "3" }
  ];

  expect(() => layoutVersionGraph(versions, 3)).not.toThrow();
  expect(layoutVersionGraph(versions, 3).edges).toEqual([]);
});
