# Container Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add animations to all data structure visualization objects — linear containers (vector/list/queue/stack/deque/array/string) and maze mode — following the ContainerPlugin pattern established by BSTPlugin.

**Architecture:** Two new modules:
1. `LinearPlugin.tsx` — implements `ContainerPlugin`, registers via plugin registry for linear container types. Owns diff, animation, and rendering for 1D linear containers.
2. `MazePlugin.tsx` — standalone module (NOT registered in plugin registry), used directly by ContainerVisualizer when maze mode is on. Handles cell-by-cell color transitions.

Both integrate with `AnimScheduler` for barrier synchronization (GDB stepping waits for animations).

**Tech Stack:** React, TypeScript, CSS transitions/custom properties, Jest

## Global Constraints

- Animation timing via CSS custom properties in `:root` — never hardcode durations in JS
- `data-testid="container-cell"` attributes MUST be preserved for E2E compatibility
- No new npm dependencies
- AnimScheduler barrier must block GDB stepping during animations
- Plugin interface (`ContainerPlugin`) is NOT modified — new plugins implement the existing interface
- 2D arrays fall through to existing ContainerVisualizer rendering (LinearPlugin returns `null`)
- `set/map/multiset/multimap` in non-BST mode keep their existing rendering (not animated)

---

### Task 1: CSS Animation Tokens + LinearPlugin diffOps + Tests

**Files:**
- Modify: `gdbgui/static/css/gdbgui.css:8-26` (add tokens to `:root`)
- Create: `gdbgui/src/js/LinearPlugin.tsx`
- Create: `gdbgui/src/js/tests/LinearPlugin.jest.ts`

**Interfaces:**
- Consumes: `ContainerPlugin` interface from `ContainerPlugin.ts`, `PluginOp` from `AnimScheduler.ts`
- Produces: `linearPlugin` singleton export; `diffOps(containerName, newData) → PluginOp[]` with op types: `insert`, `erase`, `valueChange`, `swap`, `pushBack`, `popBack`, `pushFront`, `popFront`, `bulkChange`

- [ ] **Step 1: Add CSS animation tokens to `:root`**

In `gdbgui/static/css/gdbgui.css`, add after the existing `--empty-bg` line (line 21):

```css
  --anim-base:     400ms;
  --anim-fast:     200ms;
  --anim-slide:    500ms;
  --anim-ease:     cubic-bezier(0.4, 0, 0.2, 1);
  --anim-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --anim-ease-in:  cubic-bezier(0.4, 0, 1, 1);
```

- [ ] **Step 2: Write LinearPlugin.jest.ts — diffOps tests**

Create `gdbgui/src/js/tests/LinearPlugin.jest.ts`:

