import { codePart, skeletonOf, isCommentOnlyEdit, selectionTouchesCode } from "../tutorialGuard";

const SRC = [
  "int main() {   //@ @layout open:visualizer",
  "    int sum = 0;   //@ @tts [next] hi",
  "    sum += 1;",
  "}",
].join("\n");

describe("codePart / skeletonOf", () => {
  test("cuts at the first // and trims trailing spaces", () => {
    expect(codePart("    int sum = 0;   //@ @tts hi")).toBe("    int sum = 0;");
    expect(codePart("    sum += 1;")).toBe("    sum += 1;");
    expect(codePart("//@ only comment")).toBe("");
  });
  test("skeleton has one entry per line", () => {
    expect(skeletonOf(SRC)).toHaveLength(4);
  });
});

describe("isCommentOnlyEdit", () => {
  const base = skeletonOf(SRC);
  test("editing annotation text is fine", () => {
    expect(isCommentOnlyEdit(base, SRC.replace("@tts [next] hi", "@tts [next] 新的旁白"))).toBe(true);
  });
  test("adding an annotation to a bare line is fine, including char by char", () => {
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1;   //@ @guide {sum}"))).toBe(true);
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1; /"))).toBe(true);
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1; //"))).toBe(true);
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1; "))).toBe(true);
  });
  test("deleting the annotation is fine", () => {
    expect(isCommentOnlyEdit(base, SRC.replace("   //@ @tts [next] hi", ""))).toBe(true);
  });
  test("changing code is rejected", () => {
    expect(isCommentOnlyEdit(base, SRC.replace("sum = 0", "sum = 9"))).toBe(false);
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1;x"))).toBe(false);
    expect(isCommentOnlyEdit(base, SRC.replace("    sum += 1;", "    sum += 1; /x"))).toBe(false);
  });
  test("eating the // so annotation text becomes code is rejected", () => {
    expect(isCommentOnlyEdit(base, SRC.replace("//@ @tts", "/@ @tts"))).toBe(false);
  });
  test("adding or removing lines is rejected", () => {
    expect(isCommentOnlyEdit(base, SRC + "\n")).toBe(false);
    expect(isCommentOnlyEdit(base, SRC.replace("}", "}\n}"))).toBe(false);
    expect(isCommentOnlyEdit(base, SRC.split("\n").slice(1).join("\n"))).toBe(false);
  });
});

describe("selectionTouchesCode", () => {
  const lines = SRC.split("\n");
  const caret = (ln: number, col: number) => ({ startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col });
  test("caret inside or before the code is read-only", () => {
    expect(selectionTouchesCode(lines, [caret(2, 1)])).toBe(true);
    expect(selectionTouchesCode(lines, [caret(2, 10)])).toBe(true);
    expect(selectionTouchesCode(lines, [caret(3, 5)])).toBe(true);
  });
  test("caret right after the code (where //@ goes) or inside the annotation is editable", () => {
    const codeLen = codePart(lines[1]).length; // "    int sum = 0;"
    expect(selectionTouchesCode(lines, [caret(2, codeLen + 1)])).toBe(false);
    expect(selectionTouchesCode(lines, [caret(2, lines[1].length + 1)])).toBe(false);
    expect(selectionTouchesCode(lines, [caret(3, lines[2].length + 1)])).toBe(false);
  });
  test("selection inside the annotation is editable; selection reaching code is not", () => {
    const codeLen = codePart(lines[1]).length;
    expect(selectionTouchesCode(lines, [{ startLineNumber: 2, startColumn: codeLen + 5, endLineNumber: 2, endColumn: lines[1].length + 1 }])).toBe(false);
    expect(selectionTouchesCode(lines, [{ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 8 }])).toBe(true);
    expect(selectionTouchesCode(lines, [{ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 2 }])).toBe(true);
  });
});
