import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";

type ColorRule = { value: string; color: string };  // value = 數字字串, color = CSS色碼
type HighlightEntry = { index: number; color: string }; // color = 'default' 或任意 CSS 色碼

// 回傳該索引的 {bg, border} 樣式，未命中回傳 null。
// 'default' 沿用原有黃色配色；其他值直接套用為 CSS 顏色。
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

// ── Red-Black Tree simulation ──────────────────────────────────────────────

interface RBNode {
    key: string;
    label: string;
    color: 'R' | 'B';
    left: RBNode | null;
    right: RBNode | null;
    parent: RBNode | null;
}

function rbCmp(a: string, b: string): number {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
}

function rbRotateLeft(root: RBNode, x: RBNode): RBNode {
    const y = x.right!;
    x.right = y.left;
    if (y.left) y.left.parent = x;
    y.parent = x.parent;
    if (!x.parent) root = y;
    else if (x === x.parent.left) x.parent.left = y;
    else x.parent.right = y;
    y.left = x; x.parent = y;
    return root;
}

function rbRotateRight(root: RBNode, x: RBNode): RBNode {
    const y = x.left!;
    x.left = y.right;
    if (y.right) y.right.parent = x;
    y.parent = x.parent;
    if (!x.parent) root = y;
    else if (x === x.parent.right) x.parent.right = y;
    else x.parent.left = y;
    y.right = x; x.parent = y;
    return root;
}

function rbInsertFix(root: RBNode, z: RBNode): RBNode {
    while (z.parent && z.parent.color === 'R') {
        const p = z.parent, g = p.parent;
        if (!g) break;
        if (p === g.left) {
            const u = g.right;
            if (u && u.color === 'R') {
                p.color = 'B'; u.color = 'B'; g.color = 'R'; z = g;
            } else {
                if (z === p.right) { z = p; root = rbRotateLeft(root, z); }
                z.parent!.color = 'B'; z.parent!.parent!.color = 'R';
                root = rbRotateRight(root, z.parent!.parent!);
            }
        } else {
            const u = g.left;
            if (u && u.color === 'R') {
                p.color = 'B'; u.color = 'B'; g.color = 'R'; z = g;
            } else {
                if (z === p.left) { z = p; root = rbRotateRight(root, z); }
                z.parent!.color = 'B'; z.parent!.parent!.color = 'R';
                root = rbRotateLeft(root, z.parent!.parent!);
            }
        }
    }
    root.color = 'B';
    return root;
}

function rbInsert(root: RBNode | null, key: string, label: string): RBNode {
    const z: RBNode = { key, label, color: 'R', left: null, right: null, parent: null };
    let y: RBNode | null = null, x: RBNode | null = root;
    while (x) { y = x; x = rbCmp(key, x.key) < 0 ? x.left : x.right; }
    z.parent = y;
    if (!y) root = z;
    else if (rbCmp(key, y.key) < 0) y.left = z;
    else y.right = z;
    return rbInsertFix(root!, z);
}

// Compute black height for JS-simulated RB nodes.
// bh(x) = # black nodes from x (inclusive, counting x if black) down to null (exclusive).
function computeJsBH(node: RBNode | null): Map<RBNode, number> {
    const map = new Map<RBNode, number>();
    function bh(n: RBNode | null): number {
        if (!n) return 0;
        const lb = bh(n.left);
        const val = lb + (n.color === 'B' ? 1 : 0);
        map.set(n, val);
        return val;
    }
    bh(node);
    return map;
}

// Compute black height for GDB-provided nodes ({c:"R"|"B", l, r}).
function computeGdbBH(root: any): Map<any, number> {
    const map = new Map<any, number>();
    function bh(n: any): number {
        if (!n) return 0;
        const lb = bh(n.l);
        const val = lb + (n.c === 'B' ? 1 : 0);
        map.set(n, val);
        return val;
    }
    bh(root);
    return map;
}

interface NodePos { node: RBNode; x: number; y: number; }

