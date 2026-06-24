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

    // ── animateOp (stub — implemented in Task 2) ──────────────────────────────

    async animateOp(_containerName: string, _op: PluginOp, _requestRender: () => void): Promise<void> {
        // TODO: implement in Task 2
    }

    // ── prospectiveOp (linear containers don't use pre-execution animations) ──

    prospectiveOp(): null { return null; }

    // ── render (stub — implemented in Task 2) ─────────────────────────────────

    render(_containerName: string): React.ReactNode { return null; }

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
