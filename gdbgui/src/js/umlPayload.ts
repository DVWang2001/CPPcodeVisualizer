export type UmlField = { name: string; value: string };
export type UmlPayload = { name: string; className: string; fields: UmlField[] };

function fieldName(child: { expression?: string; name?: string }): string {
    const expr = child.expression;
    if (expr) {
        // last segment after the final '.' or '->'
        const m = expr.split(/->|\./).pop();
        if (m) return m.trim();
    }
    return (child.name ?? "?").trim();
}

export function buildUmlPayload(
    varName: string,
    varType: string,
    children: Array<{ expression?: string; name?: string; value?: any }>,
): UmlPayload {
    const fields: UmlField[] = [];
    for (const c of children || []) {
        if ((c.name ?? "").startsWith("<")) continue; // gdb base-class subobject → P2
        fields.push({ name: fieldName(c), value: String(c.value ?? "?") });
    }
    return { name: varName, className: varType, fields };
}
