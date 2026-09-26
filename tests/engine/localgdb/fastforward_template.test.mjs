// D11 lock: LocalGdb recognises the `[fast @N]` command by parsing the script TEXT that
// gdbgui/src/js/fastForwardJump.ts produces. If someone changes the template's placeholders or the shape
// the parser relies on, these tests fail loudly (instead of the UI silently falling back to slow stepping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTemplate, buildJumpCommand } from "./ff_template.mjs";
import { parseFastForward, pyJson } from "../../../gdbgui/static/engine/localgdb/fastforward.js";
import { loadGolden } from "./golden_replay.mjs";

test("template placeholders are exactly the ones the parser substitutes", () => {
  const { lines } = readTemplate();
  const text = lines.join("\n");
  assert.deepEqual([...new Set(text.match(/__[A-Z]+__/g))].sort(), ["__BEGIN__", "__END__", "__LIMIT__", "__LINE__", "__NEED__"]);
  assert.match(text, /while _i<__LIMIT__:/, "loop bound line changed: update RE_LIMIT in localgdb/fastforward.js");
  assert.match(text, /if _ln==__LINE__ and _C\.get\(str\(__LINE__\),0\)>=__NEED__:/, "landing condition changed: update RE_TARGET in localgdb/fastforward.js");
  assert.match(text, /print\('__BEGIN__'\+json\.dumps\(\{'stacks':_ST,'counts':_C,'landed':_ok,'steps':_i\}\)\+'__END__'\)/, "blob print changed: update RE_MARKERS / the blob writer");
  assert.ok(!text.includes('"'), "the script must not contain double quotes");
});

test("parseFastForward reads limit / line / need / markers back from the command built with the real template", () => {
  const tpl = readTemplate();
  for (const [line, need, limit] of [[34, 2, 5000], [7, 1, 10], [123, 45, 5000]]) {
    const cmd = buildJumpCommand(line, need, limit, tpl);
    assert.deepEqual(parseFastForward(cmd), { limit, line, need, begin: tpl.begin, end: tpl.end });
  }
});

test("parseFastForward reads the golden sample's command (event 206) and rejects other python commands", () => {
  const ev = loadGolden().find((e) => e.name === "run_gdb_command" && e.data.cmd[0].startsWith("python exec("));
  assert.deepEqual(parseFastForward(ev.data.cmd[0]), { limit: 5000, line: 34, need: 2, begin: "@@FF@@", end: "@@/FF@@" });
  assert.equal(parseFastForward('python print("hi")'), null);
  assert.equal(parseFastForward('python exec("import os")'), null);
  const mismatched = buildJumpCommand(34, 2).replace("str(34)", "str(35)");
  assert.equal(parseFastForward(mismatched), null, "line mismatch between the two occurrences is rejected");
});

test("pyJson matches Python json.dumps (separators, key order incl. integer-like keys, escapes)", () => {
  assert.equal(pyJson(new Map([["counts", new Map([["34", 1], ["33", 2]])], ["ok", true], ["s", 'a"\\\né'], ["n", null], ["l", [1, 2]]])),
    '{"counts": {"34": 1, "33": 2}, "ok": true, "s": "a\\"\\\\\\n\\u00e9", "n": null, "l": [1, 2]}');
});