```typescript
import { linearPlugin } from '../LinearPlugin';

beforeEach(() => {
    linearPlugin.resetAll();
});

// ── diffOps: first encounter ──────────────────────────────────────────────────

describe('diffOps — first encounter', () => {
    it('empty container returns []', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: [] });
        expect(ops).toEqual([]);
    });

    it('non-empty first encounter returns bulkChange', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('bulkChange');
    });

    it('2D array returns [] (skipped)', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: [['1', '2'], ['3', '4']] });
        expect(ops).toEqual([]);
    });
});

// ── diffOps: identical data ───────────────────────────────────────────────────

describe('diffOps — identical data', () => {
    it('same data returns []', () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        expect(ops).toEqual([]);
    });
});

// ── diffOps: length +1 (insert/push) ─────────────────────────────────────────

describe('diffOps — length +1', () => {
    beforeEach(() => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3'] });
    });

    it('pushBack: insert at end', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3', '4'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('pushBack');
        expect((ops[0].payload as any).value).toBe('4');
    });

    it('pushFront: insert at start', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['0', '1', '2', '3'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('pushFront');
        expect((ops[0].payload as any).value).toBe('0');
    });

    it('insert: insert at middle', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', 'X', '2', '3'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('insert');
        expect((ops[0].payload as any).index).toBe(1);
        expect((ops[0].payload as any).value).toBe('X');
    });
});

// ── diffOps: length -1 (erase/pop) ───────────────────────────────────────────

describe('diffOps — length -1', () => {
    beforeEach(() => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3', '4'] });
    });

    it('popBack: erase at end', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('popBack');
        expect((ops[0].payload as any).value).toBe('4');
    });

    it('popFront: erase at start', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['2', '3', '4'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('popFront');
        expect((ops[0].payload as any).value).toBe('1');
    });

    it('erase: erase at middle', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '3', '4'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('erase');
        expect((ops[0].payload as any).index).toBe(1);
        expect((ops[0].payload as any).value).toBe('2');
    });
});

// ── diffOps: same length (valueChange / swap) ────────────────────────────────

describe('diffOps — same length', () => {
    beforeEach(() => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '5', '3', '8'] });
    });

    it('valueChange: single value differs', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '9', '3', '8'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('valueChange');
        expect((ops[0].payload as any).index).toBe(1);
        expect((ops[0].payload as any).oldValue).toBe('5');
        expect((ops[0].payload as any).newValue).toBe('9');
    });

    it('swap: exactly two values exchanged', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '3', '5', '8'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('swap');
        expect((ops[0].payload as any).indexA).toBe(1);
        expect((ops[0].payload as any).indexB).toBe(2);
    });

    it('multiple valueChanges: three+ values differ', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['9', '9', '9', '8'] });
        expect(ops).toHaveLength(3);
        expect(ops.every(o => o.type === 'valueChange')).toBe(true);
    });
});

// ── diffOps: bulk change ─────────────────────────────────────────────────────

describe('diffOps — bulk change', () => {
    beforeEach(() => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
    });

    it('length diff > 1 returns bulkChange', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3', '4', '5'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('bulkChange');
    });

    it('length diff < -1 returns bulkChange', () => {
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: [] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('bulkChange');
    });
});

// ── diffOps: separate containers ──────────────────────────────────────────────

describe('diffOps — container isolation', () => {
    it('separate containers tracked independently', () => {
        linearPlugin.diffOps('v1', { type: 'vector', values: ['1'] });
        linearPlugin.diffOps('v2', { type: 'vector', values: ['A'] });
        const ops = linearPlugin.diffOps('v1', { type: 'vector', values: ['1', '2'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('pushBack');
    });
});

// ── resetAll / resetContainer ─────────────────────────────────────────────────

describe('resetAll', () => {
    it('after resetAll, same data is treated as first encounter', () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        linearPlugin.resetAll();
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('bulkChange');
    });
});

describe('resetContainer', () => {
    it('clears only the named container', () => {
        linearPlugin.diffOps('v1', { type: 'vector', values: ['1'] });
        linearPlugin.diffOps('v2', { type: 'vector', values: ['A'] });
        linearPlugin.resetContainer('v1');
        // v1: reset → first encounter
        const ops1 = linearPlugin.diffOps('v1', { type: 'vector', values: ['1'] });
        expect(ops1).toHaveLength(1);
        expect(ops1[0].type).toBe('bulkChange');
        // v2: unchanged → []
        const ops2 = linearPlugin.diffOps('v2', { type: 'vector', values: ['A'] });
        expect(ops2).toEqual([]);
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest gdbgui/src/js/tests/LinearPlugin.jest.ts --no-coverage`
Expected: FAIL — `Cannot find module '../LinearPlugin'`

- [ ] **Step 4: Write LinearPlugin.tsx — diffOps implementation**

Create `gdbgui/src/js/LinearPlugin.tsx`:

```tsx
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
                    const tmp = c[a]; c[a] = c[b]; c[b] = tmp;
                    c[a].value = newVals[a];
                    c[b].value = newVals[b];
                    ops.push({ type: 'swap', payload: { indexA: a, indexB: b, cellIdA: c[a].id, cellIdB: c[b].id } as SwapPayload });
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest gdbgui/src/js/tests/LinearPlugin.jest.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add gdbgui/static/css/gdbgui.css gdbgui/src/js/LinearPlugin.tsx gdbgui/src/js/tests/LinearPlugin.jest.ts
git commit -m "feat(anim): CSS tokens + LinearPlugin diffOps with tests"
```

