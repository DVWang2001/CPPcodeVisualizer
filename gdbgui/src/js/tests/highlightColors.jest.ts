import { highlightStyle, HIGHLIGHT_TABLE } from "../highlightColors";

// WCAG 2 relative luminance / contrast ratio, for the legibility guarantee below.
function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

describe("highlightStyle", () => {
  it("softens the colours teachers actually write and keeps the name as identity", () => {
    expect(highlightStyle("lightblue")).toEqual({ name: "lightblue", bg: "#c6e2fa", border: "#2f7fc8", known: true });
    expect(highlightStyle("orange")).toEqual({ name: "orange", bg: "#ffcb8f", border: "#d9730d", known: true });
    expect(highlightStyle("lime").bg).toBe("#d3ee97"); // 不再是螢光綠 #00ff00
    expect(highlightStyle("pink").bg).toBe("#f8cbdf");
  });

  it("default is the animation focus: soft yellow fill with a dark-gold edge", () => {
    expect(highlightStyle("default")).toEqual({
      name: "default",
      bg: "var(--highlight-soft)",
      border: "var(--highlight-strong)",
      known: true,
    });
  });

  it("looks up case- and space-insensitively but returns the name verbatim (pop:/pull: match on it)", () => {
    const p = highlightStyle(" Green ");
    expect(p.name).toBe(" Green ");
    expect(p.bg).toBe("#d7f0df");
    expect(p.known).toBe(true);
  });

  it("blue stays a real blue, distinct from the iris violet that means 等下一層", () => {
    expect(highlightStyle("blue").border).toBe("#2f6db5");
    expect(highlightStyle("blue").border).not.toBe("#4a3aa0");
  });

  it("passes unknown names and raw colours through unchanged, marked unknown", () => {
    expect(highlightStyle("cyan")).toEqual({ name: "cyan", bg: "cyan", border: "cyan", known: false });
    expect(highlightStyle("#ff0000")).toEqual({ name: "#ff0000", bg: "#ff0000", border: "#ff0000", known: false });
  });

  it("every table colour keeps --ink text readable (>= 11:1), which is why cells use --ink", () => {
    // Object.keys, not Object.entries: tsconfig's lib is es2015.
    for (const name of Object.keys(HIGHLIGHT_TABLE)) {
      expect({ name, ratio: contrast("#1e1b2e", HIGHLIGHT_TABLE[name].bg) >= 11 }).toEqual({ name, ratio: true });
    }
  });
});
