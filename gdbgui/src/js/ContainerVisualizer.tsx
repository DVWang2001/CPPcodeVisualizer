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
    if (h.color === 'default') return { bg: '#fff6b3', border: '#cca300' };
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
        store.connectComponentState(this, ["inferior_program", "rbtree_updated"]);
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
                mazePosMap.set(`${r},${c}`, h.color === 'default' ? '#ff6b35' : h.color);
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
            <div style={{ marginTop: 8, padding: '6px 8px', backgroundColor: '#f9f6f0', border: '1px solid #ddd', borderRadius: 4, fontSize: '0.82em' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 'bold', color: '#555' }}>顏色對照：</span>
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
                        style={{ padding: '2px 10px', backgroundColor: '#b05000', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: '0.9em' }}>
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
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', backgroundColor: '#f9f9f9', padding: '6px', border: '2px solid #333', borderRadius: '6px' }}>
                            {values.map((row: any[], rowIdx: number) => (
                                <div key={`row-${rowIdx}`} style={{ display: 'flex', gap: '3px' }}>
                                    {(row as any[]).map((colVal: string, colIdx: number) => {
                                        const hlInfo2D = hlPosMap2D.get(`${rowIdx},${colIdx}`);
                                        return (
                                            <div key={`col-${rowIdx}-${colIdx}`} style={{ border: `1px solid ${hlInfo2D ? hlInfo2D.border : '#888'}`, padding: '4px 10px', minWidth: '35px', textAlign: 'center', backgroundColor: hlInfo2D ? hlInfo2D.bg : '#fff', fontWeight: hlInfo2D ? 'bold' : 'normal', borderRadius: '3px', boxShadow: '1px 1px 3px rgba(0,0,0,0.1)' }}>
                                                {type === "string" && colVal !== "" ? `'${colVal}'` : colVal}
                                            </div>
                                        );
                                    })}
                                    {row.length === 0 && <div style={{ padding: '4px 10px', color: '#999', fontStyle: 'italic', border: '1px dashed #999', backgroundColor: '#fff', borderRadius: '3px' }}>empty row</div>}
                                </div>
                            ))}
                        </div>
                    );
                } else {
                    shape = (
                        <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', gap: '4px' }}>
                            <div style={{ display: 'flex', flex: 1, border: '2px solid #333', borderRadius: '6px', backgroundColor: '#f9f9f9', overflow: 'hidden' }}>
                                {values.map((v: string, idx: number) => {
                                    const hlInfo = getHighlight(idx, highlights, len);
                                    return (
                                        <div key={`val-${idx}`} data-testid="container-cell" data-value={String(v)} style={{ flex: 1, padding: '18px 6px', borderRight: idx < len - 1 ? '1px solid #777' : 'none', minWidth: '32px', textAlign: 'center', backgroundColor: hlInfo ? hlInfo.bg : 'transparent', fontWeight: hlInfo ? 'bold' : 'normal', fontSize: '1.1em' }}>
                                            {type === "string" && v !== "" ? `'${v}'` : v}
                                        </div>
                                    );
                                })}
                                {len === 0 && <div style={{ flex: 1, padding: '18px 6px', color: '#999', fontStyle: 'italic', textAlign: 'center' }}>empty</div>}
                            </div>
                            {emptySlots > 0 && Array.from({ length: emptySlots }).map((_, idx) => (
                                <div key={`cap-${idx}`} style={{ flex: 1, minWidth: '32px', border: '2px dashed #aaa', backgroundColor: '#f0f0f0', borderRadius: '4px' }} title="Unused Capacity" />
                            ))}
                        </div>
                    );
                }
                break;
            }
            case "list":
                shape = (
                    <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            return (
                                <React.Fragment key={idx}>
                                    <div data-testid="container-cell" data-value={String(v)} style={{ flex: 1, padding: '18px 6px', borderRadius: '16px', border: `2px solid ${hlInfo ? hlInfo.border : '#0056b3'}`, backgroundColor: hlInfo ? hlInfo.bg : '#e6f2ff', minWidth: '32px', textAlign: 'center', fontWeight: hlInfo ? 'bold' : 'normal', fontSize: '1.1em' }}>{v}</div>
                                    {idx < len - 1 && <span style={{ color: '#0056b3', fontWeight: 'bold', fontSize: '1.1em' }}>&harr;</span>}
                                </React.Fragment>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, padding: '18px 6px', borderRadius: '16px', border: '2px dashed #0056b3', color: '#999', fontStyle: 'italic', textAlign: 'center' }}>empty node</div>}
                    </div>
                );
                break;
            case "stack":
                shape = (
                    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', border: '3px solid #b30000', borderRight: 'none', borderTopLeftRadius: '8px', borderBottomLeftRadius: '8px', alignItems: 'stretch', backgroundColor: '#fff' }}>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            return (
                                <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ flex: 1, borderRight: idx < len - 1 ? `2px solid ${hlInfo ? hlInfo.border : '#ff6666'}` : 'none', padding: '18px 6px', textAlign: 'center', backgroundColor: hlInfo ? hlInfo.bg : '#ffe6e6', minWidth: '32px', fontWeight: hlInfo ? 'bold' : 'normal', fontSize: '1.1em' }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 10px', textAlign: 'center' }}>empty</div>}
                    </div>
                );
                break;
            case "queue":
                shape = (
                    <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', backgroundColor: '#f0fff0', borderTop: '3px solid #00b300', borderBottom: '3px solid #00b300' }}>
                        <span style={{ color: '#00b300', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&larr;</span>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            return (
                                <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ flex: 1, borderRight: idx < len - 1 ? `${hlInfo ? '2px solid' : '2px dashed'} ${hlInfo ? hlInfo.border : '#66cc66'}` : 'none', padding: '18px 6px', backgroundColor: hlInfo ? hlInfo.bg : '#fff', textAlign: 'center', fontWeight: hlInfo ? 'bold' : 'normal', fontSize: '1.1em', minWidth: '32px' }}>{v}</div>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 8px', textAlign: 'center' }}>empty</div>}
                        <span style={{ color: '#00b300', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&larr;</span>
                    </div>
                );
                break;
            case "deque":
                shape = (
                    <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', borderBottom: '4px solid #6600cc' }}>
                        <span style={{ color: '#6600cc', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&harr;</span>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            return (
                                <div key={idx} data-testid="container-cell" data-value={String(v)} style={{ flex: 1, padding: '18px 6px', borderRight: idx < len - 1 ? `2px solid ${hlInfo ? hlInfo.border : '#b366ff'}` : 'none', backgroundColor: hlInfo ? hlInfo.bg : '#f9f2ff', borderRadius: '4px', textAlign: 'center', fontWeight: hlInfo ? 'bold' : 'normal', fontSize: '1.1em', minWidth: '32px' }}>{v}</div>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 10px', textAlign: 'center' }}>empty</div>}
                        <span style={{ color: '#6600cc', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&harr;</span>
                    </div>
                );
                break;
            case "set":
            case "multiset": {
                if (isBSTMode) {
                    shape = getPlugin(type)?.render(name) ?? null;
                } else {
                    shape = (
                        <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', border: '2px solid #009688', borderRadius: '12px', backgroundColor: '#e0f2f1', overflow: 'hidden' }}>
                            <span style={{ color: '#009688', fontWeight: 'bold', fontSize: '1.2em', display: 'flex', alignItems: 'center', padding: '0 8px' }}>{`{`}</span>
                            {values.map((v: string, idx: number) => {
                                const hlInfo = getHighlight(idx, highlights, len);
                                return (
                                    <React.Fragment key={idx}>
                                        <div data-testid="container-cell" data-value={String(v)} style={{ flex: 1, padding: '18px 6px', borderRight: idx < len - 1 ? '1px solid #80cbc4' : 'none', border: hlInfo ? `2px solid ${hlInfo.border}` : 'none', backgroundColor: hlInfo ? hlInfo.bg : '#fff', fontWeight: hlInfo ? 'bold' : 'normal', minWidth: '32px', textAlign: 'center', fontFamily: 'monospace', fontSize: '1.1em' }}>{v}</div>
                                    </React.Fragment>
                                );
                            })}
                            {len === 0 && <span style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 10px', textAlign: 'center' }}>empty</span>}
                            <span style={{ color: '#009688', fontWeight: 'bold', fontSize: '1.2em', display: 'flex', alignItems: 'center', padding: '0 8px' }}>{`}`}</span>
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
                    shape = (
                        <table style={{ borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '0.9em' }}>
                            <thead>
                                <tr>
                                    <th style={{ padding: '3px 10px', backgroundColor: '#1565c0', color: '#fff', borderRadius: '4px 0 0 0', fontWeight: 'bold', textAlign: 'center' }}>key</th>
                                    <th style={{ padding: '3px 10px', backgroundColor: '#1565c0', color: '#fff', borderRadius: '0 4px 0 0', fontWeight: 'bold', textAlign: 'center' }}>value</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pairs.length === 0 && (
                                    <tr><td colSpan={2} style={{ padding: '4px 12px', color: '#999', fontStyle: 'italic', textAlign: 'center', border: '1px solid #90caf9' }}>empty</td></tr>
                                )}
                                {pairs.map((pair, idx) => {
                                    const hlInfo = getHighlight(idx, highlights, len);
                                    return (
                                        <tr key={idx} data-testid="container-row" data-key={String(pair.key)} data-value={String(pair.value)} style={{ backgroundColor: hlInfo ? hlInfo.bg : (idx % 2 === 0 ? '#e3f2fd' : '#fff') }}>
                                            <td style={{ padding: '3px 12px', border: '1px solid #90caf9', fontWeight: hlInfo ? 'bold' : 'normal', color: '#1a237e', borderRight: '2px solid #1565c0' }}>{pair.key}</td>
                                            <td style={{ padding: '3px 12px', border: '1px solid #90caf9', fontWeight: hlInfo ? 'bold' : 'normal', color: '#333' }}>{pair.value}</td>
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
                shape = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{values.join(", ")}</span>;
        }

        const displayCapacity = data.capacity !== undefined ? data.capacity : len;
        const showCapacitySize = type === "vector";
        const showSizeOnly = type === "set" || type === "multiset" || type === "map" || type === "unordered_map" || type === "multimap";
        const is2D = len > 0 && Array.isArray(values[0]);
        const showMazeToggle = is2D && (type === "vector" || type === "array");
        const showBSTToggle = type === "set" || type === "multiset" || type === "map" || type === "multimap";

        return (
            <div key={name} data-testid={`container-${name}`} data-container-type={type} style={{ marginBottom: "16px", padding: "8px", border: "1px solid #ddd", borderRadius: "4px", backgroundColor: "#fff" }}>
                <div style={{ marginBottom: "8px", fontWeight: "bold", fontFamily: "monospace", color: "#333", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                    <span>
                        {name}{" "}
                        <span style={{ color: "#888", fontWeight: "normal", fontSize: "0.9em" }}>({type})</span>
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {showCapacitySize && (
                            <span style={{ color: "#0066cc", fontSize: "0.85em", backgroundColor: "#e6f2ff", padding: "2px 6px", borderRadius: "4px" }}>
                                Size: {len}, Capacity: {displayCapacity}
                            </span>
                        )}
                        {showSizeOnly && (
                            <span style={{ color: "#0066cc", fontSize: "0.85em", backgroundColor: "#e6f2ff", padding: "2px 6px", borderRadius: "4px" }}>
                                Size: {len}
                            </span>
                        )}
                        {showMazeToggle && (
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: "normal", fontSize: "0.85em", color: isMazeMode ? "#b05000" : "#555", userSelect: "none" }}>
                                <input type="checkbox" checked={isMazeMode} onChange={() => this.toggleMazeMode(name)} style={{ cursor: "pointer", accentColor: "#b05000" }} />
                                迷宮模式
                            </label>
                        )}
                        {showBSTToggle && (
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: "normal", fontSize: "0.85em", color: isBSTMode ? "#1565c0" : "#555", userSelect: "none" }}>
                                <input type="checkbox" checked={isBSTMode} onChange={() => this.toggleBSTMode(name)} style={{ cursor: "pointer", accentColor: "#1565c0" }} />
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
            return <div style={{ padding: "10px", color: "#666", fontStyle: "italic" }}>No container data available. Run and trace code to see containers.</div>;
        }

        const latestHighlights = (global_variable as any).__latest_highlights as Map<string, HighlightEntry[]> || new Map<string, HighlightEntry[]>();

        return (
            <div style={{ padding: "10px", backgroundColor: "#fdfdfd" }}>
                {Array.from(latestContainers.entries()).map(([name, data]) =>
                    this.renderContainerShape(name, data, latestHighlights.get(name))
                )}
            </div>
        );
    }
}

export default ContainerVisualizer;
