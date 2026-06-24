import React from "react";
import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import { ContainerPlugin, ContainerData } from "./ContainerPlugin";
import { PluginOp } from "./AnimScheduler";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LinearCell {
    id: string;
    value: string;
}

interface InsertPayload { index: number; value: string; cellId: string; }
interface ErasePayload  { index: number; value: string; cellId: string; }
interface ValueChangePayload { index: number; oldValue: string; newValue: string; cellId: string; }
interface SwapPayload   { indexA: number; indexB: number; cellIdA: string; cellIdB: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

let _cellId = 0;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function afterFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
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

    // ── diffOps ───────────────────────────────────────────────────────────────

    diffOps(containerName: string, newData: ContainerData): PluginOp[] {
        const { values } = newData;
        if (values.length > 0 && Array.isArray(values[0])) return [];

        const newVals = values.map(v => String(v));
        const json = JSON.stringify(newVals);
        if (json === this.prevJson.get(containerName)) return [];
        this.prevJson.set(containerName, json);

        const oldVals = this.history.get(containerName);
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
                if (oldVals[a] === newVals[b] && oldVals[b] === newVals[a]) {
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
            // Don't remove from cells yet — ghost stays for erase animation
        } else {
            // Bulk change: replace all cells
            const newCells = newVals.map(v => ({ id: `lin-${++_cellId}`, value: v }));
            this.cells.set(containerName, newCells);
            ops.push({ type: 'bulkChange', payload: {} });
        }

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
        // entering → visible (CSS transition: opacity 0→1, scale 0.5→1)
        const enterSet = this.entering.get(containerName) ?? new Set<string>();
        enterSet.delete(payload.cellId);
        this.entering.set(containerName, enterSet);
        requestRender();
        await afterFrame();
        // Now opacity transitions from 0 to 1 via CSS
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
        requestRender();
        await delay(400);
        hlSet.delete(payload.cellId);
        requestRender();
    }

    private async _animateSwap(
        containerName: string,
        payload: { cellIdA: string; cellIdB: string },
        requestRender: () => void
    ): Promise<void> {
        const hlSet = this.highlighted.get(containerName) ?? new Set<string>();
        hlSet.add(payload.cellIdA);
        hlSet.add(payload.cellIdB);
        this.highlighted.set(containerName, hlSet);
        requestRender();
        await delay(400);
        hlSet.delete(payload.cellIdA);
        hlSet.delete(payload.cellIdB);
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
        const enteringSet   = this.entering.get(containerName)    ?? new Set<string>();
        const fadingOutSet  = this.fadingOut.get(containerName)   ?? new Set<string>();
        const highlightSet  = this.highlighted.get(containerName) ?? new Set<string>();

        const externalHL = ((global_variable as any).__latest_highlights as Map<string, HighlightEntry[]>)?.get(containerName);

        const fs     = (store.get("container_font_size") as number) || 1.1;
        const fsPx   = `${fs}em`;
        const fsArrow = `${(fs * 1.27).toFixed(2)}em`;

        // ── Build cell elements ───────────────────────────────────────────────

        const cellElems = cells.map((cell, idx) => {
            const isEntering   = enteringSet.has(cell.id);
            const isFadingOut  = fadingOutSet.has(cell.id);
            const isHighlighted = highlightSet.has(cell.id);
            const extHL = getHighlight(idx, externalHL, cells.length);

            const opacity = (isEntering || isFadingOut) ? 0 : 1;
            const scale   = (isEntering || isFadingOut) ? 0.5 : isHighlighted ? 1.05 : 1;
            const transition = isEntering ? 'none'
                : 'opacity 400ms cubic-bezier(0.4,0,0.2,1), transform 400ms cubic-bezier(0.4,0,0.2,1)';

            const bg = isHighlighted ? 'var(--highlight-soft)'
                     : extHL ? extHL.bg
                     : 'var(--surface)';
            const border = isHighlighted ? '1px solid var(--highlight)'
                         : extHL ? `1px solid ${extHL.border}`
                         : '1px solid var(--struct-border)';

            const style: React.CSSProperties = {
                flex: 1, minWidth: '34px', padding: '12px 10px', textAlign: 'center',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: fsPx, color: 'var(--ink)',
                boxSizing: 'border-box', background: bg, border, borderRadius: '6px',
                fontWeight: (isHighlighted || extHL) ? 700 : 500,
                opacity, transform: `scale(${scale})`, transition,
                ...(isHighlighted ? { boxShadow: '0 0 0 1px var(--highlight)' } : {}),
            };

            if (type === 'list') style.borderRadius = '999px';

            const displayValue = type === 'string' && cell.value !== '' ? `'${cell.value}'` : cell.value;

            return React.createElement('div', {
                key: cell.id,
                'data-testid': 'container-cell',
                'data-value': String(cell.value),
                style,
            }, displayValue);
        });

        // ── Empty state ───────────────────────────────────────────────────────

        const emptyEl = React.createElement('div', {
            style: {
                flex: 1, minWidth: '34px', padding: '12px 10px', textAlign: 'center',
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
                                flex: 1, minWidth: '34px', padding: '6px', textAlign: 'center',
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
    }

    resetContainer(containerName: string): void {
        this.history.delete(containerName);
        this.prevJson.delete(containerName);
        this.cells.delete(containerName);
        this.entering.delete(containerName);
        this.fadingOut.delete(containerName);
        this.highlighted.delete(containerName);
    }
}

export const linearPlugin = new LinearPluginImpl();
