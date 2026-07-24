import { buildUmlPayload } from "../umlPayload";

test("maps children to name=value fields, using the real gdb `.exp` member name", () => {
    const p = buildUmlPayload("head", "Node *", [
        { exp: "data", name: "var1.data", value: "5" },
        { exp: "next", name: "var1.next", value: "0x61f0" },
    ]);
    expect(p.name).toBe("head");
    expect(p.className).toBe("Node *");
    expect(p.fields).toEqual([
        { name: "data", value: "5", vis: "+" },
        { name: "next", value: "0x61f0", vis: "+" },
    ]);
});

test("falls back to child.expression (split on '.'/'->') when there is no .exp", () => {
    const p = buildUmlPayload("head", "Node *", [{ expression: "head->data", value: "5" }]);
    expect(p.fields).toEqual([{ name: "data", value: "5", vis: "+" }]);
});

test("falls back to child.name when there is no .exp or .expression", () => {
    const p = buildUmlPayload("n", "Node", [{ name: "x", value: "3" }]);
    expect(p.fields).toEqual([{ name: "x", value: "3", vis: "+" }]);
});

test("skips gdb base-class subobject children (exp starts with '<')", () => {
    const p = buildUmlPayload("d", "Dog", [
        { exp: "<Animal>", name: "var1.<Animal>", value: "..." },
        { exp: "breed", name: "var1.breed", value: "\"Corgi\"" },
    ]);
    expect(p.fields).toEqual([{ name: "breed", value: "\"Corgi\"", vis: "+" }]);
});

test("skips <anonymous...> children (exp starts with '<')", () => {
    const p = buildUmlPayload("u", "Union", [
        { exp: "<anonymous union>", name: "var1.<anonymous union>", value: "..." },
        { exp: "x", name: "var1.x", value: "1" },
    ]);
    expect(p.fields).toEqual([{ name: "x", value: "1", vis: "+" }]);
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
        { name: "x", value: "3", vis: "+" },
        { name: "y", value: "7", vis: "+" },
        { name: "label", value: "\"origin\"", vis: "+" },
    ]);
});

test("tags each field with the visibility of its enclosing access section (+ / - / #)", () => {
    const p = buildUmlPayload("w", "Widget", [
        { exp: "public", children: [{ exp: "id", value: "1", numchild: 0 }] },
        { exp: "protected", children: [{ exp: "tag", value: "2", numchild: 0 }] },
        { exp: "private", children: [{ exp: "secret", value: "3", numchild: 0 }] },
    ]);
    expect(p.fields).toEqual([
        { name: "id", value: "1", vis: "+" },
        { name: "tag", value: "2", vis: "#" },
        { name: "secret", value: "3", vis: "-" },
    ]);
});

test("flattens multiple access sections and skips base subobject", () => {
    const p = buildUmlPayload("d", "Dog", [
        { exp: "<Animal>", name: "d.<Animal>", value: "..." },
        { exp: "private", name: "d.private", children: [{ exp: "age", name: "d.private.age", value: "4" }] },
        { exp: "public", name: "d.public", children: [{ exp: "breed", name: "d.public.breed", value: "\"Corgi\"" }] },
    ]);
    expect(p.fields).toEqual([
        { name: "age", value: "4", vis: "-" },
        { name: "breed", value: "\"Corgi\"", vis: "+" },
    ]);
});

test("undefined value becomes '?'", () => {
    const p = buildUmlPayload("n", "Node", [{ exp: "x", name: "var1.x" }]);
    expect(p.fields[0].value).toBe("?");
});

