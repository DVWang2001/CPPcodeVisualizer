import { buildUmlPayload } from "../umlPayload";

test("maps children to name=value fields, using the real gdb `.exp` member name", () => {
    const p = buildUmlPayload("head", "Node *", [
        { exp: "data", name: "var1.data", value: "5" },
        { exp: "next", name: "var1.next", value: "0x61f0" },
    ]);
    expect(p.name).toBe("head");
    expect(p.className).toBe("Node *");
    expect(p.fields).toEqual([
        { name: "data", value: "5" },
        { name: "next", value: "0x61f0" },
    ]);
});

test("falls back to child.expression (split on '.'/'->') when there is no .exp", () => {
    const p = buildUmlPayload("head", "Node *", [{ expression: "head->data", value: "5" }]);
    expect(p.fields).toEqual([{ name: "data", value: "5" }]);
});

test("falls back to child.name when there is no .exp or .expression", () => {
    const p = buildUmlPayload("n", "Node", [{ name: "x", value: "3" }]);
    expect(p.fields).toEqual([{ name: "x", value: "3" }]);
});

test("skips gdb base-class subobject children (exp starts with '<')", () => {
    const p = buildUmlPayload("d", "Dog", [
        { exp: "<Animal>", name: "var1.<Animal>", value: "..." },
        { exp: "breed", name: "var1.breed", value: "\"Corgi\"" },
    ]);
    expect(p.fields).toEqual([{ name: "breed", value: "\"Corgi\"" }]);
});

test("skips <anonymous...> children (exp starts with '<')", () => {
    const p = buildUmlPayload("u", "Union", [
        { exp: "<anonymous union>", name: "var1.<anonymous union>", value: "..." },
        { exp: "x", name: "var1.x", value: "1" },
    ]);
    expect(p.fields).toEqual([{ name: "x", value: "1" }]);
});

test("undefined value becomes '?'", () => {
    const p = buildUmlPayload("n", "Node", [{ exp: "x", name: "var1.x" }]);
    expect(p.fields[0].value).toBe("?");
});
