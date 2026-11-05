import { parseLineBody, parseAnnotations, serializeAnnotation, parseLineAnnotation, upsertLineAnnotation } from "../sourceAnnotations";

describe("@bug annotation (why the line is wrong)", () => {
  test("parses @bug alongside the other fields", () => {
    const a = parseLineBody("@guide 整數 @bug 13! 超過 int 的範圍，數字會繞回 @tts [next] 注意結果");
    expect(a.guide).toBe("整數");
    expect(a.bug).toBe("13! 超過 int 的範圍，數字會繞回");
    expect(a.tts).toBe("[next] 注意結果");
  });

  test("parseAnnotations returns a per-line bug map", () => {
    const code = "int a;\nint b; //@ @bug 這行沒初始化\nint c; //@ @guide x";
    const r = parseAnnotations(code);
    expect(r.bug).toEqual({ "2": "這行沒初始化" });
    expect(r.guide).toEqual({ "3": "x" });
  });

  test("serialize then parse round-trips @bug, including a newline", () => {
    const text = serializeAnnotation({ guide: "", tts: "", layout: "", bug: "第一行\n第二行" });
    expect(text).toContain("@bug ");
    expect(parseLineBody(text.replace(/^\/\/@ /, "")).bug).toBe("第一行\n第二行");
  });

  test("saving a line without touching @bug keeps the existing bug note", () => {
    const line = "  x = 2; //@ @bug 覆寫前的值";
    const bug = parseLineAnnotation(line).bug || "";
    const saved = upsertLineAnnotation("  x = 2;", { guide: "改了", tts: "", layout: "", bug });
    expect(parseLineAnnotation(saved).bug).toBe("覆寫前的值");
    expect(parseLineAnnotation(saved).guide).toBe("改了");
  });
});