test("recurses into embedded value-object fields with a qualified path (Rectangle{Point a,b})", () => {
    const point = (x: string, y: string) => [
        { exp: "public", children: [{ exp: "m_x", value: x, numchild: 0 }, { exp: "m_y", value: y, numchild: 0 }] },
    ];
    const p = buildUmlPayload("rec", "Rectangle", [
        {
            exp: "public",
            children: [
                { exp: "a", type: "Point", numchild: 2, value: "{...}", children: point("38", "25") },
                { exp: "b", type: "Point", numchild: 2, value: "{...}", children: point("80", "95") },
            ],
        },
    ]);
    expect(p.fields).toEqual([
        { name: "a.m_x", value: "38", vis: "+" },
        { name: "a.m_y", value: "25", vis: "+" },
        { name: "b.m_x", value: "80", vis: "+" },
        { name: "b.m_y", value: "95", vis: "+" },
    ]);
});

test("expands a vector member into element[i] paths (has-a PVec{vector<Point> m_pts})", () => {
    const point = (x: string, y: string) => [
        { exp: "public", children: [{ exp: "m_x", value: x, numchild: 0 }, { exp: "m_y", value: y, numchild: 0 }] },
    ];
    const p = buildUmlPayload("pts", "PVec", [
        {
            exp: "private",
            children: [
                {
                    exp: "m_pts",
                    type: "std::vector<Point, std::allocator<Point> >",
                    numchild: 2,
                    value: "{...}",
                    children: [
                        { exp: "[0]", type: "Point", numchild: 2, children: point("98", "17") },
                        { exp: "[1]", type: "Point", numchild: 2, children: point("51", "46") },
                    ],
                },
            ],
        },
    ]);
    expect(p.fields).toEqual([
        { name: "m_pts[0].m_x", value: "98", vis: "+" },
        { name: "m_pts[0].m_y", value: "17", vis: "+" },
        { name: "m_pts[1].m_x", value: "51", vis: "+" },
        { name: "m_pts[1].m_y", value: "46", vis: "+" },
    ]);
});

test("is-a container: base vector<> subobject is transparent, elements expand without its type in the path", () => {
    const point = (x: string, y: string) => [
        { exp: "public", children: [{ exp: "m_x", value: x, numchild: 0 }, { exp: "m_y", value: y, numchild: 0 }] },
    ];
    const p = buildUmlPayload("pts", "PVec", [
        {
            exp: "std::vector<Point, std::allocator<Point> >",
            type: "std::vector<Point, std::allocator<Point> >",
            numchild: 1,
            value: "{...}",
            children: [{ exp: "[0]", type: "Point", numchild: 2, children: point("49", "84") }],
        },
    ]);
    expect(p.fields).toEqual([
        { name: "[0].m_x", value: "49", vis: "+" },
        { name: "[0].m_y", value: "84", vis: "+" },
    ]);
});

test("does not follow pointer fields (shows the address as a leaf) — that is P3", () => {
    const p = buildUmlPayload("a", "matrix", [
        {
            exp: "private",
            children: [
                {
                    exp: "data",
                    type: "int *",
                    numchild: 1,
                    value: "0x55555556c2c0",
                    children: [{ exp: "*data", value: "108", numchild: 0 }], // pointee present but must NOT be expanded
                },
                { exp: "mn", type: "int", value: "6", numchild: 0 },
            ],
        },
    ]);
    expect(p.fields).toEqual([
        { name: "data", value: "0x55555556c2c0", vis: "-" },
        { name: "mn", value: "6", vis: "-" },
    ]);
});

test("stops at MAX_DEPTH, emitting the deep aggregate as a {...} leaf", () => {
    // non-transparent nesting b>c>d>e expands (depths 1..4); f sits at parent-depth 4 and is NOT expanded.
    const f = { exp: "f", numchild: 1, value: "{...}", children: [{ exp: "z", value: "9", numchild: 0 }] };
    const e = { exp: "e", numchild: 1, value: "{...}", children: [f] };
    const d = { exp: "d", numchild: 1, value: "{...}", children: [e] };
    const c = { exp: "c", numchild: 1, value: "{...}", children: [d] };
    const b = { exp: "b", numchild: 1, value: "{...}", children: [c] };
    const p = buildUmlPayload("a", "Deep", [{ exp: "public", children: [b] }]);
    expect(p.fields).toEqual([{ name: "b.c.d.e.f", value: "{...}", vis: "+" }]);
});
