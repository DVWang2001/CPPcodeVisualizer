import { buildUmlPayload } from "../umlPayload";

test("maps children to name=value fields, stripping the expression prefix", () => {
    const p = buildUmlPayload("head", "Node *", [
        { expression: "head->data", value: "5" },
        { expression: "head->next", value: "0x61f0" },
    ]);
    expect(p.name).toBe("head");
    expect(p.className).toBe("Node *");
    expect(p.fields).toEqual([
        { name: "data", value: "5" },
        { name: "next", value: "0x61f0" },
    ]);
});

test("falls back to child.name when no dotted/arrow expression", () => {
    const p = buildUmlPayload("n", "Node", [{ name: "x", value: "3" }]);
    expect(p.fields).toEqual([{ name: "x", value: "3" }]);
});

test("skips gdb base-class subobject children (name starts with '<')", () => {
    const p = buildUmlPayload("d", "Dog", [
        { name: "<Animal>", value: "..." },
        { expression: "d.breed", value: "\"Corgi\"" },
    ]);
    expect(p.fields).toEqual([{ name: "breed", value: "\"Corgi\"" }]);
});

test("undefined value becomes '?'", () => {
    const p = buildUmlPayload("n", "Node", [{ expression: "n.x" }]);
    expect(p.fields[0].value).toBe("?");
});
