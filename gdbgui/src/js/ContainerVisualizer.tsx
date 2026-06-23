import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import { animScheduler } from "./AnimScheduler";
import { registerPlugin, getPlugin, allPlugins } from "./ContainerPlugin";
import { bstPlugin } from "./BSTPlugin";

// Register all plugins once at module load.
// To add a new container type: create a plugin file and call registerPlugin() here.
registerPlugin(bstPlugin);

type ColorRule = { value: string; color: string };
type HighlightEntry = { index: number; color: string };

function getHighlight(idx: number, highlights: HighlightEntry[] | undefined, len?: number): { bg: string; border: string } | null {
    if (!highlights) return null;
    const h = highlights.find(e => {
        const resolved = (e.index < 0 && len !== undefined) ? len + e.index : e.index;
        return resolved === idx;
    });
    if (!h) return null;
    // 'default' = the animation's focus state → amber (compare/swap).
    // Explicit colors (maze rules, custom highlights) pass through unchanged.
    if (h.color === 'default') return { bg: 'var(--highlight-soft)', border: 'var(--highlight)' };
    return { bg: h.color, border: h.color };
}

type State = {
    mazeMode: Set<string>;
    mazeColorRules: Map<string, ColorRule[]>;
    mazeRuleInput: Map<string, { value: string; color: string }>;
    bstMode: Set<string>;
};

class ContainerVisualizer extends React.Component<{}, State> {
    updateInterval: any;

    constructor(props: {}) {
        super(props);
        this.state = {
            mazeMode: new Set<string>(),
            mazeColorRules: new Map(),
            mazeRuleInput: new Map(),
            bstMode: new Set<string>(),
        };
        // @ts-expect-error ts-migrate(2339)
        store.connectComponentState(this, ["inferior_program", "rbtree_updated", "container_font_size"]);
    }

    componentDidMount() {
        this.updateInterval = setInterval(() => this._pollContainers(), 1000);

        (window as any).gdbgui_request_render = () => this.forceUpdate();
        (window as any).gdbgui_is_bst_mode = (containerName: string) => this.state.bstMode.has(containerName);

        (window as any).gdbgui_set_bst_mode = (containerName: string, enabled: boolean) => {
            this.setState(prev => {
                const next = new Set<string>(prev.bstMode);
                if (enabled) {
                    next.add(containerName);
                } else {
                    next.delete(containerName);
                    // Reset plugin state for this container across all registered plugins
                    allPlugins().forEach(p => p.resetContainer(containerName));
                }
                return { bstMode: next };
            });
        };

        (window as any).gdbgui_set_maze_mode = (containerName: string, enabled: boolean, defaultColorRules?: ColorRule[]) => {
            this.setState(prev => {
                const next = new Set<string>(prev.mazeMode);
                const nextRules = new Map(prev.mazeColorRules);
                if (enabled) {
                    next.add(containerName);
                    if (!nextRules.has(containerName) || nextRules.get(containerName)!.length === 0) {
                        nextRules.set(containerName, defaultColorRules || [
                            { value: '2', color: '#FFD700' },
                            { value: '3', color: '#4488FF' },
                        ]);
                    }
                } else {
                    next.delete(containerName);
                }
                return { mazeMode: next, mazeColorRules: nextRules };
            });
        };
    }