---

### Task 2: LinearPlugin animateOp + render + Tests

**Files:**
- Modify: `gdbgui/src/js/LinearPlugin.tsx`
- Modify: `gdbgui/src/js/tests/LinearPlugin.jest.ts`

**Interfaces:**
- Consumes: `global_variable.__latest_containers`, `global_variable.__latest_highlights`, `store.get("container_font_size")`, CSS animation tokens from `:root`
- Produces: `animateOp(containerName, op, requestRender) → Promise<void>`; `render(containerName) → ReactNode | null`

- [ ] **Step 1: Write animateOp tests**

Add to `gdbgui/src/js/tests/LinearPlugin.jest.ts`:

```typescript
// ── animateOp ─────────────────────────────────────────────────────────────────

const flushAll = async (iterations = 15) => {
    for (let i = 0; i < iterations; i++) {
        jest.runAllTimers();
        await Promise.resolve();
    }
};

describe('animateOp — insert', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        expect(ops).toHaveLength(1);
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('calls requestRender during animation', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const rr = jest.fn();
        const p = linearPlugin.animateOp('v', ops[0], rr);
        await flushAll();
        await p;
        expect(rr).toHaveBeenCalled();
    });
});

describe('animateOp — erase', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        expect(ops).toHaveLength(1);
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('removes ghost cell from display after animation', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1'] });
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await p;
        // Render should not crash and should handle the reduced cell count
    });
});

describe('animateOp — valueChange', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '9'] });
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });
});

describe('animateOp — swap', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '5', '3'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '3', '5'] });
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });
});

describe('animateOp — bulkChange', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: [] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2', '3'] });
        expect(ops[0].type).toBe('bulkChange');
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests to verify animateOp tests fail**

Run: `npx jest gdbgui/src/js/tests/LinearPlugin.jest.ts --no-coverage`
Expected: animateOp tests fail (stub returns immediately, requestRender never called)

- [ ] **Step 3: Implement animateOp in LinearPlugin.tsx**

Replace the `animateOp` stub in `LinearPlugin.tsx`:

```typescript
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
        const enterSet = this.entering.get(containerName);
        if (enterSet) enterSet.delete(payload.cellId);
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
```

- [ ] **Step 4: Run tests to verify animateOp tests pass**

Run: `npx jest gdbgui/src/js/tests/LinearPlugin.jest.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Implement render function in LinearPlugin.tsx**

Replace the `render` stub. This function reproduces the visual output of ContainerVisualizer's `renderContainerShape` for 1D linear containers, with animation state applied to each cell.

```tsx
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
```

- [ ] **Step 6: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests PASS (existing + new)

- [ ] **Step 7: Commit**

```bash
git add gdbgui/src/js/LinearPlugin.tsx gdbgui/src/js/tests/LinearPlugin.jest.ts
git commit -m "feat(anim): LinearPlugin animateOp + render"
```

---

### Task 3: MazePlugin + Tests

**Files:**
- Create: `gdbgui/src/js/MazePlugin.tsx`
- Create: `gdbgui/src/js/tests/MazePlugin.jest.ts`

**Interfaces:**
- Consumes: `PluginOp` from `AnimScheduler.ts`
- Produces: `mazePlugin` singleton with `diffOps(containerName, data) → PluginOp[]`, `animateOp(containerName, op, requestRender) → Promise<void>`, `render(containerName, values, colorRules, highlights?) → ReactNode`, `resetAll()`, `resetContainer(containerName)`

MazePlugin is **standalone** — it is NOT registered in the plugin registry because it's a view mode (maze mode toggle), not a container type. ContainerVisualizer uses it directly.

- [ ] **Step 1: Write MazePlugin.jest.ts**

Create `gdbgui/src/js/tests/MazePlugin.jest.ts`:

