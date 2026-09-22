import React from "react";
import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import { ContainerPlugin, ContainerData } from "./ContainerPlugin";
import { PluginOp } from "./AnimScheduler";
import { delay } from "./anim";
import { popCellKey, effectivePopGen } from "./cellPopKey";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LinearCell {
    id: string;
    value: string;
}

interface InsertPayload { index: number; value: string; cellId: string; }
interface ErasePayload  { index: number; value: string; cellId: string; }
interface ValueChangePayload { index: number; oldValue: string; newValue: string; cellId: string; }
interface SwapPayload   { indexA: number; indexB: number; cellIdA: string; cellIdB: string; }

/** 一格目前正在播哪種動畫。swap 是 FLIP 技巧的兩個階段：
 *  start＝先無過渡地畫在「原本位置」（deltaIndex 格外），settle＝拿掉位移、打開 transition，
 *  瀏覽器就會把這段「從原位滑到新位」畫成動畫。deltaIndex 是格數差，不是像素。 */
type CellAnimKind =
    | { kind: "value" }
    | { kind: "swap"; deltaIndex: number; phase: "start" | "settle" };

// ── Helpers ───────────────────────────────────────────────────────────────────

let _cellId = 0;

function afterFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// swap 的平移是用 inline style 直接算出來的，不是 CSS class，所以「減少動態效果」
// 這條系統設定沒辦法像 cell-pop 那樣交給 @media 處理，這裡直接查一次。
function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ponytail: O(n²) diff — upgrade to LCS if containers exceed ~1000 elements
function findInsertIndex(oldVals: string[], newVals: string[]): number {
    for (let i = 0; i < newVals.length; i++) {
        let match = true;
        for (let j = 0, k = 0; j < oldVals.length; j++, k++) {
            if (k === i) k++;
            if (oldVals[j] !== newVals[k]) { match = false; break; }
        }
        if (match) return i;
    }
    return newVals.length - 1;
}

function findEraseIndex(oldVals: string[], newVals: string[]): number {
    for (let i = 0; i < oldVals.length; i++) {
        let match = true;
        for (let j = 0, k = 0; k < newVals.length; j++, k++) {
            if (j === i) j++;
            if (oldVals[j] !== newVals[k]) { match = false; break; }
        }
        if (match) return i;
    }
    return oldVals.length - 1;
}

// 每一格都一樣寬：以最長的那一格為準，其他格跟著它變寬。
// 格子用等寬字型（var(--font-mono)），所以 1ch 剛好是一個字元，不必量 DOM。
// `chromePx` 是內距加外框——格子都是 border-box，所以回傳值就是整格的寬度。
export function uniformCellWidth(displayValues: string[], chromePx: number): string {
    const longest = displayValues.reduce((max, v) => Math.max(max, v.length), 1);
    return `calc(${longest}ch + ${chromePx}px)`;
}

type HighlightEntry = { index: number; color: string };

function getHighlight(idx: number, highlights: HighlightEntry[] | undefined, len?: number): { bg: string; border: string } | null {
    if (!highlights) return null;
    const h = highlights.find(e => {
        const resolved = (e.index < 0 && len !== undefined) ? len + e.index : e.index;
        return resolved === idx;
    });
    if (!h) return null;
    if (h.color === 'default') return { bg: 'var(--highlight-soft)', border: 'var(--highlight)' };
    return { bg: h.color, border: h.color };
}

// ── LinearPlugin ──────────────────────────────────────────────────────────────

class LinearPluginImpl implements ContainerPlugin {
    readonly supportedTypes = ['vector', 'list', 'queue', 'stack', 'deque', 'array', 'string'];

    private history  = new Map<string, string[]>();
    private prevJson = new Map<string, string>();
    private cells    = new Map<string, LinearCell[]>();

    // Animation state (per-container, keyed by cell ID)
    private entering    = new Map<string, Set<string>>();
    private fadingOut   = new Map<string, Set<string>>();
    private highlighted = new Map<string, Set<string>>();
    /** valueChange 跟 swap 都借用 highlighted 的琥珀色高亮，但使用者要它們的動作看起來不一樣：
     *  覆蓋/變更為某數＝放大再縮小（cell-pop）；交換＝真的平移過去（FLIP 技巧，見 _animateSwap）。
     *  cellId → 這次是哪種變化，只有 valueChange/swap 會寫，erase 的高亮跟這個無關。
     *
     *  swap 用 % 相對位移（calc((100% + gap) * N)）不用算絕對像素——cellWidth 本身是
     *  `calc(Nch + Mpx)` 這種吃字型才算得出來的 CSS 運算式，JS 這邊量不到實際像素，但
     *  用同一個 100% 基準乘上格數差，CSS 自己會算對，不管兩格隔多遠都準。 */
    private highlightKind = new Map<string, Map<string, CellAnimKind>>();