function computeRBLayout(root: RBNode | null): NodePos[] {
    const pos: NodePos[] = [];
    const H = 54, V = 66;
    const minRankOf = new Map<RBNode, number>();
    const maxRankOf = new Map<RBNode, number>();
    let rank = 0;
    function assign(n: RBNode | null, depth: number) {
        if (!n) return;
        assign(n.left, depth + 1);
        const r = rank++;
        minRankOf.set(n, n.left != null ? minRankOf.get(n.left)! : r);
        assign(n.right, depth + 1);
        maxRankOf.set(n, n.right != null ? maxRankOf.get(n.right)! : r);
        pos.push({ node: n, x: ((minRankOf.get(n)! + maxRankOf.get(n)!) / 2) * H, y: depth * V });
    }
    assign(root, 0);
    return pos;
}

type State = {
    mazeMode: Set<string>;
    mazeColorRules: Map<string, ColorRule[]>;
    mazeRuleInput: Map<string, { value: string; color: string }>;
    rbTreeMode: Set<string>;
};

class ContainerVisualizer extends React.Component<{}, State> {
    updateInterval: any;

    constructor(props: {}) {
        super(props);
        this.state = {
            mazeMode: new Set<string>(),
            mazeColorRules: new Map(),
            mazeRuleInput: new Map(),
            rbTreeMode: new Set<string>(),
        };
        // Re-render immediately when new RB-tree data arrives from GDB
        // @ts-expect-error ts-migrate(2339) FIXME: connectComponentState
        store.connectComponentState(this, ["rbtree_updated"]);
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

    toggleRBTreeMode = (name: string) => {
        this.setState(prev => {
            const next = new Set<string>(prev.rbTreeMode);
            next.has(name) ? next.delete(name) : next.add(name);
            return { rbTreeMode: next };
        });
    };

    // ── Red-Black Tree renderer ───────────────────────────────────────────────

    // Render an RB-tree from actual GDB data: {c:"R"|"B", k:string, v:string, l:..., r:...}
    renderRBTreeFromGDB(gdbRoot: any): React.ReactNode {
        if (!gdbRoot) return <div style={{ color: '#999', fontStyle: 'italic', padding: '8px' }}>empty</div>;

        // Place each node at the horizontal midpoint of its subtree's inorder span.
        // This keeps the root visually centered even for unbalanced trees.
        type GPos = { node: any; x: number; y: number };
        const positions: GPos[] = [];
        const YSTEP = 64, XSTEP = 54, R = 22, PAD = R + 18;

        const minRankOf = new Map<any, number>();
        const maxRankOf = new Map<any, number>();
        let rank = 0;
        const assignPositions = (node: any, depth: number) => {
            if (!node) return;
            assignPositions(node.l, depth + 1);
            const r = rank++;
            minRankOf.set(node, node.l != null ? minRankOf.get(node.l)! : r);
            assignPositions(node.r, depth + 1);
            maxRankOf.set(node, node.r != null ? maxRankOf.get(node.r)! : r);
            const x = ((minRankOf.get(node)! + maxRankOf.get(node)!) / 2) * XSTEP;
            positions.push({ node, x, y: depth * YSTEP });
        };
        assignPositions(gdbRoot, 0);

        // Build lookup by reference equality
        const posMap = new Map<any, { x: number; y: number }>();
        for (const p of positions) posMap.set(p.node, { x: p.x + PAD, y: p.y + PAD });

        const maxX = Math.max(...positions.map(p => p.x));
        const maxY = Math.max(...positions.map(p => p.y));
        const svgW = maxX + PAD * 2;
        const svgH = maxY + PAD * 2 + 14; // extra bottom space for bh labels

        const bhMap = computeGdbBH(gdbRoot);

        const edges: React.ReactNode[] = [];
        const nodes: React.ReactNode[] = [];

        const buildSVG = (node: any) => {
            if (!node) return;
            const p = posMap.get(node)!;
            if (node.l) {
                const lp = posMap.get(node.l)!;
                edges.push(<line key={`eL-${node.k}-${p.x}`} x1={p.x} y1={p.y} x2={lp.x} y2={lp.y} stroke="#666" strokeWidth={1.5} />);
                buildSVG(node.l);
            }
            if (node.r) {
                const rp = posMap.get(node.r)!;
                edges.push(<line key={`eR-${node.k}-${p.x}`} x1={p.x} y1={p.y} x2={rp.x} y2={rp.y} stroke="#666" strokeWidth={1.5} />);
                buildSVG(node.r);
            }
            const isRed = node.c === 'R';
            const lbl = node.v ? `${node.k}→${node.v}` : String(node.k);
            const display = lbl.length > 9 ? lbl.slice(0, 8) + '…' : lbl;
            const bh = bhMap.get(node) ?? 0;
            nodes.push(
                <g key={`n-${node.k}-${p.x}`}>
                    <circle cx={p.x} cy={p.y} r={R}
                        fill={isRed ? '#c62828' : '#263238'}
                        stroke={isRed ? '#b71c1c' : '#37474f'}
                        strokeWidth={2} />
                    <text x={p.x} y={p.y + 5} textAnchor="middle"
                        fill="#fff" fontSize={10} fontFamily="monospace" fontWeight="bold">
                        {display}
                    </text>
                    {/* Black-height badge */}
                    <rect x={p.x + R - 2} y={p.y - R - 14} width={22} height={13} rx={3}
                        fill="#37474f" stroke="#546e7a" strokeWidth={1} />
                    <text x={p.x + R + 9} y={p.y - R - 4} textAnchor="middle"
                        fill="#b0bec5" fontSize={9} fontFamily="monospace">
                        bh{bh}
                    </text>
                </g>
            );
        };
        buildSVG(gdbRoot);

        return (
            <div>
                <div style={{ overflowX: 'auto' }}>
                    <svg width={svgW} height={svgH} style={{ display: 'block' }}>
                        <g>{edges}</g>
                        <g>{nodes}</g>
                    </svg>
                </div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '6px', fontFamily: 'sans-serif', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <span><span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', backgroundColor: '#263238', border: '1px solid #555', marginRight: 4, verticalAlign: 'middle' }} />黑節點</span>
                    <span><span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', backgroundColor: '#c62828', border: '1px solid #b71c1c', marginRight: 4, verticalAlign: 'middle' }} />紅節點</span>
                    <span style={{ color: '#4caf50' }}>實際 GDB 樹狀結構</span>
                    <span style={{ color: '#b0bec5' }}>
                        <span style={{ display: 'inline-block', padding: '0 4px', backgroundColor: '#37474f', border: '1px solid #546e7a', borderRadius: 3, marginRight: 4, fontSize: '9px' }}>bhN</span>
                        黑色高度（從該節點往下的黑節點數，各路徑相等表示平衡）
                    </span>
                </div>
            </div>
        );
    }

    renderRBTreeSVG(values: any[], type: string, name?: string): React.ReactNode {
        const isMap = type === 'map' || type === 'multimap';

        // ── Primary path: GDB-provided structure + variable-inspector values ──
        // GDB Python reads only colors/links (always works via base class).
        // Values come from the variable inspector (already sorted in-order).
        // We merge them by in-order index: both arrays are in the same sorted order.
        const rbtreeData = (window as any).gdbgui_global_variable?.__rbtree_data;
        const gdbStruct = name && rbtreeData ? rbtreeData[name] : undefined;

        if (gdbStruct !== undefined) {
            // Collect GDB nodes in in-order (sorted) sequence
            const ordered: any[] = [];
            const collectInorder = (node: any) => {
                if (!node) return;
                collectInorder(node.l);
                ordered.push(node);
                collectInorder(node.r);
            };
            collectInorder(gdbStruct);

            // If the GDB structure is stale (node count doesn't match values), fall through
            // to the JS simulation so we never show a mismatched tree.
            if (ordered.length !== values.length) {
                // gdbStruct is from a previous step; let the JS simulation below render instead
            } else {
                // Sort values to match in-order traversal order
                const sorted = [...values].sort((a: any, b: any) => {
                    const ka = isMap ? String(a.key) : String(a);
                    const kb = isMap ? String(b.key) : String(b);
                    return rbCmp(ka, kb);
                });

                // Assign value labels to nodes by position
                ordered.forEach((node, i) => {
                    const v = sorted[i];
                    if (v !== undefined) {
                        node.k = isMap ? String((v as any).key) : String(v);
                        node.v = isMap ? String((v as any).value) : '';
                    } else {
                        node.k = '?'; node.v = '';
                    }
                });

                return this.renderRBTreeFromGDB(gdbStruct);
            }
        }

        // ── Fallback: JS simulation (used before first GDB read) ──
        const isSet = type === 'set' || type === 'multiset';
        const entries: { key: string; label: string }[] = isSet
            ? (values as string[]).map(v => ({ key: String(v), label: String(v) }))
            : (values as { key: string; value: string }[]).map(e => ({ key: e.key, label: `${e.key}→${e.value}` }));

        entries.sort((a, b) => rbCmp(a.key, b.key));
        let root: RBNode | null = null;
        for (const e of entries) root = rbInsert(root, e.key, e.label);

        if (!root) return <div style={{ color: '#999', fontStyle: 'italic', padding: '8px' }}>empty</div>;

        const positions = computeRBLayout(root);
        const R = 22, PAD = R + 18;
        const maxX = Math.max(...positions.map(p => p.x));
        const maxY = Math.max(...positions.map(p => p.y));
        const svgW = maxX + PAD * 2;
        const svgH = maxY + PAD * 2 + 14;
        const OX = PAD, OY = PAD;

        const posMap = new Map(positions.map(p => [p.node, { x: p.x + OX, y: p.y + OY }]));
        const bhMap = computeJsBH(root);
        const edges: React.ReactNode[] = [];
        const nodes: React.ReactNode[] = [];

        for (const { node } of positions) {
            const p = posMap.get(node)!;
            if (node.left) {
                const lp = posMap.get(node.left)!;
                edges.push(<line key={`eL-${node.key}`} x1={p.x} y1={p.y} x2={lp.x} y2={lp.y} stroke="#666" strokeWidth={1.5} />);
            }
            if (node.right) {
                const rp = posMap.get(node.right)!;
                edges.push(<line key={`eR-${node.key}`} x1={p.x} y1={p.y} x2={rp.x} y2={rp.y} stroke="#666" strokeWidth={1.5} />);
            }
            const isRed = node.color === 'R';
            const lbl = node.label.length > 9 ? node.label.slice(0, 8) + '…' : node.label;
            const bh = bhMap.get(node) ?? 0;
            nodes.push(
                <g key={`n-${node.key}`}>
                    <circle cx={p.x} cy={p.y} r={R}
                        fill={isRed ? '#c62828' : '#263238'}
                        stroke={isRed ? '#b71c1c' : '#37474f'}
                        strokeWidth={2} />
                    <text x={p.x} y={p.y + 5} textAnchor="middle"
                        fill="#fff" fontSize={10} fontFamily="monospace" fontWeight="bold">
                        {lbl}
                    </text>
                    {/* Black-height badge */}
                    <rect x={p.x + R - 2} y={p.y - R - 14} width={22} height={13} rx={3}
                        fill="#37474f" stroke="#546e7a" strokeWidth={1} />
                    <text x={p.x + R + 9} y={p.y - R - 4} textAnchor="middle"
                        fill="#b0bec5" fontSize={9} fontFamily="monospace">
                        bh{bh}
                    </text>
                </g>
            );
        }

        return (
            <div>
                <div style={{ overflowX: 'auto' }}>
                    <svg width={svgW} height={svgH} style={{ display: 'block' }}>
                        <g>{edges}</g>
                        <g>{nodes}</g>
                    </svg>
                </div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '6px', fontFamily: 'sans-serif', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <span><span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', backgroundColor: '#263238', border: '1px solid #555', marginRight: 4, verticalAlign: 'middle' }} />黑節點</span>
                    <span><span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', backgroundColor: '#c62828', border: '1px solid #b71c1c', marginRight: 4, verticalAlign: 'middle' }} />紅節點</span>
                    <span style={{ color: '#bbb' }}>依排序鍵值模擬插入</span>
                    <span style={{ color: '#b0bec5' }}>
                        <span style={{ display: 'inline-block', padding: '0 4px', backgroundColor: '#37474f', border: '1px solid #546e7a', borderRadius: 3, marginRight: 4, fontSize: '9px' }}>bhN</span>
                        黑色高度（各路徑相等表示平衡）
                    </span>
                </div>
            </div>
        );
    }

    // ── Maze renderer ────────────────────────────────────────────────────────
    renderMaze(values: any[][], highlights: HighlightEntry[] | undefined, colorRules: ColorRule[]) {
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

        // 建立 "row,col" → 高亮色 的查表，支援多個高亮位置
        const mazePosMap = new Map<string, string>();
        if (highlights && cols > 0) {
            for (const h of highlights) {
                const r = Math.floor(h.index / cols);
                const c = h.index % cols;
                // 迷宮的 default 色改用橘紅（在深色格子上對比較高）
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
                            if (mazeHL) {
                                bg = mazeHL;
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
    renderContainerShape(name: string, data: any, highlights: HighlightEntry[] | undefined) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        const isMazeMode = this.state.mazeMode.has(name);
        const isRBTreeMode = this.state.rbTreeMode.has(name);

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
                    shape = this.renderMaze(values, highlights, this.state.mazeColorRules.get(name) || []);
                } else if (is2D) {
                    // ── Default 2D grid view ──
                    const cols = values.length > 0 ? (values[0] as any[]).length : 0;
                    // 建立 "row,col" → 樣式 的查表，支援多個高亮位置
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
                                        const bgColor = hlInfo2D ? hlInfo2D.bg : '#fff';
                                        const fontWeight = hlInfo2D ? 'bold' : 'normal';
                                        const borderColor = hlInfo2D ? hlInfo2D.border : '#888';
                                        return (
                                            <div key={`col-${rowIdx}-${colIdx}`} style={{ border: `1px solid ${borderColor}`, padding: '4px 10px', minWidth: '35px', textAlign: 'center', backgroundColor: bgColor, fontWeight: fontWeight, borderRadius: '3px', boxShadow: '1px 1px 3px rgba(0,0,0,0.1)' }}>
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
                                    const bgColor = hlInfo ? hlInfo.bg : 'transparent';
                                    const fontWeight = hlInfo ? 'bold' : 'normal';
                                    const borderRight = idx < len - 1 ? '1px solid #777' : 'none';
                                    return (
                                        <div key={`val-${idx}`} style={{ flex: 1, padding: '18px 6px', borderRight: borderRight, minWidth: '32px', textAlign: 'center', backgroundColor: bgColor, fontWeight: fontWeight, fontSize: '1.1em' }}>
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
                            const bgColor = hlInfo ? hlInfo.bg : '#e6f2ff';
                            const borderColor = hlInfo ? hlInfo.border : '#0056b3';
                            const fontWeight = hlInfo ? 'bold' : 'normal';
                            return (
                                <React.Fragment key={idx}>
                                    <div style={{ flex: 1, padding: '18px 6px', borderRadius: '16px', border: `2px solid ${borderColor}`, backgroundColor: bgColor, minWidth: '32px', textAlign: 'center', fontWeight: fontWeight, fontSize: '1.1em' }}>
                                        {v}
                                    </div>
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
                    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', border: '3px solid #b30000', borderRight: 'none', borderTopLeftRadius: '8px', borderBottomLeftRadius: '8px', alignItems: 'stretch', backgroundColor: '#fff', gap: '0px' }}>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            const bgColor = hlInfo ? hlInfo.bg : '#ffe6e6';
                            const borderColor = hlInfo ? hlInfo.border : '#ff6666';
                            const fontWeight = hlInfo ? 'bold' : 'normal';
                            const borderRight = idx < len - 1 ? `2px solid ${borderColor}` : 'none';
                            return (
                                <div key={idx} style={{ flex: 1, borderRight: borderRight, padding: '18px 6px', textAlign: 'center', backgroundColor: bgColor, minWidth: '32px', fontWeight: fontWeight, fontSize: '1.1em' }}>
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
                    <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', backgroundColor: '#f0fff0', borderTop: '3px solid #00b300', borderBottom: '3px solid #00b300', gap: '0px' }}>
                        <span style={{ color: '#00b300', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&larr;</span>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            const bgColor = hlInfo ? hlInfo.bg : '#fff';
                            const borderColor = hlInfo ? hlInfo.border : '#66cc66';
                            const fontWeight = hlInfo ? 'bold' : 'normal';
                            const borderStyle = hlInfo ? '2px solid' : '2px dashed';
                            const borderRight = idx < len - 1 ? `${borderStyle} ${borderColor}` : 'none';
                            return (
                                <div key={idx} style={{ flex: 1, borderRight: borderRight, padding: '18px 6px', backgroundColor: bgColor, textAlign: 'center', fontWeight: fontWeight, fontSize: '1.1em', minWidth: '32px' }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 8px', textAlign: 'center' }}>empty</div>}
                        <span style={{ color: '#00b300', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&larr;</span>
                    </div>
                );
                break;
            case "deque":
                shape = (
                    <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', borderBottom: '4px solid #6600cc', gap: '0px' }}>
                        <span style={{ color: '#6600cc', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&harr;</span>
                        {values.map((v: string, idx: number) => {
                            const hlInfo = getHighlight(idx, highlights, len);
                            const bgColor = hlInfo ? hlInfo.bg : '#f9f2ff';
                            const borderColor = hlInfo ? hlInfo.border : '#b366ff';
                            const fontWeight = hlInfo ? 'bold' : 'normal';
                            const borderRight = idx < len - 1 ? `2px solid ${borderColor}` : 'none';
                            return (
                                <div key={idx} style={{ flex: 1, padding: '18px 6px', borderRight: borderRight, backgroundColor: bgColor, borderRadius: '4px', textAlign: 'center', fontWeight: fontWeight, fontSize: '1.1em', minWidth: '32px' }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ flex: 1, color: '#999', fontStyle: 'italic', padding: '18px 10px', textAlign: 'center' }}>empty</div>}
                        <span style={{ color: '#6600cc', fontSize: '1.4em', display: 'flex', alignItems: 'center', padding: '0 6px' }}>&harr;</span>
                    </div>
                );
                break;
            case "set":
            case "multiset": {
                if (isRBTreeMode) {
                    shape = this.renderRBTreeSVG(values, type, name);
                } else {
                    shape = (
                        <div style={{ display: 'flex', width: '100%', alignItems: 'stretch', border: '2px solid #009688', borderRadius: '12px', backgroundColor: '#e0f2f1', overflow: 'hidden' }}>
                            <span style={{ color: '#009688', fontWeight: 'bold', fontSize: '1.2em', display: 'flex', alignItems: 'center', padding: '0 8px' }}>{`{`}</span>
                            {values.map((v: string, idx: number) => {
                                const hlInfo = getHighlight(idx, highlights, len);
                                const borderRight = idx < len - 1 ? '1px solid #80cbc4' : 'none';
                                return (
                                    <React.Fragment key={idx}>
                                        <div style={{
                                            flex: 1, padding: '18px 6px', borderRight: borderRight,
                                            border: hlInfo ? `2px solid ${hlInfo.border}` : 'none',
                                            backgroundColor: hlInfo ? hlInfo.bg : '#fff',
                                            fontWeight: hlInfo ? 'bold' : 'normal',
                                            minWidth: '32px', textAlign: 'center', fontFamily: 'monospace', fontSize: '1.1em',
                                        }}>{v}</div>
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
                if (isRBTreeMode) {
                    shape = this.renderRBTreeSVG(values, type, name);
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
                                        <tr key={idx} style={{ backgroundColor: hlInfo ? hlInfo.bg : (idx % 2 === 0 ? '#e3f2fd' : '#fff') }}>
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
        const showCapacitySize = (type === "vector");
        const showSizeOnly = (type === "set" || type === "multiset" || type === "map" || type === "unordered_map" || type === "multimap");

        const is2D = len > 0 && Array.isArray(values[0]);
        const showMazeToggle = is2D && (type === "vector" || type === "array");
        const showRBTreeToggle = type === "set" || type === "multiset" || type === "map" || type === "unordered_map" || type === "multimap";

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
                        {showRBTreeToggle && (
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: "normal", fontSize: "0.85em", color: isRBTreeMode ? "#c62828" : "#555", userSelect: "none" }}>
                                <input type="checkbox" checked={isRBTreeMode} onChange={() => this.toggleRBTreeMode(name)} style={{ cursor: "pointer", accentColor: "#c62828" }} />
                                紅黑樹
                            </label>
                        )}
                    </div>
                </div>
                {/* ── Body ── */}
                <div style={{ overflowX: "auto", display: "flex", justifyContent: "center", padding: "12px 0" }}>
                    <div style={{ width: "90%" }}>
                        {shape}
                    </div>
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

        const latestHighlights = (global_variable as any).__latest_highlights as Map<string, HighlightEntry[]> || new Map<string, HighlightEntry[]>();

        const containerElements = Array.from(latestContainers.entries()).map(([name, data]) => {
            const highlights = latestHighlights.get(name);
            return this.renderContainerShape(name, data, highlights);
        });

        return (
            <div style={{ padding: "10px", backgroundColor: "#fdfdfd" }}>
                {containerElements}
            </div>
        );
    }
}

export default ContainerVisualizer;