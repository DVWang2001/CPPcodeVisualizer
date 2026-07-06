import { parseAnnotations } from "../sourceAnnotations";

describe("parseAnnotations", () => {
  test("extracts all three fields keyed by 1-based line number", () => {
    const code = [
      "int a = 1;",                                            // line 1: none
      "int x = 5;  //@ @guide 宣告 x @tts 我們宣告 x @layout open:vec", // line 2
    ].join("\n");
    const r = parseAnnotations(code);
    expect(r.guide).toEqual({ "2": "宣告 x" });
    expect(r.tts).toEqual({ "2": "我們宣告 x" });
    expect(r.layout).toEqual({ "2": "open:vec" });
  });

  test("fields optional and order-independent", () => {
    const code = "f();  //@ @layout maze @tts 走迷宮";
    const r = parseAnnotations(code);
    expect(r.tts).toEqual({ "1": "走迷宮" });
    expect(r.layout).toEqual({ "1": "maze" });
    expect(r.guide).toEqual({});
  });

  test("tts @threshold and {expr} are content, not separators", () => {
    const code = "g();  //@ @tts 值 {x} @5 大於五 @10 大於十";
    const r = parseAnnotations(code);
    expect(r.tts).toEqual({ "1": "值 {x} @5 大於五 @10 大於十" });
  });

  test("plain // comments and empty //@ produce nothing", () => {
    const code = ["int a; // normal", "int b;  //@   "].join("\n");
    expect(parseAnnotations(code)).toEqual({ guide: {}, tts: {}, layout: {} });
  });

  test("trims surrounding whitespace of each field", () => {
    const code = "h();  //@ @guide   spaced   @tts  y ";
    const r = parseAnnotations(code);
    expect(r.guide).toEqual({ "1": "spaced" });
    expect(r.tts).toEqual({ "1": "y" });
  });
});