    // ── diffOps ───────────────────────────────────────────────────────────────

    diffOps(containerName: string, newData: ContainerData): PluginOp[] {
        const { values } = newData;
        if (values.length > 0 && Array.isArray(values[0])) return [];

        const newVals = values.map(v => String(v));
        const json = JSON.stringify(newVals);
        if (json === this.prevJson.get(containerName)) return [];
        this.prevJson.set(containerName, json);

        const oldVals = this.history.get(containerName);
        console.log(`[LinearPlugin.diffOps] "${containerName}" old=${JSON.stringify(oldVals)} new=${JSON.stringify(newVals)}`);
        this.history.set(containerName, [...newVals]);

        // First encounter
        if (!oldVals) {
            const newCells = newVals.map(v => ({ id: `lin-${++_cellId}`, value: v }));
            this.cells.set(containerName, newCells);
            return newVals.length > 0 ? [{ type: 'bulkChange', payload: {} }] : [];
        }

        const ops: PluginOp[] = [];
        const lenDiff = newVals.length - oldVals.length;

        if (lenDiff === 0) {
            // Same length: valueChange or swap
            const changed: number[] = [];
            for (let i = 0; i < oldVals.length; i++) {
                if (oldVals[i] !== newVals[i]) changed.push(i);
            }
            if (changed.length === 0) return [];

            if (changed.length === 2) {
                const [a, b] = changed;
                // detect_swap_call（VisualizerHelper.js）認得出 swap(arr[i], arr[j]) 這種
                // 語法時，會先把索引求值好記在這裡——比「兩格值剛好對調」的猜測準，兩者
                // 並存：認得出這行語法就用這個確定結果，認不出來就照舊用猜的兜底。
                // 一次性訊號，不管這次有沒有用到都要清掉，不留到下一次 diffOps。
                const expected = (global_variable as any).__expected_swap as
                    { containerName: string; indexA: number; indexB: number } | undefined;
                const expectedMatches = !!expected && expected.containerName === containerName &&
                    ((expected.indexA === a && expected.indexB === b) || (expected.indexA === b && expected.indexB === a));
                if (expected && expected.containerName === containerName) {
                    delete (global_variable as any).__expected_swap;
                }
                if (expectedMatches || (oldVals[a] === newVals[b] && oldVals[b] === newVals[a])) {
                    // Swap: exchange cells in the display
                    const c = this.cells.get(containerName)!;
                    const cellIdA = c[a].id;
                    const cellIdB = c[b].id;
                    const tmp = c[a]; c[a] = c[b]; c[b] = tmp;
                    c[a].value = newVals[a];
                    c[b].value = newVals[b];
                    ops.push({ type: 'swap', payload: { indexA: a, indexB: b, cellIdA, cellIdB } as SwapPayload });
                    return ops;
                }
            }
            // Multiple value changes
            const c = this.cells.get(containerName)!;
            for (const idx of changed) {
                const cellId = c[idx].id;
                ops.push({ type: 'valueChange', payload: { index: idx, oldValue: oldVals[idx], newValue: newVals[idx], cellId } as ValueChangePayload });
                c[idx].value = newVals[idx];
            }
        } else if (lenDiff === 1) {
            const insertIdx = findInsertIndex(oldVals, newVals);
            const newCell: LinearCell = { id: `lin-${++_cellId}`, value: newVals[insertIdx] };
            const c = this.cells.get(containerName)!;
            c.splice(insertIdx, 0, newCell);
            // Sync all cell values — existing elements may have changed alongside the insert
            for (let i = 0; i < c.length; i++) c[i].value = newVals[i];

            // Pre-hide new cell
            const enterSet = this.entering.get(containerName) ?? new Set<string>();
            enterSet.add(newCell.id);
            this.entering.set(containerName, enterSet);

            if (insertIdx === newVals.length - 1) {
                ops.push({ type: 'pushBack', payload: { value: newVals[insertIdx], cellId: newCell.id } });
            } else if (insertIdx === 0) {
                ops.push({ type: 'pushFront', payload: { value: newVals[insertIdx], cellId: newCell.id } });
            } else {
                ops.push({ type: 'insert', payload: { index: insertIdx, value: newVals[insertIdx], cellId: newCell.id } as InsertPayload });
            }
        } else if (lenDiff === -1) {
            const eraseIdx = findEraseIndex(oldVals, newVals);
            const c = this.cells.get(containerName)!;
            const cellId = c[eraseIdx].id;

            if (eraseIdx === oldVals.length - 1) {
                ops.push({ type: 'popBack', payload: { value: oldVals[eraseIdx], cellId } });
            } else if (eraseIdx === 0) {
                ops.push({ type: 'popFront', payload: { value: oldVals[eraseIdx], cellId } });
            } else {
                ops.push({ type: 'erase', payload: { index: eraseIdx, value: oldVals[eraseIdx], cellId } as ErasePayload });
            }
            // Sync surviving cell values in case they changed alongside the erase
            for (let i = 0, ci = 0; ci < c.length; ci++) {
                if (ci === eraseIdx) continue;
                c[ci].value = newVals[i++];
            }
            // Don't remove from cells yet — ghost stays for erase animation
        } else {
            // Bulk change: replace all cells
            const newCells = newVals.map(v => ({ id: `lin-${++_cellId}`, value: v }));
            this.cells.set(containerName, newCells);
            ops.push({ type: 'bulkChange', payload: {} });
        }

        console.log(`[LinearPlugin.diffOps] "${containerName}" ops=${JSON.stringify(ops.map(o=>o.type))} cells=${JSON.stringify(this.cells.get(containerName)?.map(c=>c.value))}`);
        return ops;
    }

