import {
  DRAFT_SKELETON,
  HELLO_WORLD_TEMPLATE,
  isUntouchedTemplate,
  newDraftBundle,
  hasSnapshotChanges,
  layoutVersionGraph,
  mergeLessonBundle,
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

test("detects a lesson quiz edit as a new version change", () => {
  const quiz = {
    schema_version: 1 as 1,
    questions: [
      {
        id: "q1",
        kind: "choice" as "choice",
        prompt: "原題目",
        options: [{ id: "a", text: "0" }, { id: "b", text: "1" }],
        correct_option_id: "b",
        explanation: "解說",
        trigger: {
          kind: "source_line" as "source_line",
          source_file: "main.cpp",
          line: 1,
          anchor: { line_text: "int main() { return 0; }", before_text: "", after_text: "" }
        }
      }
    ]
  };
  const original = snapshot({ bundle: bundle({ quiz }) });
  const changed = JSON.parse(JSON.stringify(quiz));
  changed.questions[0].prompt = "修改後題目";

  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ quiz: changed })
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

test("detects a changed array order", () => {
  const original = snapshot({
    bundle: bundle({ breakpoints: [{ line: 3 }, { line: 7 }] })
  });

  expect(
    hasSnapshotChanges(original, {
      title: original.title,
      bundle: bundle({ breakpoints: [{ line: 7 }, { line: 3 }] })
    })
  ).toBe(true);
});

test("retains opaque bundle fields while replacing editor-owned fields", () => {
  const retained = mergeLessonBundle(
    bundle({ extra_future_field: { keep: ["this"] }, line_data: { legacy: true } }),
    bundle({ source_code: "int main() { return 2; }", program_input: "42" })
  );

  expect(retained).toMatchObject({
    extra_future_field: { keep: ["this"] },
    source_code: "int main() { return 2; }",
    program_input: "42"
  });
  expect(retained.line_data).toBeUndefined();
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
  expect(graph.edges).toEqual([
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 4 },
    { from: 3, to: 5 }
  ]);
  expect(graph.laneCount).toBeGreaterThanOrEqual(2);
  expect(graph.nodes.filter(node => node.isHead).map(node => node.version)).toEqual([5]);
  expect(graph.nodes.find(node => node.version === 3)!.lane).toBe(
    graph.nodes.find(node => node.version === 5)!.lane
  );
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

// ── 開課時要不要重載教案 ──────────────────────────────────────────────────
//
// 這個判斷存在的理由是一次線上事故：開課的副作用會重載教案（fetch 版本 →
// applyProjectBundle），而當它發生在程式正在跑的時候，原始碼與 binary 會被從
// inferior 底下抽掉，下一步就得到 "The program is not being run."
//
// 開課本身不需要改變編輯器裡的內容——只有在載著的版本跟課堂要鎖的版本不同時才需要。

import { needsLessonVersionReload } from "../lessonVersion";

test("載著的就是要鎖的版本 → 不重載", () => {
  expect(needsLessonVersionReload(4, 4, true)).toBe(false);
});

test("版本不同 → 要重載", () => {
  expect(needsLessonVersionReload(3, 4, true)).toBe(true);
});

test("還沒載入任何教案 → 要重載", () => {
  expect(needsLessonVersionReload(null, 4, true)).toBe(true);
});

test("版本相同但沒有 baseline → 仍要重載", () => {
  // 版本號對得上卻沒有快照，代表狀態不完整，跳過重載會讓後續拿不到 bundle
  expect(needsLessonVersionReload(4, 4, false)).toBe(true);
});

describe("新草稿", () => {
  test("造出來的是一份最小的 v2 bundle", () => {
    const b = newDraftBundle();
    expect(b.version).toBe("2.0");
    expect(b.fullname_to_render).toBe("draft.cpp");
    expect(b.source_code).toBe(DRAFT_SKELETON);
    expect(b.breakpoints).toEqual([]);
    expect(b.program_input).toBe("");
  });

  test("每次都是新的物件，改了不會污染下一份草稿", () => {
    const first = newDraftBundle();
    (first.breakpoints as any[]).push({ line: "3" });
    expect(newDraftBundle().breakpoints).toEqual([]);
  });

  test("骨架本身擋在存檔守門外", () => {
    // 守門的用意是「不要讓人開了編輯器直接發布一篇未經修改的模板」。
    // 空白骨架正是一份未經修改的模板——不擋的話，新草稿就成了繞過守門的後門。
    expect(isUntouchedTemplate(DRAFT_SKELETON)).toBe(true);
    expect(isUntouchedTemplate("\n" + DRAFT_SKELETON + "  ")).toBe(true);
  });

  test("原本的 Hello World 模板照樣擋", () => {
    expect(isUntouchedTemplate(HELLO_WORLD_TEMPLATE)).toBe(true);
  });

  test("寫了自己的東西就放行", () => {
    expect(isUntouchedTemplate(DRAFT_SKELETON.replace("return 0;", "int x = 1;\n    return 0;"))).toBe(false);
    expect(isUntouchedTemplate("")).toBe(false);
  });
});
