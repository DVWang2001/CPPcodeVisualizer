import { resolveGuideText, resolveGuideSegments } from "../guideText";

const expressions = [
  { expression: "skip", value: "3", in_scope: "true" },
  { expression: "take", value: "5", in_scope: "true" },
  { expression: "knap::i", value: "2", in_scope: "true" },
  { expression: "out_of_scope", value: "9", in_scope: "false" },
];

describe("resolveGuideText", () => {
  test("replaces {var} with the live value", () => {
    expect(resolveGuideText("skip = {skip}", expressions)).toBe("skip = 3");
  });

  test("keeps {var} literal when not found", () => {
    expect(resolveGuideText("missing = {nope}", expressions)).toBe("missing = {nope}");
  });

  test("matches func::var suffix", () => {
    expect(resolveGuideText("第 {i} 件", expressions)).toBe("第 2 件");
  });

  test("ignores out-of-scope expressions", () => {
    expect(resolveGuideText("{out_of_scope}", expressions)).toBe("{out_of_scope}");
  });

  test("returns raw text unchanged when there is no {}", () => {
    expect(resolveGuideText("plain text", expressions)).toBe("plain text");
  });
});

describe("resolveGuideSegments", () => {
  test("splits literal text and substituted values", () => {
    expect(resolveGuideSegments("比較 {skip} vs {take}", expressions)).toEqual([
      { text: "比較 ", isValue: false },
      { text: "3", isValue: true },
      { text: " vs ", isValue: false },
      { text: "5", isValue: true },
    ]);
  });

  test("keeps not-found {var} as a literal segment", () => {
    expect(resolveGuideSegments("value = {nope}", expressions)).toEqual([
      { text: "value = ", isValue: false },
      { text: "{nope}", isValue: false },
    ]);
  });

  test("plain text with no {} is a single literal segment", () => {
    expect(resolveGuideSegments("plain text", expressions)).toEqual([
      { text: "plain text", isValue: false },
    ]);
  });

  test("empty string yields no segments", () => {
    expect(resolveGuideSegments("", expressions)).toEqual([]);
  });
});