    // ── animateOp ─────────────────────────────────────────────────────────────

    async animateOp(containerName: string, op: PluginOp, requestRender: () => void): Promise<void> {
        switch (op.type) {
            case 'insert':
            case 'pushBack':
            case 'pushFront':
                await this._animateInsert(containerName, op.payload as any, requestRender);
                break;
            case 'erase':
            case 'popBack':
            case 'popFront':
                await this._animateErase(containerName, op.payload as any, requestRender);
                break;
            case 'valueChange':
                await this._animateValueChange(containerName, op.payload as any, requestRender);
                break;
            case 'swap':
                await this._animateSwap(containerName, op.payload as any, requestRender);
                break;
            case 'bulkChange':
                await this._animateBulkChange(containerName, requestRender);
                break;
        }
    }

    // ── Private animation helpers ─────────────────────────────────────────────

    private async _animateInsert(
        containerName: string,
        payload: { cellId: string },
        requestRender: () => void
    ): Promise<void> {
        // Paint the cell at opacity 0 first (entering = true → transition: none)
        requestRender();
        await afterFrame();
        // Now reveal: entering → false triggers CSS transition opacity 0→1
        const enterSet = this.entering.get(containerName) ?? new Set<string>();
        enterSet.delete(payload.cellId);
        this.entering.set(containerName, enterSet);
        requestRender();
        await delay(400);
    }

    private async _animateErase(
        containerName: string,
        payload: { cellId: string },
        requestRender: () => void
    ): Promise<void> {
        // Highlight
        const hlSet = this.highlighted.get(containerName) ?? new Set<string>();
        hlSet.add(payload.cellId);
        this.highlighted.set(containerName, hlSet);
        requestRender();
        await delay(200);

        // Fade out
        hlSet.delete(payload.cellId);
        const outSet = this.fadingOut.get(containerName) ?? new Set<string>();
        outSet.add(payload.cellId);
        this.fadingOut.set(containerName, outSet);
        requestRender();
        await delay(400);

        // Remove ghost
        outSet.delete(payload.cellId);
        const c = this.cells.get(containerName);
        if (c) {
            const idx = c.findIndex(cell => cell.id === payload.cellId);
            if (idx !== -1) c.splice(idx, 1);
        }
        requestRender();
    }

    private async _animateValueChange(
        containerName: string,
        payload: { cellId: string },
        requestRender: () => void
    ): Promise<void> {
        const hlSet = this.highlighted.get(containerName) ?? new Set<string>();
        hlSet.add(payload.cellId);
        this.highlighted.set(containerName, hlSet);
        const kindMap: Map<string, CellAnimKind> = this.highlightKind.get(containerName) ?? new Map();
        kindMap.set(payload.cellId, { kind: "value" });
        this.highlightKind.set(containerName, kindMap);
        requestRender();
        await delay(400);
        hlSet.delete(payload.cellId);
        kindMap.delete(payload.cellId);
        requestRender();
    }

