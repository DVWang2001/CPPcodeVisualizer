export type UmlField = { name: string; value: string };
export type UmlPayload = { name: string; className: string; fields: UmlField[] };

type GdbChild = {
    exp?: string;
    expression?: string;
    name?: string;
    value?: any;
    type?: string;
    numchild?: number | string;
    children?: GdbChild[];
};

// gdb groups a C++ class's members under synthetic "public"/"private"/"protected"
// child varobjs (see GdbVariable.tsx:409 — "arent actually field names"); base-class
// subobjects appear as a child whose exp is the base type name (e.g. "<Animal>" or
// "std::vector<Point, ...>"). Both are "transparent": we recurse through them without
// emitting a field or adding a path segment.
const ACCESS_NODES = new Set(["public", "private", "protected"]);
const MAX_DEPTH = 4; // how deep to expand embedded value objects
const MAX_LEAVES = 48; // safety cap on total rendered rows
const MAX_FANOUT = 16; // don't auto-expand an aggregate with more children than this (e.g. a big vector)

function memberName(child: GdbChild): string {
    if (child.exp) return child.exp.trim();
    const expr = child.expression;
    if (expr) {
        const m = expr.split(/->|\./).pop();
        if (m) return m.trim();
    }
    return (child.name ?? "?").trim();
}

function isTransparent(name: string): boolean {
    if (ACCESS_NODES.has(name)) return true;
    if (name.startsWith("<")) return true; // <Animal>, <anonymous union>
    if (/[<:\s]/.test(name)) return true; // template/qualified base-class subobject (std::vector<...>)
    return false;
}

// pointer fields are NOT auto-followed (that is P3 "follow pointers"); show the address as a leaf.
function isPointer(c: GdbChild): boolean {
    return !!c.type && c.type.trim().endsWith("*");
}

function collect(children: GdbChild[] | undefined, prefix: string, depth: number, out: UmlField[]): void {
    for (const c of children || []) {
        if (out.length >= MAX_LEAVES) return;
        const name = memberName(c);
        if (isTransparent(name)) {
            collect(c.children, prefix, depth, out); // pass-through: never emit, never extend the path
            continue;
        }
        const path = name.startsWith("[") ? prefix + name : prefix ? prefix + "." + name : name;
        // Expand only when children are actually loaded and small enough; a struct that was not
        // (or could not be) fetched shows its value ({...}) instead of silently vanishing.
        const kids = c.children || [];
        const expandable = kids.length > 0 && !isPointer(c) && depth < MAX_DEPTH && kids.length <= MAX_FANOUT;
        if (expandable) {
            collect(kids, path, depth + 1, out);
        } else {
            out.push({ name: path, value: String(c.value ?? "?") });
        }
    }
}

export function buildUmlPayload(varName: string, varType: string, children: GdbChild[]): UmlPayload {
    const fields: UmlField[] = [];
    collect(children, "", 0, fields);
    if (fields.length >= MAX_LEAVES) fields.push({ name: "…", value: "(truncated)" });
    return { name: varName, className: varType, fields };
}
