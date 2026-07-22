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

export function buildUmlPayload(
    varName: string,
    varType: string,
    children: Array<{ exp?: string; expression?: string; name?: string; value?: any }>,
): UmlPayload {
    const fields: UmlField[] = [];
    for (const c of children || []) {
        const displayName = c.exp ?? c.name ?? "";
        if (displayName.startsWith("<")) continue; // gdb base-class subobject / <anonymous...> → P2
        fields.push({ name: fieldName(c), value: String(c.value ?? "?") });
    }
    return { name: varName, className: varType, fields };
}