    private async _animateSwap(
        containerName: string,
        payload: SwapPayload,
        requestRender: () => void
    ): Promise<void> {
        const hlSet = this.highlighted.get(containerName) ?? new Set<string>();
        hlSet.add(payload.cellIdA);
        hlSet.add(payload.cellIdB);
        this.highlighted.set(containerName, hlSet);

        // diffOps 呼叫這裡之前已經把 cells 陣列裡的物件互換了，所以 cellIdA 現在坐在
        // indexB 的位置、cellIdB 坐在 indexA。要讓它們「看起來從原本的格子滑過來」，
        // 就讓它們先headless無過渡地畫在「差幾格」的偏移量，下一影格才拿掉偏移、
        // 打開 transition——這段落差瀏覽器就會畫成滑動。
        const deltaA = payload.indexA - payload.indexB; // A 現在在 B 的位置，來自 A（差幾格）
        const deltaB = payload.indexB - payload.indexA; // B 現在在 A 的位置，來自 B
        const kindMap: Map<string, CellAnimKind> = this.highlightKind.get(containerName) ?? new Map();
        kindMap.set(payload.cellIdA, { kind: "swap", deltaIndex: deltaA, phase: "start" });
        kindMap.set(payload.cellIdB, { kind: "swap", deltaIndex: deltaB, phase: "start" });
        this.highlightKind.set(containerName, kindMap);
        requestRender();
        await afterFrame(); // 逼瀏覽器先畫一次「還在原位」，下一步才有 transition 可畫
        kindMap.set(payload.cellIdA, { kind: "swap", deltaIndex: deltaA, phase: "settle" });
        kindMap.set(payload.cellIdB, { kind: "swap", deltaIndex: deltaB, phase: "settle" });
        requestRender();
        await delay(400);
        hlSet.delete(payload.cellIdA);
        hlSet.delete(payload.cellIdB);
        kindMap.delete(payload.cellIdA);
        kindMap.delete(payload.cellIdB);
        requestRender();
    }

    private async _animateBulkChange(
        containerName: string,
        requestRender: () => void
    ): Promise<void> {
        requestRender();
        await delay(200);
    }

    // ── prospectiveOp (linear containers don't use pre-execution animations) ──

    prospectiveOp(): null { return null; }

    // ── render ────────────────────────────────────────────────────────────────

