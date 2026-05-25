// BSTPlugin.ts
// Visualizer plugin for BST-based containers: set, map, multiset, multimap.
// Owns all BST history, animation state, layout, and rendering logic.

import React from "react";
import { global_variable } from "./global_variable";
import { ContainerPlugin, ContainerData } from "./ContainerPlugin";
import { PluginOp } from "./AnimScheduler";

// ── BST data structures ───────────────────────────────────────────────────────

interface BSTEntry {
    id: string;
    key: string;
    label: string;
}

interface BSTNode {
    entry: BSTEntry;
    left: BSTNode | null;
    right: BSTNode | null;
}

interface BSTPos { node: BSTNode; x: number; y: number; }

let _bstIdCounter = 0;

function bstCmp(a: string, b: string): number {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
}

function bstInsertNode(root: BSTNode | null, entry: BSTEntry): BSTNode {
    const node: BSTNode = { entry, left: null, right: null };
    if (!root) return node;
    let cur: BSTNode = root;
    while (true) {
        if (bstCmp(entry.key, cur.entry.key) < 0) {
            if (!cur.left) { cur.left = node; break; }
            cur = cur.left;
        } else {
            if (!cur.right) { cur.right = node; break; }
            cur = cur.right;
        }
    }
    return root;
}

function computeBSTLayout(root: BSTNode | null): BSTPos[] {
    const pos: BSTPos[] = [];
    const H = 60, V = 72;
    const minRankOf = new Map<BSTNode, number>();
    const maxRankOf = new Map<BSTNode, number>();
    let rank = 0;
    function assign(n: BSTNode | null, depth: number) {
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

function computeBSTComparisonPath(root: BSTNode | null, newKey: string): string[] {
    const path: string[] = [];
    let cur = root;
    while (cur !== null) {
        path.push(cur.entry.id);
        if (bstCmp(newKey, cur.entry.key) < 0) cur = cur.left;
        else cur = cur.right;
    }
    return path;
}

// ── Animation state ───────────────────────────────────────────────────────────

interface BSTAnimState {
    animatingIn:  Map<string, Set<string>>;
    animatingOut: Map<string, Set<string>>;
    hiddenIds:    Map<string, Set<string>>;
    comparingIds: Map<string, Set<string>>;
    findResultId: Map<string, { id: string; found: boolean; duplicate?: boolean } | null>;
}

// ── Op payload types ──────────────────────────────────────────────────────────

interface InsertPayload { entry: BSTEntry; compPath: string[]; }
interface ErasePayload  { entry: BSTEntry; compPath: string[]; }

// IDs of nodes being erase-animated (ghosts). Prevents double-detection in diffOps.
const _deletingIds = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function afterFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// ── BSTPlugin class ───────────────────────────────────────────────────────────

class BSTPlugin implements ContainerPlugin {
    readonly supportedTypes = ['set', 'map', 'multiset', 'multimap'];

    private anim: BSTAnimState = {
        animatingIn:  new Map(),
        animatingOut: new Map(),
        hiddenIds:    new Map(),
        comparingIds: new Map(),
        findResultId: new Map(),
    };

    // ── ContainerPlugin: diffOps ──────────────────────────────────────────────

    diffOps(containerName: string, newData: ContainerData): PluginOp[] {
        if (!(global_variable as any).__bst_history)      (global_variable as any).__bst_history = {};
        if (!(global_variable as any).__bst_prev_json)    (global_variable as any).__bst_prev_json = {};

        const bstHistory: { [n: string]: BSTEntry[] } = (global_variable as any).__bst_history;
        const prevJson:   { [n: string]: string }     = (global_variable as any).__bst_prev_json;

        const { type, values } = newData;
        const isMap = type === 'map' || type === 'multimap';

        const currentJson = JSON.stringify(values);
        if (currentJson === prevJson[containerName]) return [];
        prevJson[containerName] = currentJson;

        const currentCounts: { [k: string]: number } = {};
        for (const v of values) {
            const k = isMap ? String((v as any).key) : String(v);
            currentCounts[k] = (currentCounts[k] || 0) + 1;
        }

        if (!bstHistory[containerName]) {
            bstHistory[containerName] = [];
            if (values.length === 0) return [];  // empty first encounter — render "empty"

            // Non-empty first encounter: animate each element individually
            const history = bstHistory[containerName];
            const firstEncounterOps: PluginOp[] = [];
            for (const v of values) {
                const k = isMap ? String((v as any).key) : String(v);
                const lbl = isMap ? `${k}→${(v as any).value}` : k;
                let compRoot: BSTNode | null = null;
                for (const e of history) compRoot = bstInsertNode(compRoot, e);
                const compPath = computeBSTComparisonPath(compRoot, k);
                const entry: BSTEntry = { id: `bst-${++_bstIdCounter}`, key: k, label: lbl };
                history.push(entry);
                const hidSet = this.anim.hiddenIds.get(containerName) ?? new Set<string>();
                hidSet.add(entry.id);
                this.anim.hiddenIds.set(containerName, hidSet);
                firstEncounterOps.push({ type: 'insert', payload: { entry, compPath } as InsertPayload });
            }
            return firstEncounterOps;
        }

        const history = bstHistory[containerName];
        const ops: PluginOp[] = [];

        // prev counts — skip ghost entries currently being erase-animated
        const prevCounts: { [k: string]: number } = {};
        for (const e of history) {
            if (_deletingIds.has(e.id)) continue;
            prevCounts[e.key] = (prevCounts[e.key] || 0) + 1;
        }

        // Deletions
        for (const k in prevCounts) {
            const removed = (prevCounts[k] || 0) - (currentCounts[k] || 0);
            for (let i = 0; i < removed; i++) {
                let idx = -1;
                for (let j = history.length - 1; j >= 0; j--) {
                    if (history[j].key === k && !_deletingIds.has(history[j].id)) { idx = j; break; }
                }
                if (idx === -1) continue;
                const entry = history[idx];
                let compRoot: BSTNode | null = null;
                for (const e of history) {
                    if (!_deletingIds.has(e.id)) compRoot = bstInsertNode(compRoot, e);
                }
                const compPath = computeBSTComparisonPath(compRoot, k);
                _deletingIds.add(entry.id);
                ops.push({ type: 'erase', payload: { entry, compPath } as ErasePayload });
            }
        }

        // Insertions
        for (const k in currentCounts) {
            const added = (currentCounts[k] || 0) - (prevCounts[k] || 0);
            for (let i = 0; i < added; i++) {
                let compRoot: BSTNode | null = null;
                for (const e of history) {
                    if (!_deletingIds.has(e.id)) compRoot = bstInsertNode(compRoot, e);
                }
                const compPath = computeBSTComparisonPath(compRoot, k);
                const v = isMap ? (values as any[]).find((e: any) => String(e.key) === k) : null;
                const lbl = isMap && v ? `${k}→${(v as any).value}` : k;
                const entry: BSTEntry = { id: `bst-${++_bstIdCounter}`, key: k, label: lbl };
                history.push(entry);
                // Pre-hide new node so it appears invisible before animation reveals it
                const s = this.anim.hiddenIds.get(containerName) ?? new Set<string>();
                s.add(entry.id);
                this.anim.hiddenIds.set(containerName, s);
                ops.push({ type: 'insert', payload: { entry, compPath } as InsertPayload });
            }
        }

        // Update map labels for value changes (key unchanged)
        if (isMap) {
            for (const e of history) {
                const v = (values as any[]).find((item: any) => String(item.key) === e.key);
                if (v) e.label = `${e.key}→${(v as any).value}`;
            }
        }

        return ops;
    }

    // ── ContainerPlugin: animateOp ────────────────────────────────────────────

    async animateOp(containerName: string, op: PluginOp, requestRender: () => void): Promise<void> {
        if (op.type === 'insert') {
            const p = op.payload as InsertPayload;
            await this._runInsert(containerName, p.entry, p.compPath, requestRender);
        } else if (op.type === 'erase') {
            const p = op.payload as ErasePayload;
            await this._runErase(containerName, p.entry, p.compPath, requestRender);
        }
    }

    // ── ContainerPlugin: prospectiveOp ────────────────────────────────────────

    prospectiveOp(
        containerName: string,
        opType: string,
        key: string,
        requestRender: () => void
    ): Promise<void> | null {
        const bstHistory: any = (global_variable as any).__bst_history;
        if (!bstHistory || !(containerName in bstHistory)) return null;

        if (opType === 'find') {
            const history: BSTEntry[] = (bstHistory[containerName] as BSTEntry[])
                .filter(e => !_deletingIds.has(e.id));
            let root: BSTNode | null = null;
            for (const e of history) root = bstInsertNode(root, e);
            const compPath = computeBSTComparisonPath(root, key);
            const found = history.some(e => bstCmp(e.key, key) === 0);
            return this._runFind(containerName, compPath, found, false, requestRender);
        }

        if (opType === 'dupInsert') {
            const history: BSTEntry[] = (bstHistory[containerName] as BSTEntry[])
                .filter(e => !_deletingIds.has(e.id));
            let root: BSTNode | null = null;
            for (const e of history) root = bstInsertNode(root, e);
            const compPath = computeBSTComparisonPath(root, key);
            return this._runFind(containerName, compPath, true, true, requestRender);
        }

        return null;
    }

    // ── ContainerPlugin: render ───────────────────────────────────────────────

    render(containerName: string): React.ReactNode {
        if (!(global_variable as any).__bst_history) (global_variable as any).__bst_history = {};
        if (!(global_variable as any).__bst_prev_json) (global_variable as any).__bst_prev_json = {};
        const bstHistory: { [n: string]: BSTEntry[] } = (global_variable as any).__bst_history;
        let history = bstHistory[containerName] || [];

        // Lazy init: if history is empty but __latest_containers already has data
        if (history.length === 0) {
            const latestContainers = (global_variable as any).__latest_containers as Map<string, any> | undefined;
            const data = latestContainers && latestContainers.get(containerName);
            if (data && data.values && data.values.length > 0) {
                const isMap = data.type === 'map' || data.type === 'multimap';
                history = [];
                for (const v of data.values) {
                    const k = isMap ? String((v as any).key) : String(v);
                    const lbl = isMap ? `${k}→${(v as any).value}` : k;
                    history.push({ id: `bst-${++_bstIdCounter}`, key: k, label: lbl });
                }
                bstHistory[containerName] = history;
                (global_variable as any).__bst_prev_json[containerName] = JSON.stringify(data.values);
            }
        }

        if (history.length === 0) {
            return React.createElement('div', { style: { color: '#999', fontStyle: 'italic', padding: '8px' } }, 'empty');
        }

        let root: BSTNode | null = null;
        for (const entry of history) root = bstInsertNode(root, entry);

        const positions = computeBSTLayout(root);
        const R = 26, PAD = R + 22;
        const maxX = positions.length > 0 ? Math.max(...positions.map(p => p.x)) : 0;
        const maxY = positions.length > 0 ? Math.max(...positions.map(p => p.y)) : 0;
        const svgW = maxX + PAD * 2;
        const svgH = maxY + PAD * 2;

        const posMap = new Map<string, { x: number; y: number }>();
        for (const { node, x, y } of positions) posMap.set(node.entry.id, { x: x + PAD, y: y + PAD });

        const animIn     = this.anim.animatingIn.get(containerName)  ?? new Set<string>();
        const animOut    = this.anim.animatingOut.get(containerName) ?? new Set<string>();
        const hiddenIds  = this.anim.hiddenIds.get(containerName)    ?? new Set<string>();
        const comparing  = this.anim.comparingIds.get(containerName) ?? new Set<string>();
        const findResult = this.anim.findResultId.get(containerName) ?? null;

        const edges: React.ReactNode[] = [];
        const nodeElems: React.ReactNode[] = [];

        for (const { node } of positions) {
            const p = posMap.get(node.entry.id)!;

            if (node.left) {
                const lp = posMap.get(node.left.entry.id);
                if (lp) edges.push(
                    React.createElement('line', {
                        key: `e-${node.entry.id}-L`,
                        x1: p.x, y1: p.y, x2: lp.x, y2: lp.y,
                        stroke: '#999', strokeWidth: 1.5
                    })
                );
            }
            if (node.right) {
                const rp = posMap.get(node.right.entry.id);
                if (rp) edges.push(
                    React.createElement('line', {
                        key: `e-${node.entry.id}-R`,
                        x1: p.x, y1: p.y, x2: rp.x, y2: rp.y,
                        stroke: '#999', strokeWidth: 1.5
                    })
                );
            }

            const isNew       = animIn.has(node.entry.id);
            const isDeleting  = animOut.has(node.entry.id);
            const isHidden    = hiddenIds.has(node.entry.id);
            const isComparing = comparing.has(node.entry.id);
            const isFindFound    = findResult?.id === node.entry.id && findResult.found && !findResult.duplicate;
            const isFindNotFound = findResult?.id === node.entry.id && findResult.found === false;
            const isDuplicate    = findResult?.id === node.entry.id && findResult.duplicate === true;

            const opacity = (isNew || isDeleting || isHidden) ? 0 : 1;
            const scale   = (isNew || isDeleting || isHidden) ? 0.1
                          : (isComparing || isFindFound || isFindNotFound || isDuplicate) ? 1.12 : 1;
            const fill    = isDeleting     ? '#ffcdd2'
                          : isComparing    ? '#ff9800'
                          : isFindFound    ? '#4caf50'
                          : isFindNotFound ? '#f44336'
                          : isDuplicate    ? '#ffd54f'
                          : '#fff';
            const stroke  = isDeleting     ? '#e53935'
                          : isComparing    ? '#e65100'
                          : isFindFound    ? '#2e7d32'
                          : isFindNotFound ? '#b71c1c'
                          : isDuplicate    ? '#e65100'
                          : '#333';
            const innerTransition = isHidden ? 'none' : 'opacity 0.45s ease, transform 0.45s ease';

            const lbl = node.entry.label.length > 10
                ? node.entry.label.slice(0, 9) + '…'
                : node.entry.label;

            nodeElems.push(
                React.createElement('g', {
                    key: node.entry.id,
                    style: { transform: `translate(${p.x}px, ${p.y}px)`, transition: 'transform 0.5s ease' }
                },
                    React.createElement('g', {
                        style: {
                            opacity,
                            transform: `scale(${scale})`,
                            transition: innerTransition,
                            transformBox: 'fill-box',
                            transformOrigin: 'center',
                        }
                    },
                        React.createElement('circle', { r: R, fill, stroke, strokeWidth: 2 }),
                        React.createElement('text', {
                            textAnchor: 'middle', dy: 4,
                            fill: '#222', fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold'
                        }, lbl)
                    )
                )
            );
        }

        return React.createElement('div', null,
            React.createElement('div', { style: { overflowX: 'auto' } },
                React.createElement('svg', { width: svgW, height: svgH, style: { display: 'block' } },
                    React.createElement('g', null, ...edges),
                    React.createElement('g', null, ...nodeElems)
                )
            ),
            React.createElement('div', {
                style: { fontSize: '11px', color: '#888', marginTop: '4px', fontFamily: 'sans-serif' }
            }, '傳統二元搜尋樹（按插入順序建樹，無旋轉）')
        );
    }

    // ── ContainerPlugin: reset ────────────────────────────────────────────────

    resetAll(): void {
        (global_variable as any).__bst_history  = {};
        (global_variable as any).__bst_prev_json = {};
        _deletingIds.clear();
        this.anim = {
            animatingIn:  new Map(),
            animatingOut: new Map(),
            hiddenIds:    new Map(),
            comparingIds: new Map(),
            findResultId: new Map(),
        };
    }

    resetContainer(containerName: string): void {
        const h: any = (global_variable as any).__bst_history;
        if (h) delete h[containerName];
        const p: any = (global_variable as any).__bst_prev_json;
        if (p) delete p[containerName];
        this.anim.animatingIn.delete(containerName);
        this.anim.animatingOut.delete(containerName);
        this.anim.hiddenIds.delete(containerName);
        this.anim.comparingIds.delete(containerName);
        this.anim.findResultId.delete(containerName);
    }

    // ── Private animation helpers ─────────────────────────────────────────────

    private async _walkComparePath(
        containerName: string,
        compPath: string[],
        requestRender: () => void
    ): Promise<void> {
        for (const nodeId of compPath) {
            const s = new Set<string>([nodeId]);
            this.anim.comparingIds.set(containerName, s);
            requestRender();
            await afterFrame();
            await delay(500);
        }
        this.anim.comparingIds.delete(containerName);
        requestRender();
        await afterFrame();
    }

    private async _runInsert(
        containerName: string,
        entry: BSTEntry,
        compPath: string[],
        requestRender: () => void
    ): Promise<void> {
        await this._walkComparePath(containerName, compPath, requestRender);

        // Move from hidden → animatingIn (opacity:0 with transition enabled)
        const hidden = this.anim.hiddenIds.get(containerName) ?? new Set<string>();
        hidden.delete(entry.id);
        this.anim.hiddenIds.set(containerName, hidden);
        const inSet = this.anim.animatingIn.get(containerName) ?? new Set<string>();
        inSet.add(entry.id);
        this.anim.animatingIn.set(containerName, inSet);
        requestRender();

        // One frame so browser applies opacity:0 before we clear animatingIn
        await afterFrame();

        // Clear animatingIn → CSS transition fires (opacity 0→1)
        inSet.delete(entry.id);
        this.anim.animatingIn.set(containerName, inSet);
        requestRender();
        await delay(500);
    }

    private async _runErase(
        containerName: string,
        entry: BSTEntry,
        compPath: string[],
        requestRender: () => void
    ): Promise<void> {
        await this._walkComparePath(containerName, compPath, requestRender);

        // Fade out
        const outSet = this.anim.animatingOut.get(containerName) ?? new Set<string>();
        outSet.add(entry.id);
        this.anim.animatingOut.set(containerName, outSet);
        requestRender();
        await delay(520);

        // Remove from history
        const bstHistory = (global_variable as any).__bst_history as { [n: string]: BSTEntry[] };
        if (bstHistory && bstHistory[containerName]) {
            bstHistory[containerName] = bstHistory[containerName].filter(e => e.id !== entry.id);
        }
        _deletingIds.delete(entry.id);
        outSet.delete(entry.id);
        this.anim.animatingOut.set(containerName, outSet);
        requestRender();
    }

    private async _runFind(
        containerName: string,
        compPath: string[],
        found: boolean,
        duplicate: boolean,
        requestRender: () => void
    ): Promise<void> {
        await this._walkComparePath(containerName, compPath, requestRender);

        const lastNodeId = compPath.length > 0 ? compPath[compPath.length - 1] : null;
        if (lastNodeId) {
            this.anim.findResultId.set(containerName, { id: lastNodeId, found, duplicate });
            requestRender();
        }
        await delay(800);
        this.anim.findResultId.delete(containerName);
        requestRender();
    }
}

export const bstPlugin = new BSTPlugin();
