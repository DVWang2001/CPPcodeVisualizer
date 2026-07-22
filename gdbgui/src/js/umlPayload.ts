export type UmlField = { name: string; value: string };
export type UmlPayload = { name: string; className: string; fields: UmlField[] };

function fieldName(child: { exp?: string; expression?: string; name?: string }): string {
    // real gdb varobj children carry the bare member name in `.exp` (see GdbVariable.tsx:235, :504) —
    // no prefix to strip, use it directly.
    if (child.exp) return child.exp.trim();
    const expr = child.expression;
    if (expr) {
        // defensive fallback: last segment after the final '.' or '->'
        const m = expr.split(/->|\./).pop();
        if (m) return m.trim();
    }
    return (child.name ?? "?").trim();
}

// gdb groups a C++ class's members under synthetic "public"/"private"/"protected"
// child varobjs (see GdbVariable.tsx:409 — "arent actually field names"); the real
// fields are one level deeper. Flatten through them so P1 shows x/y/label, not "public".
const ACCESS_NODES = new Set(["public", "private", "protected"]);

type GdbChild = { exp?: string; expression?: string; name?: string; value?: any; children?: GdbChild[] };

function collectFields(children: GdbChild[] | undefined, out: UmlField[]): void {
    for (const c of children || []) {
        const displayName = (c.exp ?? c.name ?? "").trim();
        if (displayName.startsWith("<")) continue; // gdb base-class subobject / <anonymous...> → P2
        if (ACCESS_NODES.has(displayName)) {
            collectFields(c.children, out); // descend through access pseudo-node, don't emit it
            continue;
        }
        out.push({ name: fieldName(c), value: String(c.value ?? "?") });
    }
}

export function buildUmlPayload(varName: string, varType: string, children: GdbChild[]): UmlPayload {
    const fields: UmlField[] = [];
    collectFields(children, fields);
    return { name: varName, className: varType, fields };
}