```typescript
import { mazePlugin } from '../MazePlugin';

beforeEach(() => {
    mazePlugin.resetAll();
});

describe('diffOps — first encounter', () => {
    it('first encounter returns []', () => {
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['0', '1'], ['1', '0']] });
        expect(ops).toEqual([]);
    });
});

describe('diffOps — cell changes', () => {
    it('single cell change returns one cellChange op', () => {
        mazePlugin.diffOps('m', { type: 'vector', values: [['0', '1'], ['1', '0']] });
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['0', '1'], ['1', '2']] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('cellChange');
        const p = ops[0].payload as any;
        expect(p.row).toBe(1);
        expect(p.col).toBe(1);
        expect(p.oldValue).toBe('0');
        expect(p.newValue).toBe('2');
    });

    it('multiple cell changes return multiple ops', () => {
        mazePlugin.diffOps('m', { type: 'vector', values: [['0', '0'], ['0', '0']] });
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['1', '0'], ['0', '1']] });
        expect(ops).toHaveLength(2);
        expect(ops.every(o => o.type === 'cellChange')).toBe(true);
    });

    it('identical data returns []', () => {
        mazePlugin.diffOps('m', { type: 'vector', values: [['0', '1']] });
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['0', '1']] });
        expect(ops).toEqual([]);
    });
});

describe('resetAll', () => {
    it('after resetAll, same data treated as first encounter', () => {
        mazePlugin.diffOps('m', { type: 'vector', values: [['0']] });
        mazePlugin.resetAll();
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['0']] });
        expect(ops).toEqual([]);
    });
});

describe('resetContainer', () => {
    it('clears only the named container', () => {
        mazePlugin.diffOps('m1', { type: 'vector', values: [['0']] });
        mazePlugin.diffOps('m2', { type: 'vector', values: [['1']] });
        mazePlugin.resetContainer('m1');
        // m1: reset → first encounter → []
        const ops1 = mazePlugin.diffOps('m1', { type: 'vector', values: [['0']] });
        expect(ops1).toEqual([]);
        // m2: same data → []
        const ops2 = mazePlugin.diffOps('m2', { type: 'vector', values: [['1']] });
        expect(ops2).toEqual([]);
    });
});

describe('animateOp', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        mazePlugin.diffOps('m', { type: 'vector', values: [['0']] });
        const ops = mazePlugin.diffOps('m', { type: 'vector', values: [['1']] });
        const p = mazePlugin.animateOp('m', ops[0], jest.fn());
        jest.runAllTimers();
        await Promise.resolve();
        await expect(p).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest gdbgui/src/js/tests/MazePlugin.jest.ts --no-coverage`
Expected: FAIL — `Cannot find module '../MazePlugin'`

- [ ] **Step 3: Write MazePlugin.tsx**

Create `gdbgui/src/js/MazePlugin.tsx`:

