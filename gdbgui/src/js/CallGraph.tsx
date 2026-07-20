import React from "react";
import { store } from "statorgfc";
import type { CallNode, CallEdge } from "./callTree";
import { layoutTree, Placed, NODE_W, NODE_H } from "./callGraphLayout";

// Desaturated custom-label colors, harmonized with the design tokens.
const CUSTOM_COLORS: Record<string, string> = {
    green: "#3AA76D",
    red: "#DC5B5B",
    blue: "#4F46E5",
};

// Same function + same argument values = the same subproblem.
function argKey(node: CallNode): string {
    return `${node.func}(${(node.args || []).map(a => String(a.value)).join(",")})`;
}

type CallGraphState = {
    call_graph_updated: number;
    locals: any[];
    paused_on_frame: any;
    expressions: any[];
    hoverKey: string | null;
};

class CallGraph extends React.Component<{}, CallGraphState> {
    scrollRef = React.createRef<HTMLDivElement>();
    activeRef = React.createRef<HTMLDivElement>();

    constructor(props: any) {
        super(props);
        this.state = { call_graph_updated: 0, locals: [], paused_on_frame: null, expressions: [], hoverKey: null };
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

        const { placed, width, height } = layoutTree(nodes);

        // Ghost layout override: pin live nodes to their final positions (spec F7).
        const ghost = gv.__ghost as (import("./ghostTree").Ghost | null);
        let liveW = width, liveH = height, usingGhost = false;
        if (ghost) {
            const matched = placed.filter(p => ghost.posBySig.has(p.sig)).length;
            if (matched / placed.length >= 0.6) {
                usingGhost = true;
                placed.forEach(p => {
                    const pos = ghost.posBySig.get(p.sig);
                    if (pos) { p.x = pos.x; p.y = pos.y; }
                });
                liveW = Math.max(width, ghost.width);
                liveH = Math.max(height, ghost.height);
            }
        }
        const placedSigSet = new Set(placed.map(p => p.sig));

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

        // Repeated-subproblem index and recursion depth — recomputed per render (≤30 nodes).
        const keyCounts = new Map<string, number>();
        placed.forEach(p => keyCounts.set(argKey(p), (keyCounts.get(argKey(p)) || 0) + 1));
        const currentKey = activeNode ? argKey(activeNode) : null;
        const recDepth = activeNode
            ? ((gv.__active_path as number[]) || []).filter(id => posById.get(id)?.func === activeNode.func).length
            : 0;

        // Call-site labels: L<line>, with ①② ordinals when siblings share a line.
        const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];
        const siteLabels = new Map<string, string>();
        {
            const kidsByParent = new Map<number, Placed[]>();
            placed.forEach(p => {
                if (p.parentInvId == null) return;
                if (!kidsByParent.has(p.parentInvId)) kidsByParent.set(p.parentInvId, []);
                kidsByParent.get(p.parentInvId)!.push(p);
            });
            kidsByParent.forEach(children => {
                const byLine = new Map<string, Placed[]>();
                children.forEach(c => {
                    if (c.callSiteLine == null || c.callSiteLine === "") return;
                    const L = String(c.callSiteLine);
                    if (!byLine.has(L)) byLine.set(L, []);
                    byLine.get(L)!.push(c);
                });
                byLine.forEach((sibs, L) => {
                    sibs.sort((a, b) =>
                        parseInt(String(a.callSiteAddr ?? "0"), 16) - parseInt(String(b.callSiteAddr ?? "0"), 16));
                    sibs.forEach((c, i) => {
                        siteLabels.set(`${c.parentInvId}->${c.invId}`,
                            sibs.length > 1 ? `L${L}${CIRCLED[i] ?? i + 1}` : `L${L}`);
                    });
                });
            });
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
                    <div style={{ position: "relative", width: `${liveW}px`, height: `${liveH}px` }}>
                        <svg width={liveW} height={liveH} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                            <defs>
                                <marker id="cg-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--struct-border)" />
                                </marker>
                                <marker id="cg-arrow-active" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
                                </marker>
                            </defs>
                            {usingGhost && ghost!.edges.map(e => {
                                const gn = ghost!.nodes;
                                const a = gn.find(n => n.invId === e.from);
                                const b = gn.find(n => n.invId === e.to);
                                if (!a || !b) return null;
                                const liveHasBoth = placedSigSet.has(a.sig) && placedSigSet.has(b.sig);
                                if (liveHasBoth) return null;
                                const pa = ghost!.posBySig.get(a.sig)!, pb = ghost!.posBySig.get(b.sig)!;
                                return (
                                    <line key={`ghost-${e.id}`}
                                        x1={pa.x + NODE_W / 2} y1={pa.y + NODE_H}
                                        x2={pb.x + NODE_W / 2} y2={pb.y}
                                        stroke="var(--struct-border)" strokeWidth={1}
                                        strokeDasharray="4 4" opacity={0.35} />
                                );
                            })}
                            {edges.map(e => {
                                const a = posById.get(e.from);
                                const b = posById.get(e.to);
                                if (!a || !b) return null;
                                const onPath = activeSet.has(e.from) && activeSet.has(e.to);
                                const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
                                const x2 = b.x + NODE_W / 2, y2 = b.y;
                                return (
                                    <g key={e.id}>
                                        <line
                                            x1={x1} y1={y1} x2={x2} y2={y2 - 7}
                                            stroke={onPath ? "var(--accent)" : "var(--struct-border)"}
                                            strokeWidth={onPath ? 2 : 1}
                                            markerEnd={`url(#${onPath ? "cg-arrow-active" : "cg-arrow"})`}
                                        />
                                        {siteLabels.get(e.id) && (
                                            <text
                                                x={x1 + (x2 - x1) * 0.35 + 5}
                                                y={y1 + (y2 - y1) * 0.35}
                                                fill="var(--ink-faint)" fontSize={10}
                                                fontFamily="var(--font-mono)"
                                            >
                                                {siteLabels.get(e.id)}
                                            </text>
                                        )}
                                    </g>
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

                        {usingGhost && ghost!.nodes.filter(n => !placedSigSet.has(n.sig)).map(n => {
                            const pos = ghost!.posBySig.get(n.sig)!;
                            return (
                                <div key={`ghost-${n.sig}`} data-ghost="1"
                                    style={{
                                        position: "absolute", left: `${pos.x}px`, top: `${pos.y}px`,
                                        width: `${NODE_W}px`, minHeight: `${NODE_H}px`, boxSizing: "border-box",
                                        borderRadius: "8px", border: "1.5px dashed var(--struct-border)",
                                        opacity: 0.4, background: "transparent", pointerEvents: "none",
                                    }} />
                            );
                        })}

                        {placed.map(node => {
                            const isCurrent = node.invId === activeNodeId;
                            const onPath = activeSet.has(node.invId) && !isCurrent;
                            const { lines, color, ret } = this.resolveLabel(node, isCurrent);
                            const k = argKey(node);
                            const twins = (keyCounts.get(k) || 0) > 1;
                            const isTwin = this.state.hoverKey === k && twins;
                            const isRepeatHit = twins && !isCurrent && node.returned && currentKey === k;

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
                                    data-argkey={k}
                                    onMouseEnter={() => this.setState({ hoverKey: k })}
                                    onMouseLeave={() => this.setState({ hoverKey: null })}
                                    onClick={() => {
                                        const line = Number(node.line);
                                        const nav = (window as any).gdbgui_navigate_to_error;
                                        if (line > 0 && typeof nav === "function") nav(line, 1);
                                    }}
                                    style={{
                                        position: "absolute", left: `${node.x}px`, top: `${node.y}px`,
                                        width: `${NODE_W}px`, minHeight: `${NODE_H}px`, boxSizing: "border-box",
                                        padding: "6px 8px", borderRadius: "8px", fontFamily: "var(--font-mono)",
                                        fontSize: "0.78em", lineHeight: 1.35, textAlign: "center",
                                        display: "flex", flexDirection: "column", justifyContent: "center",
                                        overflow: "hidden", transition: "background 0.15s ease, border-color 0.15s ease, color 0.15s ease",
                                        cursor: "pointer",
                                        ...style,
                                        ...(isTwin ? { outline: "2px dashed var(--highlight)", outlineOffset: 2 } : {}),
                                        ...(isRepeatHit ? { outline: "2px solid #DC5B5B", outlineOffset: 2, boxShadow: "0 0 6px rgba(220,91,91,0.5)" } : {}),
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
                                    {twins && (
                                        <span style={{
                                            position: "absolute", top: 1, right: 3, background: "#DC5B5B",
                                            color: "#fff", fontSize: 10, fontWeight: 700,
                                            borderRadius: 8, padding: "0 5px", lineHeight: "15px",
                                        }}>
                                            ×{keyCounts.get(k)}
                                        </span>
                                    )}
                                    {isCurrent && recDepth > 1 && (
                                        <span style={{ fontSize: "0.78em", color: "var(--ink-soft)" }}>
                                            第 {recDepth} 層
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
