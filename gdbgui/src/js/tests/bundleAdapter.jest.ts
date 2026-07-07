import { normalizeBundle } from "../bundleAdapter";
import { parseAnnotations } from "../sourceAnnotations";

describe("normalizeBundle", () => {
  test("v1 with line_data -> v2 with annotations baked into source_code", () => {
    const v1 = {
      version: "1.0",
      fullname_to_render: "main.cpp",
      source_code: ["int a = 1;", "int x = 5;"].join("\n"),
      line_data: { "2": { guide: "宣告 x", tts: "唸 {x}", layout: "open:vec" } },
      breakpoints: [{ line: 2 }],
      program_input: "hi",
    };
    const v2 = normalizeBundle(v1);
    expect(v2.version).toBe("2.0");
    expect((v2 as any).line_data).toBeUndefined();
    expect(v2.breakpoints).toEqual([{ line: 2 }]);
    expect(v2.program_input).toBe("hi");
    // round-trip: parsing the new source recovers the same maps
    const back = parseAnnotations(v2.source_code);
    expect(back.guide).toEqual({ "2": "宣告 x" });
    expect(back.tts).toEqual({ "2": "唸 {x}" });
    expect(back.layout).toEqual({ "2": "open:vec" });
  });

  test("bundle without line_data is treated as v2 and passed through", () => {
    const v2in = { version: "2.0", fullname_to_render: "a.cpp",
      source_code: "int x;  //@ @tts hi", breakpoints: [], program_input: "" };
    const v2 = normalizeBundle(v2in);
    expect(v2.source_code).toBe("int x;  //@ @tts hi");
    expect(v2.version).toBe("2.0");
  });

  test("line_data line number out of range is skipped", () => {
    const v1 = { version: "1.0", source_code: "int a;",
      line_data: { "9": { guide: "x", tts: "", layout: "" } } };
    const v2 = normalizeBundle(v1);
    expect(v2.source_code).toBe("int a;");
  });

  test("malformed raw returns a safe empty v2 bundle", () => {
    const v2 = normalizeBundle(null);
    expect(v2.version).toBe("2.0");
    expect(v2.source_code).toBe("");
  });
});