```tsx
import React from "react";
import { ContainerData } from "./ContainerPlugin";
import { PluginOp } from "./AnimScheduler";

type ColorRule = { value: string; color: string };
type HighlightEntry = { index: number; color: string };

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface CellChangePayload {
    row: number;
    col: number;
    oldValue: string;
    newValue: string;
}

class MazePluginImpl {
    private prevJson = new Map<string, string>();
    private history  = new Map<string, string[][]>();
    // Cells currently transitioning (for CSS transition)
    private transitioning = new Map<string, Set<string>>(); // "row,col"

    diffOps(containerName: string, data: ContainerData): PluginOp[] {
        const values = data.values as string[][];
        const json = JSON.stringify(values);
        if (json === this.prevJson.get(containerName)) return [];
        this.prevJson.set(containerName, json);

        const oldGrid = this.history.get(containerName);
        this.history.set(containerName, values.map(row => [...(row as any[])]));

        if (!oldGrid) return []; // first encounter — no animation

        const ops: PluginOp[] = [];
        const rows = Math.min(oldGrid.length, values.length);
        for (let r = 0; r < rows; r++) {
            const oldRow = oldGrid[r] as string[];
            const newRow = values[r] as string[];
            const cols = Math.min(oldRow.length, newRow.length);
            for (let c = 0; c < cols; c++) {
                if (String(oldRow[c]) !== String(newRow[c])) {
                    ops.push({
                        type: 'cellChange',
                        payload: { row: r, col: c, oldValue: String(oldRow[c]), newValue: String(newRow[c]) } as CellChangePayload,
                    });
                }
            }
        }

        return ops;
    }

    async animateOp(containerName: string, op: PluginOp, requestRender: () => void): Promise<void> {
        if (op.type !== 'cellChange') return;
        const p = op.payload as CellChangePayload;
        const key = `${p.row},${p.col}`;
        const set = this.transitioning.get(containerName) ?? new Set<string>();
        set.add(key);
        this.transitioning.set(containerName, set);
        requestRender();
        await delay(200);
        set.delete(key);
        requestRender();
    }

    render(
        containerName: string,
        values: any[][],
        colorRules: ColorRule[],
        highlights?: HighlightEntry[]
    ): React.ReactNode {
        const CELL = 20;
        const cols = values.length > 0 ? (values[0] as any[]).length : 0;

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

        const transSet = this.transitioning.get(containerName) ?? new Set<string>();

        return React.createElement('div', {
            style: { display: 'inline-block', border: '3px solid #444', lineHeight: 0, boxShadow: '2px 2px 8px rgba(0,0,0,0.35)' },
        },
            ...values.map((row: any[], rowIdx: number) =>
                React.createElement('div', { key: rowIdx, style: { display: 'flex' } },
                    ...(row as any[]).map((cell: any, colIdx: number) => {
                        const cellNum = parseInt(cell);
                        const mazeHL = mazePosMap.get(`${rowIdx},${colIdx}`);
                        const isTransitioning = transSet.has(`${rowIdx},${colIdx}`);
                        let bg: string;
                        if (mazeHL) bg = mazeHL;
                        else if (cellNum === 0) bg = '#f5f0e8';
                        else if (cellNum === 1) bg = '#2c2c2c';
                        else if (customColorMap.has(cellNum)) bg = customColorMap.get(cellNum)!;
                        else bg = '#888888';

                        return React.createElement('div', {
                            key: colIdx,
                            title: `[${rowIdx}][${colIdx}] = ${cell}`,
                            style: {
                                width: CELL, height: CELL, backgroundColor: bg,
                                boxSizing: 'border-box' as const,
                                border: cellNum === 1 ? 'none' : '1px solid rgba(180,160,120,0.25)',
                                transition: isTransitioning ? 'background-color 200ms ease' : 'none',
                            },
                        });
                    })
                )
            )
        );
    }

    resetAll(): void {
        this.prevJson.clear();
        this.history.clear();
        this.transitioning.clear();
    }

    resetContainer(containerName: string): void {
        this.prevJson.delete(containerName);
        this.history.delete(containerName);
        this.transitioning.delete(containerName);
    }
}

export const mazePlugin = new MazePluginImpl();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest gdbgui/src/js/tests/MazePlugin.jest.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add gdbgui/src/js/MazePlugin.tsx gdbgui/src/js/tests/MazePlugin.jest.ts
git commit -m "feat(anim): MazePlugin with cell-by-cell transitions"
```

---

### Task 4: Integration — Register Plugins, Refactor ContainerVisualizer, Update VisualizerHelper

**Files:**
- Modify: `gdbgui/src/js/ContainerVisualizer.tsx` (register plugins, delegate rendering, update \_pollContainers)
- Modify: `gdbgui/src/js/VisualizerHelper.js` (update \_eagerDiffOps to handle linear containers)

**Interfaces:**
- Consumes: `linearPlugin` from `LinearPlugin.tsx`, `mazePlugin` from `MazePlugin.tsx`, `getPlugin` + `registerPlugin` from `ContainerPlugin.ts`, `animScheduler` from `AnimScheduler.ts`
- Produces: Working integration — all containers animate on GDB step

