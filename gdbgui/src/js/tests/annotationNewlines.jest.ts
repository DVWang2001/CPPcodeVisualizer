import { normalizeBundle } from "../bundleAdapter";
import { parseAnnotations } from "../sourceAnnotations";

// Reproduction of the 02_collatz.json import failure: tts values contain real
// newlines, which must NOT corrupt the single-line source when baked into //@.
const SRC = "#include <iostream>\nusing namespace std;\n\nint main() {\n    int n = 6;\n    while (n != 1) {\n        if (n % 2 == 0) {\n            n = n / 2;\n        } else {\n            n = 3 * n + 1;\n        }\n    }\n    return 0;\n}";

const V1 = {
  version: "1.0",
  source_code: SRC,
  line_data: {
    "5": { guide: "", tts: "[speed:1.5][continue]第一行\n1. 偶數除2\n2. 奇數乘3加1\n收束成1", layout: "sidebar:70 open:visualizer" },
    "7": { guide: "{n}", tts: "[speed:2][continue]判斷 {n} | @3現在是{n}" },
  },
  breakpoints: [],
  program_input: "",
};

test("newline in tts must not add lines to source_code", () => {
  const origLineCount = SRC.split("\n").length; // 14
  const v2 = normalizeBundle(V1);
  // The source must keep the same number of lines (annotations are trailing),
  // so breakpoint line numbers stay aligned.
  expect(v2.source_code.split("\n").length).toBe(origLineCount);
  // Line 7 must still be the real code, not a fragment of the tts narration.
  expect(v2.source_code.split("\n")[6]).toContain("if (n % 2 == 0)");
});

test("multi-line tts round-trips back through parseAnnotations", () => {
  const v2 = normalizeBundle(V1);
  const back = parseAnnotations(v2.source_code);
  // The full multi-line narration must survive, newlines intact.
  expect(back.tts["5"]).toBe(V1.line_data["5"].tts);
});
