import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import { animScheduler } from "./AnimScheduler";
import { registerPlugin, getPlugin, allPlugins } from "./ContainerPlugin";
import { bstPlugin } from "./BSTPlugin";
import { linearPlugin, uniformCellWidth } from "./LinearPlugin";
import { mazePlugin } from "./MazePlugin";
import { splitForPairing } from "./containerPairing";
import { popCellKey, popGenKey, effectivePopGen, prefersReducedMotion } from "./cellPopKey";
import { computePullOffsets } from "./pullAnim";
import { delay } from "./anim";

// Register all plugins once at module load.
// To add a new container type: create a plugin file and call registerPlugin() here.
registerPlugin(bstPlugin);
registerPlugin(linearPlugin);

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
    /** @layout 的 pair:A,B 設定的一組並排容器名；null = 沒有設定。 */
    pairNames: [string, string] | null;
    /** @layout 的 pop:A,B 每次真的停在有這個 token 的行，對應容器的世代號就 +1
     *  （不是「開關」——見 cellPopKey.ts 為什麼不能用顏色變了沒判斷）。 */
    popGen: Map<string, number>;
    /** @layout 的 pull:容器名:來源色1,來源色2->目標色 觸發時，正在飛向目標格的
     *  來源格（key 是 "row,col"）該往哪個方向飄。動畫播完就從這個 Map 移除，
     *  見 pullAnim.ts。 */
    pullState: Map<string, Map<string, { dRow: number; dCol: number }>>;
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
            pairNames: null,
            popGen: new Map<string, number>(),
            pullState: new Map(),
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

        // pair:A,B → 這兩個容器並排顯示（見 §4.10）。只記名字，真正要不要
        // 排版由 render() 的 splitForPairing 判斷（兩者都要有資料才算數）。
        (window as any).gdbgui_set_pair_mode = (nameA: string, nameB: string) => {
            this.setState({ pairNames: [nameA, nameB] });
        };

        // pop:容器名（可選 :顏色）→ 這個容器（或只有這個顏色）的高亮格「放大再
        // 縮小」（見 §4.10）。世代號而不是開關：applyLayout 只在 GDB 真的停到
        // 新的一行、且那行有 pop: token 時呼叫這個 bump，跟「這格的高亮顏色有
        // 沒有變」無關——見 cellPopKey.ts 為什麼顏色比對會漏掉「連續幾行都用
        // 同一個顏色標同一格，最後一行才寫入真正的值」這種常見寫法（實測案例：
        // 走方格教案的 dp[i][j]）。加 :顏色 可以只點名容器裡的某個顏色（例如
        // 「講上面時只跳橘色那格」），key 格式見 cellPopKey.ts 的 popGenKey。
        // LinearPlugin 不是這個元件的子節點、讀不到 this.state，所以額外開一個
        // 唯讀 bridge 給它查（gdbgui_is_bst_mode 的先例）。
        (window as any).gdbgui_get_pop_gen = () => this.state.popGen;
        (window as any).gdbgui_bump_pop_gen = (containerName: string, color?: string) => {
            const key = popGenKey(containerName, color);
            this.setState(prev => {
                const next = new Map<string, number>(prev.popGen);
                next.set(key, (next.get(key) || 0) + 1);
                return { popGen: next };
            });
        };

        // pull:容器名:來源色1,來源色2->目標色（見 §4.1x）→ 兩個來源格飛向目標格、
        // 變成結果。跟 swap 不同：來源格邏輯上的 (row,col) 沒有搬動，只是多套一層
        // 位移+淡出，一般的 CSS transition 就能播，不需要 swap 那套 FLIP 雙 rAF
        // （見 pullAnim.ts 檔頭）。位置/位移換算交給純函式 computePullOffsets，
        // 這裡只負責：讀目前的資料、寫 state 觸發動畫、時間到了收尾。
        (window as any).gdbgui_trigger_pull = async (containerName: string, colorA: string, colorB: string, targetColor: string) => {
            const data = (global_variable as any).__latest_containers?.get(containerName);
            const highlights = (global_variable as any).__latest_highlights?.get(containerName) as HighlightEntry[] | undefined;
            if (!data || !Array.isArray(data.values) || data.values.length === 0 || !Array.isArray(data.values[0])) return;
            const cols = data.values[0].length;
            const offsets = computePullOffsets(highlights, cols, colorA, colorB, targetColor);
            if (!offsets) return;

            // 目標格借用既有的 pop 機制亮一下，表示「結果落在這裡」，不用再造一套。
            (window as any).gdbgui_bump_pop_gen?.(containerName, targetColor);

            if (!prefersReducedMotion()) {
                this.setState(prev => {
                    const next = new Map(prev.pullState);
                    const m = new Map<string, { dRow: number; dCol: number }>();
                    m.set(offsets.aKey, offsets.deltaA);
                    m.set(offsets.bKey, offsets.deltaB);
                    next.set(containerName, m);
                    return { pullState: next };
                });
            }
            await delay(450);
            this.setState(prev => {
                const next = new Map(prev.pullState);
                next.delete(containerName);
                return { pullState: next };
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
                    mazePlugin.resetContainer(containerName);
                }
                return { mazeMode: next, mazeColorRules: nextRules };
            });
        };
    }

    /** Last run generation we cleared plugin state for. -1 = never. */
    private _lastResetRunGen = -1;

    _pollContainers() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers) { this.forceUpdate(); return; }

        // 只有真正重新執行才清 plugin 狀態。先前這裡看的是
        // inferior_program === "running"，但單步時程式也會短暫進入 running，
        // 而這是個輪詢——只要有一次剛好落在那個窗，就會把累積好的 BST 插入
        // 順序整個清掉，然後 render 的 lazy-init 會用 GDB 給的「已排序」值
        // 重建，把樹變成一條退化鏈。改用只在 Run 時遞增的執行代數。
        const runGen: number = (global_variable as any).__run_generation || 0;
        if (runGen !== this._lastResetRunGen) {
            this._lastResetRunGen = runGen;
            allPlugins().forEach(p => p.resetAll());
            mazePlugin.resetAll();
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
        for (const name of linearPlugin.trackedNames()) {
            if (!latestContainers.has(name)) {
                linearPlugin.resetContainer(name);
            }
        }

        const requestRender = () => this.forceUpdate();
        let hasOps = false;
        const bstTypes = new Set(['set', 'map', 'multiset', 'multimap']);

        for (const [name, data] of Array.from(latestContainers.entries())) {
            const is2D = data.values.length > 0 && Array.isArray(data.values[0]);
            const isMazeMode = this.state.mazeMode.has(name);
            const isBSTMode = this.state.bstMode.has(name);

            // Maze mode: use MazePlugin directly
            if (is2D && isMazeMode) {
                const ops = mazePlugin.diffOps(name, data);
                if (ops.length > 0) {
                    hasOps = true;
                    animScheduler.pushOps(name, ops, (op) => mazePlugin.animateOp(name, op, requestRender));
                }
                continue;
            }

            // BST types without BST mode: skip (no animation)
            if (bstTypes.has(data.type) && !isBSTMode) continue;

            // Plugin path: BST or Linear via registry
            const plugin = getPlugin(data.type);
            if (!plugin) continue;
            const ops = plugin.diffOps(name, data);
            if (ops.length > 0) {
                hasOps = true;
                animScheduler.pushOps(name, ops, (op) => plugin.animateOp(name, op, requestRender));
            }
        }

        if (latestContainers.size > 0 && !(window as any).gdbgui_table_quiz_hides_container) {
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
            if (next.has(name)) {
                next.delete(name);
                mazePlugin.resetContainer(name);
            } else {
                next.add(name);
            }
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

    /** bare=true：省略外框/背景/陰影（並排時整組共用一個外框，見 render() 的 pair 分支），
     *  其餘（標題、切換鈕、圖形本體）不變。 */
    renderContainerShape(name: string, data: any, highlights: HighlightEntry[] | undefined, bare: boolean = false) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        const isMazeMode = this.state.mazeMode.has(name);
        const isBSTMode  = this.state.bstMode.has(name);
        const popGen     = this.state.popGen;
        const pullMap    = this.state.pullState.get(name);
        const is2D = len > 0 && Array.isArray(values[0]);

        const fs     = (store.get("container_font_size") as number) || 1.1;
        const fsPx   = `${fs}em`;
        const fsBrace = `${(fs * 1.09).toFixed(2)}em`;
        const fsMap   = `${(fs * 0.82).toFixed(2)}em`;

        // ── Plugin-delegated rendering ────────────────────────────────────────

        if (is2D && isMazeMode) {
            // Maze mode
            shape = mazePlugin.render(name, values, this.state.mazeColorRules.get(name) || [], highlights);
        } else if (isBSTMode && ['set', 'multiset', 'map', 'multimap'].includes(type)) {
            // BST mode
            shape = getPlugin(type)?.render(name) ?? null;
        } else if (!is2D && ['vector', 'array', 'string', 'list', 'queue', 'stack', 'deque'].includes(type)) {
            // LinearPlugin
            shape = getPlugin(type)?.render(name) ?? null;
        }

        // ── Fallback: inline rendering for types not handled by plugins ───────

        if (shape === null) {
            // Style helpers (same as before, for fallback types)
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

            switch (type) {
                case "vector":
                case "array":
                case "string": {
                    // 2D non-maze grid (only reaches here for 2D arrays without maze mode)
                    if (is2D) {
                        const cols = values.length > 0 ? (values[0] as any[]).length : 0;
                        // 整張表共用一個格寬，以最長的那一格為準——否則 0 那格會比 12 那格窄，
                        // 每一欄各自對齊自己的內容，整張表看起來是歪的。
                        const cellW = uniformCellWidth(
                            values.flat().map((v: any) => (type === "string" && v !== "" ? `'${v}'` : String(v))),
                            26
                        );
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
                                            const pop = popCellKey(`col-${rowIdx}-${colIdx}`, effectivePopGen(popGen, name, hl2D?.bg), hl2D);
                                            const pull = pullMap?.get(`${rowIdx},${colIdx}`);
                                            const pullStyle: React.CSSProperties = pull ? {
                                                transform: `translate(calc((100% + 4px) * ${pull.dCol}), calc((100% + 4px) * ${pull.dRow}))`,
                                                opacity: 0,
                                                transition: "transform 0.45s ease, opacity 0.45s ease",
                                                position: "relative",
                                                zIndex: 2,
                                            } : {};
                                            return (
                                                <div key={pop.key} className={pop.className} style={{ ...cellBase, ...stateStyle(hl2D), padding: "8px 12px", flex: "none", width: cellW, ...pullStyle }}>
                                                    {type === "string" && colVal !== "" ? `'${colVal}'` : colVal}
                                                </div>
                                            );
                                        })}
                                        {row.length === 0 && <div style={{ ...emptyCell, padding: "8px 12px", flex: "none" }}>empty row</div>}
                                    </div>
                                ))}
                            </div>
                        );
                    }
                    break;
                }
                case "set":
                case "multiset": {
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
                    break;
                }
                case "map":
                case "unordered_map":
                case "multimap": {
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
                    break;
                }
                default:
                    shape = <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{values.join(", ")}</span>;
            }
        }

        // ── Card wrapper (UNCHANGED from existing code) ───────────────────────

        const displayCapacity = data.capacity !== undefined ? data.capacity : len;
        const showCapacitySize = type === "vector";
        const showSizeOnly = type === "set" || type === "multiset" || type === "map" || type === "unordered_map" || type === "multimap";
        const showMazeToggle = is2D && (type === "vector" || type === "array");
        const showBSTToggle = type === "set" || type === "multiset" || type === "map" || type === "multimap";

        const chip: React.CSSProperties = { color: "var(--accent)", fontSize: "0.8em", backgroundColor: "var(--accent-soft)", padding: "2px 8px", borderRadius: "999px", fontFamily: "var(--font-mono)", fontWeight: 500 };
        const toggleLabel = (on: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", fontWeight: on ? 600 : 400, fontSize: "0.85em", color: on ? "var(--accent)" : "var(--ink-soft)", userSelect: "none" });

        const cardStyle: React.CSSProperties = bare
            ? { flex: "1 1 0", minWidth: 0 }
            : { marginBottom: "16px", padding: "12px", border: "1px solid var(--line)", borderRadius: "12px", backgroundColor: "var(--surface)", boxShadow: "0 1px 2px rgba(27,31,36,0.04)" };

        return (
            <div key={name} data-testid={`container-${name}`} data-container-type={type} style={cardStyle}>
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

        const { paired, rest } = splitForPairing(Array.from(latestContainers.keys()), this.state.pairNames);

        return (
            <div style={{ padding: "10px", backgroundColor: "var(--paper)" }}>
                {paired && (
                    // 兩個容器共用同一個外框區塊（不是各自一張卡片並排），中間一條分隔線。
                    <div style={{ marginBottom: "16px", padding: "12px", border: "1px solid var(--line)", borderRadius: "12px", backgroundColor: "var(--surface)", boxShadow: "0 1px 2px rgba(27,31,36,0.04)", display: "flex", gap: "16px", alignItems: "stretch" }}>
                        {paired.map((name, idx) => (
                            <React.Fragment key={name}>
                                {idx === 1 && <div style={{ alignSelf: "stretch", width: "1px", backgroundColor: "var(--line)" }} />}
                                {this.renderContainerShape(name, latestContainers.get(name), latestHighlights.get(name), true)}
                            </React.Fragment>
                        ))}
                    </div>
                )}
                {rest.map(name =>
                    this.renderContainerShape(name, latestContainers.get(name), latestHighlights.get(name))
                )}
            </div>
        );
    }
}

export default ContainerVisualizer;