    _pollContainers() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers) { this.forceUpdate(); return; }

        // Reset on program restart
        if (store.get("inferior_program") === "running") {
            allPlugins().forEach(p => p.resetAll());
            animScheduler.resetAll();
            this.forceUpdate();
            return;
        }

        // Clear plugin state for containers that went out of scope
        const bstHistory: any = (global_variable as any).__bst_history || {};
        for (const name in bstHistory) {
            if (!latestContainers.has(name)) {
                bstPlugin.resetContainer(name);
            }
        }

        const requestRender = () => this.forceUpdate();
        let hasOps = false;

        for (const [name, data] of Array.from(latestContainers.entries())) {
            if (!this.state.bstMode.has(name)) continue;
            const plugin = getPlugin(data.type);
            if (!plugin) continue;
            const ops = plugin.diffOps(name, data);
            if (ops.length > 0) {
                hasOps = true;
                animScheduler.pushOps(name, ops, (op) => plugin.animateOp(name, op, requestRender));
            }
        }

        // Auto-open the container collapser when data is present
        if (latestContainers.size > 0) {
            const registry = (window as any).gdbgui_collapser_registry || {};
            if (registry["container"]) registry["container"].open();
        }

        if (!hasOps) {
            this.forceUpdate();
        }
    }

    componentDidUpdate(_prevProps: {}, prevState: State) {
        if ((prevState as any).rbtree_updated !== (this.state as any).rbtree_updated) {
            this._pollContainers();
        }
    }

    componentWillUnmount() {
        if (this.updateInterval) clearInterval(this.updateInterval);
    }

    toggleMazeMode = (name: string) => {
        this.setState(prev => {
            const next = new Set<string>(prev.mazeMode);
            next.has(name) ? next.delete(name) : next.add(name);
            return { mazeMode: next };
        });
    };

    toggleBSTMode = (name: string) => {
        this.setState(prev => {
            const next = new Set<string>(prev.bstMode);
            if (next.has(name)) {
                next.delete(name);
                allPlugins().forEach(p => p.resetContainer(name));
            } else {
                next.add(name);
            }
            return { bstMode: next };
        });
    };

    // ── Maze renderer ─────────────────────────────────────────────────────────

    renderMaze(values: any[][], highlights: HighlightEntry[] | undefined, colorRules: ColorRule[]) {
        const CELL = 20;
        const rows = values.length;
        const cols = rows > 0 ? (values[0] as any[]).length : 0;

        const customColorMap = new Map<number, string>();
        for (const rule of colorRules) {
            const n = parseInt(rule.value);
            if (!isNaN(n) && n !== 0 && n !== 1) customColorMap.set(n, rule.color);
        }

        const mazePosMap = new Map<string, string>();
        if (highlights && cols > 0) {
            for (const h of highlights) {
                const r = Math.floor(h.index / cols);
                const c = h.index % cols;
                mazePosMap.set(`${r},${c}`, h.color === 'default' ? '#f59e0b' : h.color);
            }
        }

        return (
            <div style={{ display: 'inline-block', border: '3px solid #444', lineHeight: 0, boxShadow: '2px 2px 8px rgba(0,0,0,0.35)' }}>
                {values.map((row: any[], rowIdx: number) => (
                    <div key={rowIdx} style={{ display: 'flex' }}>
                        {(row as any[]).map((cell: any, colIdx: number) => {
                            const cellNum = parseInt(cell);
                            const mazeHL = mazePosMap.get(`${rowIdx},${colIdx}`);
                            let bg: string;
                            if (mazeHL) { bg = mazeHL; }
                            else if (cellNum === 0) { bg = '#f5f0e8'; }
                            else if (cellNum === 1) { bg = '#2c2c2c'; }
                            else if (customColorMap.has(cellNum)) { bg = customColorMap.get(cellNum)!; }
                            else { bg = '#888888'; }
                            return (
                                <div key={colIdx} title={`[${rowIdx}][${colIdx}] = ${cell}`} style={{
                                    width: CELL, height: CELL, backgroundColor: bg,
                                    boxSizing: 'border-box',
                                    border: cellNum === 1 ? 'none' : '1px solid rgba(180,160,120,0.25)',
                                }} />
                            );
                        })}
                    </div>
                ))}
            </div>
        );
    }

    // ── Maze color rule editor ────────────────────────────────────────────────

    renderMazeColorEditor(name: string) {
        const rules: ColorRule[] = this.state.mazeColorRules.get(name) || [];
        const input = this.state.mazeRuleInput.get(name) || { value: '', color: '#ff0000' };

        const setInput = (patch: Partial<{ value: string; color: string }>) => {
            this.setState(prev => {
                const next = new Map(prev.mazeRuleInput);
                next.set(name, { ...input, ...patch });
                return { mazeRuleInput: next };
            });
        };

        const addRule = () => {
            const n = parseInt(input.value);
            if (isNaN(n) || n === 0 || n === 1) return;
            this.setState(prev => {
                const next = new Map(prev.mazeColorRules);
                const existing = (next.get(name) || []).filter(r => parseInt(r.value) !== n);
                next.set(name, [...existing, { value: String(n), color: input.color }]);
                return { mazeColorRules: next };
            });
        };

        const removeRule = (v: string) => {
            this.setState(prev => {
                const next = new Map(prev.mazeColorRules);
                next.set(name, (next.get(name) || []).filter(r => r.value !== v));
                return { mazeColorRules: next };
            });
        };

        return (
            <div style={{ marginTop: 8, padding: '8px 10px', backgroundColor: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8, fontSize: '0.82em' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, color: 'var(--ink-soft)' }}>顏色對照：</span>
                    {[{ bg: '#f5f0e8', label: '0 地板' }, { bg: '#2c2c2c', label: '1 牆壁' }].map(({ bg, label }) => (
                        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 14, height: 14, backgroundColor: bg, border: '1px solid #aaa', display: 'inline-block', borderRadius: 2 }} />
                            <span style={{ color: '#777' }}>{label}（固定）</span>
                        </span>
                    ))}
                    {rules.map(r => (
                        <span key={r.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 14, height: 14, backgroundColor: r.color, border: '1px solid #aaa', display: 'inline-block', borderRadius: 2 }} />
                            <span>{r.value}</span>
                            <button onClick={() => removeRule(r.value)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c00', fontWeight: 'bold', padding: '0 2px', lineHeight: 1 }}>×</button>
                        </span>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#555' }}>新增：數字</span>
                    <input type="number" value={input.value} onChange={e => setInput({ value: e.target.value })}
                        placeholder="如 2" style={{ width: 55, padding: '2px 4px', border: '1px solid #bbb', borderRadius: 3 }} />
                    <span style={{ color: '#555' }}>顏色</span>
                    <input type="color" value={input.color} onChange={e => setInput({ color: e.target.value })}
                        style={{ width: 32, height: 24, padding: 1, border: '1px solid #bbb', borderRadius: 3, cursor: 'pointer' }} />
                    <button onClick={addRule}
                        style={{ padding: '2px 12px', backgroundColor: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9em', fontFamily: 'var(--font-body)' }}>
                        新增
                    </button>
                </div>
            </div>
        );
    }

    // ── Container shape renderer ──────────────────────────────────────────────

    renderContainerShape(name: string, data: any, highlights: HighlightEntry[] | undefined) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        const isMazeMode = this.state.mazeMode.has(name);
        const isBSTMode  = this.state.bstMode.has(name);

        // Font sizes scaled from the user-configurable base (default 1.1em)
        const fs     = (store.get("container_font_size") as number) || 1.1;
        const fsPx   = `${fs}em`;
        const fsArrow = `${(fs * 1.27).toFixed(2)}em`;
        const fsBrace = `${(fs * 1.09).toFixed(2)}em`;
        const fsMap   = `${(fs * 0.82).toFixed(2)}em`;

        // ── Unified node language ─────────────────────────────────────────────
        // Every element is the same cell primitive; the container TYPE is shown
        // by frame + connectors, and COLOR only encodes state (resting / focus).
        const cellBase: React.CSSProperties = {
            flex: 1, minWidth: "34px", padding: "12px 10px", textAlign: "center",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-mono)", fontSize: fsPx, color: "var(--ink)", boxSizing: "border-box",
        };
        const restNode: React.CSSProperties = {
            background: "var(--surface)", border: "1px solid var(--struct-border)", borderRadius: "6px", fontWeight: 500,
        };
        const stateStyle = (hl: { bg: string; border: string } | null): React.CSSProperties =>
            hl ? { background: hl.bg, border: `1px solid ${hl.border}`, borderRadius: "6px", fontWeight: 700, boxShadow: `0 0 0 1px ${hl.border}` } : restNode;
        const frame: React.CSSProperties = {
            display: "flex", border: "1px solid var(--line)", borderRadius: "10px",
            background: "var(--paper)", padding: "6px", gap: "4px", width: "100%", alignItems: "stretch",
        };
        const emptyCell: React.CSSProperties = {
            ...cellBase, border: "1px dashed var(--struct-border)", background: "var(--empty-bg)",
            borderRadius: "6px", color: "var(--ink-faint)", fontStyle: "italic",
        };
        const conn = (ch: string, key?: string) => (
            <span key={key} style={{ color: "var(--accent)", fontWeight: 700, fontSize: fsArrow, display: "flex", alignItems: "center", padding: "0 4px" }}>{ch}</span>
        );

        switch (type) {
            case "string":
            case "vector":
            case "array": {
                const rawCap = data.capacity !== undefined ? parseInt(data.capacity) : len;
                const cap = (!isNaN(rawCap) && rawCap >= 0) ? rawCap : len;
                const emptySlots = (cap > len && cap - len < 1000) ? cap - len : 0;
                const is2D = len > 0 && Array.isArray(values[0]);

                if (is2D && isMazeMode) {
                    shape = this.renderMaze(values, highlights, this.state.mazeColorRules.get(name) || []);
                } else if (is2D) {
                    const cols = values.length > 0 ? (values[0] as any[]).length : 0;
                    const hlPosMap2D = new Map<string, { bg: string; border: string }>();
                    if (highlights && cols > 0) {
                        for (const h of highlights) {
                            const hl = getHighlight(h.index, highlights);
                            if (hl) hlPosMap2D.set(`${Math.floor(h.index / cols)},${h.index % cols}`, hl);
                        }
                    }
                    shape = (
                        <div style={{ ...frame, display: "inline-flex", flexDirection: "column", width: "auto" }}>
                            {values.map((row: any[], rowIdx: number) => (
                                <div key={`row-${rowIdx}`} style={{ display: "flex", gap: "4px" }}>
                                    {(row as any[]).map((colVal: string, colIdx: number) => {
                                        const hl2D = hlPosMap2D.get(`${rowIdx},${colIdx}`) || null;
                                        return (
                                            <div key={`col-${rowIdx}-${colIdx}`} style={{ ...cellBase, ...stateStyle(hl2D), padding: "8px 12px", flex: "none" }}>
                                                {type === "string" && colVal !== "" ? `'${colVal}'` : colVal}
                                            </div>
                                        );
                                    })}
                                    {row.length === 0 && <div style={{ ...emptyCell, padding: "8px 12px", flex: "none" }}>empty row</div>}
                                </div>
                            ))}
                        </div>
                    );
                } else {
                    shape = (
                        <div style={{ display: "flex", width: "100%", alignItems: "stretch", gap: "4px" }}>
                            <div style={frame}>
                                {values.map((v: string, idx: number) => {
                                    const hlInfo = getHighlight(idx, highlights, len);
                                    return (
                                        <div key={`val-${idx}`} data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo) }}>
                                            {type === "string" && v !== "" ? `'${v}'` : v}
                                        </div>
                                    );
                                })}
                                {len === 0 && <div style={emptyCell}>empty</div>}
                            </div>
                            {emptySlots > 0 && Array.from({ length: emptySlots }).map((_, idx) => (
                                <div key={`cap-${idx}`} style={{ ...emptyCell, padding: "6px" }} title="未使用容量 (Unused Capacity)" />
                            ))}
                        </div>
                    );
                }
                break;
            }
            case "list":
                shape = (
                    <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            return (
                                <React.Fragment key={idx}>
                                    <div data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo), borderRadius: "999px" }}>{v}</div>
                                    {idx < len - 1 && conn("↔", `c${idx}`)}
                                </React.Fragment>
                            );
                        })}
                        {len === 0 && <div style={{ ...emptyCell, borderRadius: "999px" }}>empty node</div>}
                    </div>
                );
                break;
            case "stack": {
                // LIFO: cells in a frame, with an accent "top" tag marking the open end.
                const endTag = (label: string) => (
                    <span style={{ display: "flex", alignItems: "center", padding: "0 8px", color: "var(--accent)", fontWeight: 700, fontFamily: "var(--font-display)", fontSize: "0.78em", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{label}</span>
                );
                shape = (
                    <div style={{ display: "flex", width: "100%", alignItems: "stretch", gap: "4px" }}>
                        <div style={frame}>
                            {values.map((v: string, idx: number) => {
                                const hlInfo = getHighlight(idx, highlights, len);
                                return (
                                    <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo) }}>{v}</div>
                                );
                            })}
                            {len === 0 && <div style={emptyCell}>empty</div>}
                        </div>
                        {len > 0 && endTag("↑ top")}
                    </div>
                );
                break;
            }
            case "queue":
                // FIFO: accent arrows show direction of flow (rear → front).
                shape = (
                    <div style={{ display: "flex", width: "100%", alignItems: "stretch" }}>
                        {conn("←", "qf")}
                        <div style={frame}>
                            {values.map((v: string, idx: number) => {
                                const hlInfo = getHighlight(idx, highlights, len);
                                return (
                                    <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo) }}>{v}</div>
                                );
                            })}
                            {len === 0 && <div style={emptyCell}>empty</div>}
                        </div>
                        {conn("←", "qb")}
                    </div>
                );
                break;
            case "deque":
                // double-ended: accent arrows on both ends.
                shape = (
                    <div style={{ display: "flex", width: "100%", alignItems: "stretch" }}>
                        {conn("↔", "df")}
                        <div style={frame}>
                            {values.map((v: string, idx: number) => {
                                const hlInfo = getHighlight(idx, highlights, len);
                                return (
                                    <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo) }}>{v}</div>
                                );
                            })}
                            {len === 0 && <div style={emptyCell}>empty</div>}
                        </div>
                        {conn("↔", "db")}
                    </div>
                );
                break;
            case "set":
            case "multiset": {
                if (isBSTMode) {
                    shape = getPlugin(type)?.render(name) ?? null;
                } else {
                    const brace = (ch: string) => (
                        <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: fsBrace, display: "flex", alignItems: "center", padding: "0 8px" }}>{ch}</span>
                    );
                    shape = (
                        <div style={{ display: "flex", width: "100%", alignItems: "stretch" }}>
                            {brace("{")}
                            <div style={frame}>
                                {values.map((v: string, idx: number) => {
                                    const hlInfo = getHighlight(idx, highlights, len);
                                    return (
                                        <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ ...cellBase, ...stateStyle(hlInfo) }}>{v}</div>
                                    );
                                })}
                                {len === 0 && <div style={emptyCell}>empty</div>}
                            </div>
                            {brace("}")}
                        </div>
                    );
                }
                break;
            }
            case "map":
            case "unordered_map":
            case "multimap": {
                if (isBSTMode && type !== "unordered_map") {
                    shape = getPlugin(type)?.render(name) ?? null;
                } else {
                    const pairs: { key: string; value: string }[] = values as any;
                    const thStyle: React.CSSProperties = { padding: "5px 14px", backgroundColor: "var(--accent)", color: "#fff", fontWeight: 600, textAlign: "center", fontFamily: "var(--font-display)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "0.92em" };
                    shape = (
                        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontFamily: "var(--font-mono)", fontSize: fsMap, border: "1px solid var(--line)", borderRadius: "10px", overflow: "hidden" }}>
                            <thead>
                                <tr>
                                    <th style={{ ...thStyle, borderTopLeftRadius: "10px" }}>key</th>
                                    <th style={{ ...thStyle, borderTopRightRadius: "10px" }}>value</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pairs.length === 0 && (
                                    <tr><td colSpan={2} style={{ padding: "6px 14px", color: "var(--ink-faint)", fontStyle: "italic", textAlign: "center" }}>empty</td></tr>
                                )}
                                {pairs.map((pair, idx) => {
                                    const hlInfo = getHighlight(idx, highlights, len);
                                    const rowBg = hlInfo ? hlInfo.bg : (idx % 2 === 0 ? "var(--paper)" : "var(--surface)");
                                    return (
                                        <tr key={idx} data-testid="container-row" data-key={String(pair.key)} data-value={String(pair.value)} style={{ backgroundColor: rowBg }}>
                                            <td style={{ padding: "5px 14px", borderTop: "1px solid var(--line)", borderRight: "2px solid var(--accent-soft)", fontWeight: hlInfo ? 700 : 600, color: "var(--accent)" }}>{pair.key}</td>
                                            <td style={{ padding: "5px 14px", borderTop: "1px solid var(--line)", fontWeight: hlInfo ? 700 : 400, color: "var(--ink)" }}>{pair.value}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    );
                }
                break;
            }
            default:
                shape = <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{values.join(", ")}</span>;
        }

        const displayCapacity = data.capacity !== undefined ? data.capacity : len;
        const showCapacitySize = type === "vector";
        const showSizeOnly = type === "set" || type === "multiset" || type === "map" || type === "unordered_map" || type === "multimap";
        const is2D = len > 0 && Array.isArray(values[0]);
        const showMazeToggle = is2D && (type === "vector" || type === "array");
        const showBSTToggle = type === "set" || type === "multiset" || type === "map" || type === "multimap";

        const chip: React.CSSProperties = { color: "var(--accent)", fontSize: "0.8em", backgroundColor: "var(--accent-soft)", padding: "2px 8px", borderRadius: "999px", fontFamily: "var(--font-mono)", fontWeight: 500 };
        const toggleLabel = (on: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: on ? 600 : 400, fontSize: "0.85em", color: on ? "var(--accent)" : "var(--ink-soft)", userSelect: "none" });

        return (
            <div key={name} data-testid={`container-${name}`} data-container-type={type} style={{ marginBottom: "16px", padding: "12px", border: "1px solid var(--line)", borderRadius: "12px", backgroundColor: "var(--surface)", boxShadow: "0 1px 2px rgba(27,31,36,0.04)" }}>
                <div style={{ marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--ink)" }}>
                        {name}{" "}
                        <span style={{ color: "var(--ink-soft)", fontWeight: 400, fontSize: "0.82em", border: "1px solid var(--line)", borderRadius: "4px", padding: "1px 6px", marginLeft: "2px" }}>{type}</span>
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {showCapacitySize && (
                            <span style={chip}>size {len} · cap {displayCapacity}</span>
                        )}
                        {showSizeOnly && (
                            <span style={chip}>size {len}</span>
                        )}
                        {showMazeToggle && (
                            <label style={toggleLabel(isMazeMode)}>
                                <input type="checkbox" checked={isMazeMode} onChange={() => this.toggleMazeMode(name)} style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                                迷宮模式
                            </label>
                        )}
                        {showBSTToggle && (
                            <label style={toggleLabel(isBSTMode)}>
                                <input type="checkbox" checked={isBSTMode} onChange={() => this.toggleBSTMode(name)} style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                                BST模式
                            </label>
                        )}
                    </div>
                </div>
                <div style={{ overflowX: "auto", display: "flex", justifyContent: "center", padding: "12px 0" }}>
                    <div style={{ width: "90%" }}>
                        {shape}
                    </div>
                </div>
                {isMazeMode && this.renderMazeColorEditor(name)}
            </div>
        );
    }

    render() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers || latestContainers.size === 0) {
            return <div style={{ padding: "12px", color: "var(--ink-soft)", fontStyle: "italic" }}>執行並追蹤程式後，這裡會顯示資料結構。</div>;
        }

        const latestHighlights = (global_variable as any).__latest_highlights as Map<string, HighlightEntry[]> || new Map<string, HighlightEntry[]>();

        return (
            <div style={{ padding: "10px", backgroundColor: "var(--paper)" }}>
                {Array.from(latestContainers.entries()).map(([name, data]) =>
                    this.renderContainerShape(name, data, latestHighlights.get(name))
                )}
            </div>
        );
    }
}

export default ContainerVisualizer;