- [ ] **Step 1: Register LinearPlugin in ContainerVisualizer.tsx**

At the top of `ContainerVisualizer.tsx`, add the import and registration:

```typescript
import { linearPlugin } from "./LinearPlugin";
import { mazePlugin } from "./MazePlugin";
```

After the existing `registerPlugin(bstPlugin)` line, add:

```typescript
registerPlugin(linearPlugin);
```

(MazePlugin is NOT registered — it's used directly.)

- [ ] **Step 2: Update `_pollContainers` to process all containers**

Replace the container-processing loop inside `_pollContainers` (the `for` loop that currently only processes `bstMode` containers). The new loop processes:
1. Maze mode 2D containers → MazePlugin
2. BST mode containers → BSTPlugin (via registry)
3. Linear containers → LinearPlugin (via registry)

```typescript
    _pollContainers() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers) { this.forceUpdate(); return; }

        if (store.get("inferior_program") === "running") {
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

        if (latestContainers.size > 0) {
            const registry = (window as any).gdbgui_collapser_registry || {};
            if (registry["container"]) registry["container"].open();
        }

        if (!hasOps) {
            this.forceUpdate();
        }
    }
```

- [ ] **Step 3: Update `renderContainerShape` to delegate rendering to plugins**

Replace the rendering logic inside `renderContainerShape`. Keep the card wrapper (name, type badge, size chip, toggles) unchanged. Replace the `switch(type)` body:

```typescript
    renderContainerShape(name: string, data: any, highlights: HighlightEntry[] | undefined) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        const isMazeMode = this.state.mazeMode.has(name);
        const isBSTMode  = this.state.bstMode.has(name);
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
```

- [ ] **Step 4: Remove the now-unused `renderMaze` method from ContainerVisualizer**

Delete the `renderMaze` method entirely — its logic has been migrated to `MazePlugin.render()`.

- [ ] **Step 5: Update `_eagerDiffOps` in VisualizerHelper.js**

In `gdbgui/src/js/VisualizerHelper.js`, replace the `_eagerDiffOps` function:

```javascript
function _eagerDiffOps(containerName, payload) {
  const plugin = getPlugin(payload.type);
  if (!plugin) return;
  // BST types need BST mode toggle to be on
  const bstTypes = new Set(['set', 'map', 'multiset', 'multimap']);
  if (bstTypes.has(payload.type)) {
    if (typeof window.gdbgui_is_bst_mode !== 'function') return;
    if (!window.gdbgui_is_bst_mode(containerName)) return;
  }
  const rr = () => window.gdbgui_request_render?.();
  const ops = plugin.diffOps(containerName, payload);
  if (ops.length > 0) {
    animScheduler.pushOps(containerName, ops, op => plugin.animateOp(containerName, op, rr));
  }
}
```

- [ ] **Step 6: Add MazePlugin reset on maze mode toggle off**

In ContainerVisualizer, update BOTH the `toggleMazeMode` method AND the `gdbgui_set_maze_mode` handler to reset MazePlugin when maze mode is toggled off.

Update `toggleMazeMode`:

```typescript
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
```

Update `gdbgui_set_maze_mode` in `componentDidMount`:

```typescript
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
```

- [ ] **Step 7: Run full test suite**

Run: `npx jest --no-coverage`
Expected: ALL tests PASS (existing 110 + new LinearPlugin + new MazePlugin)

- [ ] **Step 8: Verify data-testid attributes are preserved**

Search for `data-testid="container-cell"` in the rendered output — it should appear in both LinearPlugin.render and the fallback rendering for set/map.

Run: `grep -r 'data-testid.*container-cell' gdbgui/src/js/`
Expected: Found in `LinearPlugin.tsx` and `ContainerVisualizer.tsx` (fallback for set/map)

- [ ] **Step 9: Commit**

```bash
git add gdbgui/src/js/ContainerVisualizer.tsx gdbgui/src/js/VisualizerHelper.js
git commit -m "feat(anim): integrate LinearPlugin + MazePlugin into ContainerVisualizer"
```
