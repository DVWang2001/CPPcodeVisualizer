import {
  makeSourceTrigger,
  normalizedSourceLine,
  resolveSourceTrigger,
  triggerMatchesFrame
} from "../quizTrigger";

const original = [
  "int main() {",
  "  int i = 0;",
  "  i++;  //@ @tts next",
  "  return 0;",
  "}"
].join("\n");

test("captures normalized code while ignoring inline lesson directives", () => {
  const trigger = makeSourceTrigger(original, "src/main.cpp", 3);

  expect(trigger).toEqual({
    kind: "source_line",
    source_file: "main.cpp",
    line: 3,
    anchor: {
      line_text: "i++;",
      before_text: "int i = 0;",
      after_text: "return 0;"
    }
  });
  expect(normalizedSourceLine("  int   i = 0; //@ @guide hi")).toBe("int i = 0;");
});

test("relocates a unique three-line anchor after an insertion", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);
  const moved = resolveSourceTrigger(trigger, "// intro\n" + original);

  expect(moved.resolved).toBe(true);
  expect(moved.trigger.line).toBe(4);
});

test("does not guess when the triple is absent or occurs twice", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);
  const duplicate = original + "\n" + original;

  expect(resolveSourceTrigger(trigger, original.replace("i++;", "i += 2;")).resolved).toBe(false);
  expect(resolveSourceTrigger(trigger, duplicate).resolved).toBe(false);
});

test("rejects a blank or out-of-range binding line", () => {
  expect(() => makeSourceTrigger("int x;\n\nreturn 0;", "main.cpp", 2)).toThrow("非空白");
  expect(() => makeSourceTrigger(original, "main.cpp", 0)).toThrow("非空白");
});

test("matches basename and a positive exact line without matching library frames", () => {
  const trigger = makeSourceTrigger(original, "main.cpp", 3);

  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/run/main.cpp", line: "3" })).toBe(true);
  expect(triggerMatchesFrame(trigger, { fullname: "/usr/include/vector", line: "3" })).toBe(false);
  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/run/main.cpp", line: "4" })).toBe(false);
  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/run/main.cpp", line: "0" })).toBe(false);
});

test("uses Windows case-insensitive basename semantics only for Windows paths", () => {
  const trigger = makeSourceTrigger(original, "C:\\lesson\\MAIN.cpp", 3);

  expect(triggerMatchesFrame(trigger, { fullname: "D:\\run\\main.cpp", line: 3 })).toBe(true);
  expect(triggerMatchesFrame(trigger, { fullname: "D:/run/main.cpp", line: 3 })).toBe(true);
  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/main.cpp", line: 3 })).toBe(false);
});

test("matches the fixed sandbox main-file alias used for compiled editor source", () => {
  const trigger = makeSourceTrigger(original, "e2e_containers.cpp", 3);

  expect(triggerMatchesFrame(trigger, { fullname: "/workspace/main.cpp", line: 3 })).toBe(true);
  expect(triggerMatchesFrame(trigger, { fullname: "/tmp/main.cpp", line: 3 })).toBe(false);
});
