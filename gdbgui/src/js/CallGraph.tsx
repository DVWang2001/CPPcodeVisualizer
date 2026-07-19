import React from "react";
import { store } from "statorgfc";
import type { CallNode, CallEdge } from "./callTree";

// Layout constants (small teaching trees, ≤ ~30 nodes).
const NODE_W = 150;
const NODE_H = 50;
const GAP_X = 28;
const GAP_Y = 46;
const COL = NODE_W + GAP_X;
const ROW = NODE_H + GAP_Y;
const PAD = 16;

// Desaturated custom-label colors, harmonized with the design tokens.
const CUSTOM_COLORS: Record<string, string> = {
    green: "#3AA76D",
    red: "#DC5B5B",
    blue: "#4F46E5",
};

type CallGraphState = {
    call_graph_updated: number;
    locals: any[];
    paused_on_frame: any;
    expressions: any[];
};

type Placed = CallNode & { x: number; y: number };

class CallGraph extends React.Component<{}, CallGraphState> {
    scrollRef = React.createRef<HTMLDivElement>();
    activeRef = React.createRef<HTMLDivElement>();

    constructor(props: any) {
        super(props);
        this.state = { call_graph_updated: 0, locals: [], paused_on_frame: null, expressions: [] };
        // @ts-expect-error statorgfc augmentation
        store.connectComponentState(this, ["call_graph_updated", "locals", "paused_on_frame", "expressions"]);
    }