    render(containerName: string): React.ReactNode {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        const data = latestContainers?.get(containerName);
        if (!data) return null;

        const { type, values } = data;
        // Skip 2D — ContainerVisualizer handles those
        if (values.length > 0 && Array.isArray(values[0])) return null;

        // Lazy init: if cells don't exist yet, create from current values
        if (!this.cells.has(containerName)) {
            const newCells = (values as any[]).map((v: any) => ({ id: `lin-${++_cellId}`, value: String(v) }));
            this.cells.set(containerName, newCells);
            this.history.set(containerName, (values as any[]).map((v: any) => String(v)));
            this.prevJson.set(containerName, JSON.stringify((values as any[]).map((v: any) => String(v))));
        }

        const cells = this.cells.get(containerName)!;
        console.log(`[LinearPlugin.render] "${containerName}" cells=${JSON.stringify(cells.map(c=>c.value))}`);
        const enteringSet   = this.entering.get(containerName)    ?? new Set<string>();
        const fadingOutSet  = this.fadingOut.get(containerName)   ?? new Set<string>();
        const highlightSet  = this.highlighted.get(containerName) ?? new Set<string>();
        const kindMap       = this.highlightKind.get(containerName);

        const externalHL = ((global_variable as any).__latest_highlights as Map<string, HighlightEntry[]>)?.get(containerName);
        // ContainerVisualizer 元件才有 popGen 這個 React state；LinearPlugin 是
        // 獨立的 singleton，不在它底下，靠 window bridge 讀（gdbgui_is_bst_mode 的先例）。
        const popGenMap: Map<string, number> =
            (typeof window !== "undefined" && (window as any).gdbgui_get_pop_gen?.()) || new Map();

        const fs     = (store.get("container_font_size") as number) || 1.1;
        const fsPx   = `${fs}em`;
        const fsArrow = `${(fs * 1.27).toFixed(2)}em`;

        // ── Build cell elements ───────────────────────────────────────────────

        // 一格變寬，全部跟著變寬——先算出所有格子共用的寬度（含未使用容量的虛線格）。
        const display = (v: string) => (type === 'string' && v !== '' ? `'${v}'` : v);
        const cellWidth = uniformCellWidth(cells.map(c => display(c.value)), 22);

        const cellElems = cells.map((cell, idx) => {
            const isEntering   = enteringSet.has(cell.id);
            const isFadingOut  = fadingOutSet.has(cell.id);
            const isHighlighted = highlightSet.has(cell.id);
            const extHL = getHighlight(idx, externalHL, cells.length);

            // swap 的「start」影格要無過渡地先畫在偏移位置，下一影格才拿掉偏移、
            // 打開 transition——那一步 transition 一定要是 none，不然位移一開始就被
            // 動畫掉，看不到「從原位滑過來」的效果（見 _animateSwap 的兩段式呼叫）。
            const cellKind = kindMap?.get(cell.id);
            const isSwapStart = cellKind?.kind === 'swap' && cellKind.phase === 'start';
            const swapOffsetSlots = (isSwapStart && !prefersReducedMotion()) ? (cellKind as any).deltaIndex : 0;

            const opacity = (isEntering || isFadingOut) ? 0 : 1;
            const scale   = (isEntering || isFadingOut) ? 0.5 : isHighlighted ? 1.05 : 1;
            const transition = (isEntering || isSwapStart) ? 'none'
                : 'opacity 400ms cubic-bezier(0.4,0,0.2,1), transform 400ms cubic-bezier(0.4,0,0.2,1)';
            const transform = swapOffsetSlots !== 0
                ? `scale(${scale}) translateX(calc((100% + 4px) * ${swapOffsetSlots}))`
                : `scale(${scale})`;

            const bg = isHighlighted ? 'var(--highlight-soft)'
                     : extHL ? extHL.bg
                     : 'var(--surface)';
            const border = isHighlighted ? '1px solid var(--highlight)'
                         : extHL ? `1px solid ${extHL.border}`
                         : '1px solid var(--struct-border)';

            const style: React.CSSProperties = {
                flexGrow: 1, flexShrink: 0, flexBasis: cellWidth,
                minWidth: '34px', padding: '12px 10px', textAlign: 'center',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: fsPx, color: 'var(--ink)',
                boxSizing: 'border-box', background: bg, border, borderRadius: '6px',
                fontWeight: (isHighlighted || extHL) ? 700 : 500,
                opacity, transform, transition,
                ...(isHighlighted ? { boxShadow: '0 0 0 1px var(--highlight)' } : {}),
            };

            if (type === 'list') style.borderRadius = '999px';

            const displayValue = display(cell.value);
            const pop = popCellKey(cell.id, effectivePopGen(popGenMap, containerName, extHL?.bg), extHL);
            // valueChange（覆蓋/變更為某數）跟 swap（交換）自動偵測，動作要看得出差別：
            // value 沿用 cell-pop（放大再縮小，class 觸發的 keyframe）；swap 是上面算好的
            // translateX 位移本身就是動作，不需要另外掛 class——class 開/關是靠
            // highlightKind 直接 toggle，不需要跟 pop.key 一樣換 key 強迫重掛。
            const animClassName = cellKind?.kind === 'value' ? 'cell-pop' : pop.className;

            return React.createElement('div', {
                key: pop.key,
                className: animClassName,
                'data-testid': 'container-cell',
                'data-value': String(cell.value),
                style,
            }, displayValue);
        });

        // ── Empty state ───────────────────────────────────────────────────────

        const emptyEl = React.createElement('div', {
            style: {
                flexGrow: 1, flexShrink: 0, flexBasis: cellWidth,
                minWidth: '34px', padding: '12px 10px', textAlign: 'center',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: fsPx, color: 'var(--ink-faint)',
                border: '1px dashed var(--struct-border)', background: 'var(--empty-bg)',
                borderRadius: '6px', fontStyle: 'italic',
            },
        }, 'empty');

        const frame: React.CSSProperties = {
            display: 'flex', border: '1px solid var(--line)', borderRadius: '10px',
            background: 'var(--paper)', padding: '6px', gap: '4px', width: '100%', alignItems: 'stretch',
        };

        const conn = (ch: string, key: string) =>
            React.createElement('span', {
                key,
                style: { color: 'var(--accent)', fontWeight: 700, fontSize: fsArrow, display: 'flex', alignItems: 'center', padding: '0 4px' },
            }, ch);

        // ── Type-specific layouts ─────────────────────────────────────────────

        switch (type) {
            case 'vector':
            case 'array':
            case 'string': {
                const rawCap = data.capacity !== undefined ? parseInt(data.capacity) : cells.length;
                const cap = (!isNaN(rawCap) && rawCap >= 0) ? rawCap : cells.length;
                const emptySlots = (cap > cells.length && cap - cells.length < 1000) ? cap - cells.length : 0;

                return React.createElement('div', { style: { display: 'flex', width: '100%', alignItems: 'stretch', gap: '4px' } },
                    React.createElement('div', { style: frame },
                        ...(cellElems.length > 0 ? cellElems : [emptyEl])
                    ),
                    ...(emptySlots > 0 ? Array.from({ length: emptySlots }).map((_, i) =>
                        React.createElement('div', {
                            key: `cap-${i}`,
                            style: {
                                flexGrow: 1, flexShrink: 0, flexBasis: cellWidth, boxSizing: 'border-box',
                                minWidth: '34px', padding: '6px', textAlign: 'center',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontFamily: 'var(--font-mono)', fontSize: fsPx, color: 'var(--ink-faint)',
                                border: '1px dashed var(--struct-border)', background: 'var(--empty-bg)',
                                borderRadius: '6px', fontStyle: 'italic',
                            },
                            title: '未使用容量 (Unused Capacity)',
                        })
                    ) : [])
                );
            }
            case 'list': {
                const items: React.ReactNode[] = [];
                cellElems.forEach((cell, idx) => {
                    items.push(cell);
                    if (idx < cellElems.length - 1) items.push(conn('↔', `c${idx}`));
                });
                return React.createElement('div', {
                    style: { display: 'flex', width: '100%', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
                }, ...(items.length > 0 ? items : [
                    React.createElement('div', {
                        style: { ...frame, borderRadius: '999px' },
                    }, emptyEl)
                ]));
            }
            case 'stack': {
                const endTag = React.createElement('span', {
                    style: {
                        display: 'flex', alignItems: 'center', padding: '0 8px',
                        color: 'var(--accent)', fontWeight: 700,
                        fontFamily: 'var(--font-display)', fontSize: '0.78em',
                        textTransform: 'uppercase' as const, letterSpacing: '0.05em', whiteSpace: 'nowrap' as const,
                    },
                }, '↑ top');
                return React.createElement('div', { style: { display: 'flex', width: '100%', alignItems: 'stretch', gap: '4px' } },
                    React.createElement('div', { style: frame },
                        ...(cellElems.length > 0 ? cellElems : [emptyEl])
                    ),
                    ...(cells.length > 0 ? [endTag] : [])
                );
            }
            case 'queue': {
                return React.createElement('div', { style: { display: 'flex', width: '100%', alignItems: 'stretch' } },
                    conn('←', 'qf'),
                    React.createElement('div', { style: frame },
                        ...(cellElems.length > 0 ? cellElems : [emptyEl])
                    ),
                    conn('←', 'qb')
                );
            }
            case 'deque': {
                return React.createElement('div', { style: { display: 'flex', width: '100%', alignItems: 'stretch' } },
                    conn('↔', 'df'),
                    React.createElement('div', { style: frame },
                        ...(cellElems.length > 0 ? cellElems : [emptyEl])
                    ),
                    conn('↔', 'db')
                );
            }
            default:
                return null;
        }
    }

    // ── reset ─────────────────────────────────────────────────────────────────

    resetAll(): void {
        this.history.clear();
        this.prevJson.clear();
        this.cells.clear();
        this.entering.clear();
        this.fadingOut.clear();
        this.highlighted.clear();
        this.highlightKind.clear();
    }

    trackedNames(): string[] {
        return Array.from(this.history.keys());
    }

    resetContainer(containerName: string): void {
        this.history.delete(containerName);
        this.prevJson.delete(containerName);
        this.cells.delete(containerName);
        this.entering.delete(containerName);
        this.fadingOut.delete(containerName);
        this.highlighted.delete(containerName);
        this.highlightKind.delete(containerName);
    }
}

export const linearPlugin = new LinearPluginImpl();
