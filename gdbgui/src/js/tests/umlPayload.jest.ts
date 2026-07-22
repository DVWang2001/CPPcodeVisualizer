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

test("flattens gdb access pseudo-nodes (public/private/protected) to reach real fields", () => {
    // real gdb shape for a class with `public:` members — fields live one level under `public`
    const p = buildUmlPayload("p", "Point", [
        {
            exp: "public",
            name: "uvar.public",
            value: "",
            children: [
                { exp: "x", name: "uvar.public.x", value: "3" },
                { exp: "y", name: "uvar.public.y", value: "7" },
                { exp: "label", name: "uvar.public.label", value: "\"origin\"" },
            ],
        },
    ]);
    expect(p.fields).toEqual([
        { name: "x", value: "3" },
        { name: "y", value: "7" },
        { name: "label", value: "\"origin\"" },
    ]);
});

test("flattens multiple access sections and skips base subobject", () => {
    const p = buildUmlPayload("d", "Dog", [
        { exp: "<Animal>", name: "d.<Animal>", value: "..." },
        { exp: "private", name: "d.private", children: [{ exp: "age", name: "d.private.age", value: "4" }] },
        { exp: "public", name: "d.public", children: [{ exp: "breed", name: "d.public.breed", value: "\"Corgi\"" }] },
    ]);
    expect(p.fields).toEqual([
        { name: "age", value: "4" },
        { name: "breed", value: "\"Corgi\"" },
    ]);
});

test("undefined value becomes '?'", () => {
    const p = buildUmlPayload("n", "Node", [{ exp: "x", name: "var1.x" }]);
    expect(p.fields[0].value).toBe("?");
});