    componentDidUpdate() {
        // Keep the current frame in view without yanking the whole tree around.
        if (this.activeRef.current) {
            this.activeRef.current.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    }

    // Expand an array/vector arg or local into [v0, v1, …] when expressions has
    // child values for it; otherwise return the raw value.
    private expand(funcName: string, varName: string, rawValue: any): string {
        const expressions = store.get("expressions") as any[] || [];
        const displayKey = funcName ? `${funcName}::${varName}` : varName;
        const exprObj = expressions.find((o: any) =>
            (o.expression === displayKey || o.expression === varName) && o.in_scope === "true");
        if (exprObj && exprObj.children && exprObj.children.length > 0) {
            return `[${exprObj.children.map((c: any) => c.value ?? "?").join(", ")}]`;
        }
        return rawValue ?? "?";
    }

    // Resolve the text + optional color override for one node.
    private resolveLabel(node: CallNode, isActive: boolean): { lines: string[]; color: string | null; ret: string | null } {
        const gv = (window as any).gdbgui_global_variable || {};
        const argsStr = (node.args || [])
            .map((a: any) => `${a.name}=${this.expand(node.func, a.name, a.value)}`)
            .join(", ");
        let lines = [`${node.func}(${argsStr})`];
        if (node.line) lines.push(`L${node.line}`);
        let color: string | null = null;

        // Teacher-authored custom labels for the active frame's current line.
        const custom = gv.__call_graph_custom_labels;
        if (isActive && custom && node.line && custom[node.line]) {
            const data = custom[node.line];
            const expressions = store.get("expressions") as any[] || [];
            let labelName: string = data.labelName;
            const extra: string[] = [];
            (data.vars || []).forEach((varName: string) => {
                const key = node.func ? `${node.func}::${varName}` : varName;
                const exprObj = expressions.find((o: any) => o.expression === key && o.in_scope === "true")
                    || expressions.find((o: any) => o.expression === varName && o.in_scope === "true");
                const value = exprObj ? this.expand(node.func, varName, exprObj.value) : "...";
                const ph = `{${varName}}`;
                if (labelName.includes(ph)) labelName = labelName.split(ph).join(value);
                else extra.push(`${varName} = ${value}`);
            });
            lines = [`[${labelName}]`, ...extra];
            if (data.color) color = CUSTOM_COLORS[String(data.color).toLowerCase()] || data.color;
        }
        const ret = node.returned && node.retValue !== undefined ? `⇒ ${node.retValue}` : null;
        return { lines, color, ret };
    }

    private layout(nodes: CallNode[]): { placed: Placed[]; width: number; height: number } {
        if (nodes.length === 0) return { placed: [], width: 0, height: 0 };

        const byId = new Map<number, CallNode>(nodes.map(n => [n.invId, n]));
        const children = new Map<number, number[]>();
        const roots: number[] = [];
        for (const n of nodes) {
            if (n.parentInvId != null && byId.has(n.parentInvId)) {
                if (!children.has(n.parentInvId)) children.set(n.parentInvId, []);
                children.get(n.parentInvId)!.push(n.invId);
            } else {
                roots.push(n.invId);
            }
        }

        const depth = new Map<number, number>();
        const xSlot = new Map<number, number>();
        let nextLeaf = 0;
        const walk = (id: number, d: number) => {
            depth.set(id, d);
            const kids = children.get(id) ?? [];
            if (kids.length === 0) {
                xSlot.set(id, nextLeaf++);
            } else {
                kids.forEach(k => walk(k, d + 1));
                xSlot.set(id, (xSlot.get(kids[0])! + xSlot.get(kids[kids.length - 1])!) / 2);
            }
        };
        roots.forEach(r => walk(r, 0));

        const placed: Placed[] = nodes.map(n => ({
            ...n,
            x: PAD + xSlot.get(n.invId)! * COL,
            y: PAD + depth.get(n.invId)! * ROW,
        }));
        const maxDepth = Math.max(...Array.from(depth.values()));
        const width = PAD * 2 + (nextLeaf > 0 ? nextLeaf - 1 : 0) * COL + NODE_W;
        const height = PAD * 2 + maxDepth * ROW + NODE_H;
        return { placed, width, height };
    }

    render() {
        const gv = (window as any).gdbgui_global_variable || {};
        const nodes: CallNode[] = gv.__call_graph_nodes || [];
        const edges: CallEdge[] = gv.__call_graph_edges || [];
        const activeNodeId: number | null = gv.__active_node_id ?? null;
        const activeSet = new Set<number>(gv.__active_path || []);

        if (nodes.length === 0) {
            return (
                <div style={{ padding: "12px", color: "var(--ink-soft)", fontStyle: "italic", fontSize: "0.9em" }}>
                    執行並逐步追蹤後，這裡會畫出函式呼叫樹。
                </div>
            );
        }

        const { placed, width, height } = this.layout(nodes);
        const posById = new Map<number, Placed>(placed.map(p => [p.invId, p]));

        // Active node's locals (excluding params) for the detail strip below.
        const activeNode = activeNodeId != null ? posById.get(activeNodeId) : undefined;
        const locals = (store.get("locals") as any[]) || [];
        let activeLocals: { name: string; value: string }[] = [];
        if (activeNode) {
            const paramNames = (activeNode.args || []).map((a: any) => a.name);
            activeLocals = locals
                .filter((l: any) => !paramNames.includes(l.name))
                .map((l: any) => ({ name: l.name, value: this.expand(activeNode.func, l.name, l.value) }));
        }

        return (
            <div style={{ width: "100%", padding: "6px" }}>
                <div
                    ref={this.scrollRef}
                    style={{
                        width: "100%", height: "360px", overflow: "auto",
                        border: "1px solid var(--line)", borderRadius: "10px",
                        background: "var(--paper)", position: "relative",
                    }}
                >
                    <div style={{ position: "relative", width: `${width}px`, height: `${height}px` }}>
                        <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                            <defs>
                                <marker id="cg-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--struct-border)" />
                                </marker>
                                <marker id="cg-arrow-active" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
                                </marker>
                            </defs>
                            {edges.map(e => {
                                const a = posById.get(e.from);
                                const b = posById.get(e.to);
                                if (!a || !b) return null;
                                const onPath = activeSet.has(e.from) && activeSet.has(e.to);
                                const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
                                const x2 = b.x + NODE_W / 2, y2 = b.y;
                                return (
                                    <line
                                        key={e.id} x1={x1} y1={y1} x2={x2} y2={y2 - 7}
                                        stroke={onPath ? "var(--accent)" : "var(--struct-border)"}
                                        strokeWidth={onPath ? 2 : 1}
                                        markerEnd={`url(#${onPath ? "cg-arrow-active" : "cg-arrow"})`}
                                    />
                                );
                            })}
                            {((gv.__just_returned as number[]) || []).map(id => {
                                const n = posById.get(id);
                                if (!n || n.parentInvId == null || n.retValue === undefined) return null;
                                const p = posById.get(n.parentInvId);
                                if (!p) return null;
                                const mx = (n.x + p.x) / 2 + NODE_W / 2 + 6;
                                const my = (n.y + p.y + NODE_H) / 2 + 4;
                                return (
                                    <text key={`ret-${id}`} x={mx} y={my} fill="#3AA76D"
                                        fontWeight={700} fontSize={12} fontFamily="var(--font-mono)">
                                        {`↑${n.retValue}`}
                                    </text>
                                );
                            })}
                        </svg>

                        {placed.map(node => {
                            const isCurrent = node.invId === activeNodeId;
                            const onPath = activeSet.has(node.invId) && !isCurrent;
                            const { lines, color, ret } = this.resolveLabel(node, isCurrent);

                            let style: React.CSSProperties;
                            if (color) {
                                style = { background: color, border: `1px solid ${color}`, color: "#fff", fontWeight: 600 };
                            } else if (isCurrent) {
                                style = { background: "#fff", border: "2px solid var(--highlight)", color: "var(--ink)", boxShadow: "0 0 0 1px var(--highlight)", fontWeight: 700 };
                            } else if (onPath) {
                                style = { background: "var(--accent-soft)", border: "1px solid var(--accent)", color: "var(--ink)", fontWeight: 600 };
                            } else {
                                style = { background: "#F1F3F5", border: "1px solid #D0D7DE", color: "#99A2AE", fontWeight: 400 };
                            }

                            return (
                                <div
                                    key={node.invId}
                                    ref={isCurrent ? this.activeRef : undefined}
                                    title={lines.join("\n")}
                                    data-invid={node.invId}
                                    data-state={isCurrent ? "current" : onPath ? "active" : node.returned ? "returned" : "live"}
                                    data-ret={node.retValue}
                                    style={{
                                        position: "absolute", left: `${node.x}px`, top: `${node.y}px`,
                                        width: `${NODE_W}px`, minHeight: `${NODE_H}px`, boxSizing: "border-box",
                                        padding: "6px 8px", borderRadius: "8px", fontFamily: "var(--font-mono)",
                                        fontSize: "0.78em", lineHeight: 1.35, textAlign: "center",
                                        display: "flex", flexDirection: "column", justifyContent: "center",
                                        overflow: "hidden", transition: "background 0.15s ease, border-color 0.15s ease, color 0.15s ease",
                                        ...style,
                                    }}
                                >
                                    {lines.map((l, i) => (
                                        <span key={i} style={{
                                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                            fontSize: i === 0 ? "1em" : "0.86em",
                                            opacity: i === 0 ? 1 : 0.8,
                                        }}>{l}</span>
                                    ))}
                                    {ret && (
                                        <span style={{ color: "#3AA76D", fontWeight: 700, fontSize: "0.9em", whiteSpace: "nowrap" }}>
                                            {ret}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {activeNode && activeLocals.length > 0 && (
                    <div style={{
                        marginTop: "6px", padding: "6px 10px", borderRadius: "8px",
                        background: "var(--accent-soft)", border: "1px solid var(--line)",
                        fontFamily: "var(--font-mono)", fontSize: "0.78em", color: "var(--ink)",
                    }}>
                        <span style={{ color: "var(--accent)", fontWeight: 600, marginRight: "8px" }}>
                            {activeNode.func} 區域變數
                        </span>
                        {activeLocals.map((l, i) => (
                            <span key={i} style={{ marginRight: "12px", whiteSpace: "nowrap" }}>
                                {l.name} = {l.value}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        );
    }
}

export default CallGraph;
