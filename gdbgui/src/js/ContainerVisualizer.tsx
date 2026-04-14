import React from "react";
import { global_variable } from "./global_variable";

type ColorRule = { value: string; color: string };  // value = 數字字串, color = CSS色碼

type State = {
    mazeMode: Set<string>;
    // per-container 自訂顏色規則（不包含 0/1，那兩個固定）
    mazeColorRules: Map<string, ColorRule[]>;
    // 新增規則時的暫存輸入
    mazeRuleInput: Map<string, { value: string; color: string }>;
};

class ContainerVisualizer extends React.Component<{}, State> {
    updateInterval: any;

    constructor(props: {}) {
        super(props);
        this.state = {
            mazeMode: new Set<string>(),
            mazeColorRules: new Map(),
            mazeRuleInput: new Map(),
        };
    }

    componentDidMount() {
        this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
        // 供 layout 指令（maze:containerName）從外部啟用迷宮模式
        // 可選第三參數 defaultColorRules：初次啟用時自動填入預設顏色規則
        (window as any).gdbgui_set_maze_mode = (containerName: string, enabled: boolean, defaultColorRules?: ColorRule[]) => {
            this.setState(prev => {
                const next = new Set<string>(prev.mazeMode);
                const nextRules = new Map(prev.mazeColorRules);
                if (enabled) {
                    next.add(containerName);
                    // 若尚未設定任何顏色規則，套用預設值
                    if (!nextRules.has(containerName) || nextRules.get(containerName)!.length === 0) {
                        const defaults: ColorRule[] = defaultColorRules || [
                            { value: '2', color: '#FFD700' },  // 最短路徑：金黃色
                            { value: '3', color: '#4488FF' },  // BFS 已探索：藍色
                        ];
                        nextRules.set(containerName, defaults);
                    }
                } else {
                    next.delete(containerName);
                }
                return { mazeMode: next, mazeColorRules: nextRules };
            });
        };
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

    // ── Maze renderer ────────────────────────────────────────────────────────
    renderMaze(values: any[][], highlightIndex: number | undefined, colorRules: ColorRule[]) {
        const CELL = 20; // px per cell
        const rows = values.length;
        const cols = rows > 0 ? (values[0] as any[]).length : 0;

        // 建立 value → color 的查表（排除 0/1 固定色）
        const customColorMap = new Map<number, string>();
        for (const rule of colorRules) {
            const n = parseInt(rule.value);
            if (!isNaN(n) && n !== 0 && n !== 1) {
                customColorMap.set(n, rule.color);
            }
        }

        // Map a flat highlight index → {row, col}
        let highlightPos: { r: number; c: number } | null = null;
        if (highlightIndex !== undefined && cols > 0) {
            highlightPos = { r: Math.floor(highlightIndex / cols), c: highlightIndex % cols };
        }

        return (
            <div style={{ display: 'inline-block', border: '3px solid #444', lineHeight: 0, boxShadow: '2px 2px 8px rgba(0,0,0,0.35)' }}>
                {values.map((row: any[], rowIdx: number) => (
                    <div key={rowIdx} style={{ display: 'flex' }}>
                        {(row as any[]).map((cell: any, colIdx: number) => {
                            const cellNum = parseInt(cell);
                            const isHL = highlightPos !== null && highlightPos.r === rowIdx && highlightPos.c === colIdx;
                            let bg: string;
                            if (isHL) {
                                bg = '#ff6b35';
                            } else if (cellNum === 0) {
                                bg = '#f5f0e8';          // 地板（固定）
                            } else if (cellNum === 1) {
                                bg = '#2c2c2c';          // 牆壁（固定）
                            } else if (customColorMap.has(cellNum)) {
                                bg = customColorMap.get(cellNum)!;
                            } else {
                                bg = '#888888';          // 未定義的數字：灰色
                            }
                            return (
                                <div
                                    key={colIdx}
                                    title={`[${rowIdx}][${colIdx}] = ${cell}`}
                                    style={{
                                        width: CELL,
                                        height: CELL,
                                        backgroundColor: bg,
                                        boxSizing: 'border-box',
                                        border: cellNum === 1 ? 'none' : '1px solid rgba(180,160,120,0.25)',
                                    }}
                                />
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
                {/* 固定色說明 */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 'bold', color: '#555' }}>顏色對照：</span>
                    {[{ n: 0, bg: '#f5f0e8', label: '0 地板' }, { n: 1, bg: '#2c2c2c', label: '1 牆壁' }].map(({ bg, label }) => (
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
                {/* 新增規則 */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#555' }}>新增：數字</span>
                    <input
                        type="number" value={input.value}
                        onChange={e => setInput({ value: e.target.value })}
                        placeholder="如 2"
                        style={{ width: 55, padding: '2px 4px', border: '1px solid #bbb', borderRadius: 3 }}
                    />
                    <span style={{ color: '#555' }}>顏色</span>
                    <input
                        type="color" value={input.color}
                        onChange={e => setInput({ color: e.target.value })}
                        style={{ width: 32, height: 24, padding: 1, border: '1px solid #bbb', borderRadius: 3, cursor: 'pointer' }}
                    />
                    <button
                        onClick={addRule}
                        style={{ padding: '2px 10px', backgroundColor: '#b05000', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: '0.9em' }}
                    >
                        新增
                    </button>
                </div>
            </div>
        );
    }

    // ── Container shape renderer ──────────────────────────────────────────────
    renderContainerShape(name: string, data: any, highlightIndex: number | undefined) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        const isMazeMode = this.state.mazeMode.has(name);

        switch (type) {
            case "string":
            case "vector":
            case "array": {
                const rawCap = data.capacity !== undefined ? parseInt(data.capacity) : len;
                const cap = (!isNaN(rawCap) && rawCap >= 0) ? rawCap : len;
                const emptySlots = (cap > len && cap - len < 1000) ? cap - len : 0;

                const is2D = len > 0 && Array.isArray(values[0]);

                if (is2D && isMazeMode) {
                    // ── Maze view ──
                    shape = this.renderMaze(values, highlightIndex, this.state.mazeColorRules.get(name) || []);
                } else if (is2D) {
                    // ── Default 2D grid view ──
                    shape = (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', backgroundColor: '#f9f9f9', padding: '6px', border: '2px solid #333', borderRadius: '6px' }}>
                            {values.map((row: any[], rowIdx: number) => (
                                <div key={`row-${rowIdx}`} style={{ display: 'flex', gap: '3px' }}>
                                    {(row as any[]).map((colVal: string, colIdx: number) => (
                                        <div key={`col-${rowIdx}-${colIdx}`} style={{ border: '1px solid #888', padding: '4px 10px', minWidth: '35px', textAlign: 'center', backgroundColor: '#fff', borderRadius: '3px', boxShadow: '1px 1px 3px rgba(0,0,0,0.1)' }}>
                                            {type === "string" && colVal !== "" ? `'${colVal}'` : colVal}
                                        </div>
                                    ))}
                                    {row.length === 0 && <div style={{ padding: '4px 10px', color: '#999', fontStyle: 'italic', border: '1px dashed #999', backgroundColor: '#fff', borderRadius: '3px' }}>empty row</div>}
                                </div>
                            ))}
                        </div>
                    );
                } else {
                    shape = (
                        <div style={{ display: 'inline-flex', verticalAlign: 'middle', alignItems: 'stretch', gap: '2px' }}>
                            <div style={{ display: 'inline-flex', border: '2px solid #333', borderRadius: '4px', backgroundColor: '#f9f9f9', overflow: 'hidden' }}>
                                {values.map((v: string, idx: number) => {
                                    const isHighlighted = highlightIndex === idx;
                                    const bgColor = isHighlighted ? '#fff6b3' : 'transparent';
                                    const fontWeight = isHighlighted ? 'bold' : 'normal';
                                    const borderRight = idx < len - 1 ? '1px solid #777' : 'none';
                                    return (
                                        <div key={`val-${idx}`} style={{ padding: '2px 8px', borderRight: borderRight, minWidth: '20px', textAlign: 'center', backgroundColor: bgColor, fontWeight: fontWeight }}>
                                            {type === "string" && v !== "" ? `'${v}'` : v}
                                        </div>
                                    );
                                })}
                                {len === 0 && <div style={{ padding: '2px 8px', color: '#999', fontStyle: 'italic' }}>empty</div>}
                            </div>
                            {emptySlots > 0 && Array.from({ length: emptySlots }).map((_, idx) => (
                                <div key={`cap-${idx}`} style={{ display: 'inline-block', minWidth: '20px', border: '2px dashed #aaa', backgroundColor: '#f0f0f0', borderRadius: '2px' }} title="Unused Capacity" />
                            ))}
                        </div>
                    );
                }
                break;
            }
            case "list":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#e6f2ff';
                            const borderColor = isHighlighted ? '#cca300' : '#0056b3';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <React.Fragment key={idx}>
                                    <div style={{ padding: '4px 10px', borderRadius: '16px', border: `2px solid ${borderColor}`, backgroundColor: bgColor, minWidth: '30px', textAlign: 'center', fontWeight: fontWeight }}>
                                        {v}
                                    </div>
                                    {idx < len - 1 && <span style={{ color: '#0056b3', fontWeight: 'bold' }}>&harr;</span>}
                                </React.Fragment>
                            );
                        })}
                        {len === 0 && <div style={{ padding: '4px 10px', borderRadius: '16px', border: '2px dashed #0056b3', color: '#999', fontStyle: 'italic' }}>empty node</div>}
                    </div>
                );
                break;
            case "stack":
                shape = (
                    <div style={{ display: 'inline-flex', flexDirection: 'row', border: '3px solid #b30000', borderRight: 'none', borderTopLeftRadius: '8px', borderBottomLeftRadius: '8px', padding: '4px', minHeight: '30px', alignItems: 'center', backgroundColor: '#fff', verticalAlign: 'middle', gap: '4px' }}>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#ffe6e6';
                            const borderColor = isHighlighted ? '#cca300' : '#ff6666';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <div key={idx} style={{ border: `2px solid ${borderColor}`, padding: '2px 8px', textAlign: 'center', backgroundColor: bgColor, minWidth: '30px', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '0 10px' }}>empty</div>}
                    </div>
                );
                break;
            case "queue":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', backgroundColor: '#f0fff0', borderTop: '3px solid #00b300', borderBottom: '3px solid #00b300', padding: '4px', gap: '4px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        <span style={{ color: '#00b300', fontSize: '1.2em' }}>&larr;</span>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#fff';
                            const borderColor = isHighlighted ? '#cca300' : '#66cc66';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            const borderStyle = isHighlighted ? '2px solid' : '2px dashed';
                            return (
                                <div key={idx} style={{ border: `${borderStyle} ${borderColor}`, padding: '2px 8px', backgroundColor: bgColor, textAlign: 'center', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '2px 8px' }}>empty</div>}
                        <span style={{ color: '#00b300', fontSize: '1.2em' }}>&larr;</span>
                    </div>
                );
                break;
            case "deque":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', borderBottom: '4px solid #6600cc', paddingBottom: '4px', gap: '6px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        <span style={{ color: '#6600cc', fontSize: '1.2em' }}>&harr;</span>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#f9f2ff';
                            const borderColor = isHighlighted ? '#cca300' : '#b366ff';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <div key={idx} style={{ padding: '4px 10px', border: `2px solid ${borderColor}`, backgroundColor: bgColor, borderRadius: '4px', textAlign: 'center', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '4px 10px' }}>empty</div>}
                        <span style={{ color: '#6600cc', fontSize: '1.2em' }}>&harr;</span>
                    </div>
                );
                break;
            default:
                shape = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{values.join(", ")}</span>;
        }

        const displayCapacity = data.capacity !== undefined ? data.capacity : len;
        const showCapacitySize = (type === "vector");

        // Show maze toggle only for 2D arrays/vectors
        const is2D = len > 0 && Array.isArray(values[0]);
        const showMazeToggle = is2D && (type === "vector" || type === "array");

        return (
            <div key={name} style={{ marginBottom: "16px", padding: "8px", border: "1px solid #ddd", borderRadius: "4px", backgroundColor: "#fff" }}>
                {/* ── Header ── */}
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
                        {showMazeToggle && (
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: "normal", fontSize: "0.85em", color: isMazeMode ? "#b05000" : "#555", userSelect: "none" }}>
                                <input
                                    type="checkbox"
                                    checked={isMazeMode}
                                    onChange={() => this.toggleMazeMode(name)}
                                    style={{ cursor: "pointer", accentColor: "#b05000" }}
                                />
                                迷宮模式
            </label>
                        )}
                    </div>
                </div>
                {/* ── Body ── */}
                <div style={{ overflowX: "auto" }}>
                    {shape}
                </div>
                {/* ── Maze color editor（迷宮模式時才顯示）── */}
                {isMazeMode && this.renderMazeColorEditor(name)}
            </div>
        );
    }

    render() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers || latestContainers.size === 0) {
            return <div style={{ padding: "10px", color: "#666", fontStyle: "italic" }}>No container data available. Run and trace code to see containers.</div>;
        }

        const latestHighlights = (global_variable as any).__latest_highlights as Map<string, number> || new Map<string, number>();

        const containerElements = Array.from(latestContainers.entries()).map(([name, data]) => {
            const highlightIndex = latestHighlights.get(name);
            return this.renderContainerShape(name, data, highlightIndex);
        });

        return (
            <div style={{ padding: "10px", backgroundColor: "#fdfdfd" }}>
                {containerElements}
            </div>
        );
    }
}

export default ContainerVisualizer;