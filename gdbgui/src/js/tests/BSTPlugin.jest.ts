// BSTPlugin.jest.ts
// Tests for BST diff logic, animation lifecycle, and state reset.
// Guards against wrong animation sequences (e.g. "empty,empty,{3,6}" instead of
// "empty,{3},{3,6}") and against state leaking across program runs.

import { bstPlugin } from '../BSTPlugin';
import { global_variable } from '../global_variable';

// Shorthand to read the live BST history from global state.
const bstHistory = (): Record<string, Array<{ id: string; key: string; label: string }>> =>
    (global_variable as any).__bst_history || {};

// Advance all pending fake timers and flush the microtask queue, interleaved.
// Necessary because async animations combine setTimeout and Promise microtasks.
const flushAll = async (iterations = 15) => {
    for (let i = 0; i < iterations; i++) {
        jest.runAllTimers();
        await Promise.resolve();
    }
};

beforeEach(() => {
    bstPlugin.resetAll();
    (window as any).gdbgui_bst_anim_done = null;
});

// ── diffOps: first encounter ───────────────────────────────────────────────────

describe('diffOps — first encounter', () => {
    it('empty set returns [] (shows "empty" label)', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });
        expect(ops).toEqual([]);
    });

    it('empty set still initialises bstHistory to an empty array', () => {
        bstPlugin.diffOps('s', { type: 'set', values: [] });
        expect(bstHistory()['s']).toEqual([]);
    });

    it('single element returns one insert op', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('insert');
    });

    it('single element insert payload has correct key and label', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const p = ops[0].payload as any;
        expect(p.entry.key).toBe('3');
        expect(p.entry.label).toBe('3');
    });

    it('single (root) element has an empty compPath', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect((ops[0].payload as any).compPath).toEqual([]);
    });

    it('two elements return two insert ops', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        expect(ops).toHaveLength(2);
        expect(ops[0].type).toBe('insert');
        expect(ops[1].type).toBe('insert');
    });

    it('second element compPath passes through the root node', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        const rootId = (ops[0].payload as any).entry.id;
        const secondPath: string[] = (ops[1].payload as any).compPath;
        // '6' > '3' so traversal visits root ('3') then falls off right
        expect(secondPath).toContain(rootId);
    });

    it('three elements produce three insert ops with correct keys', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6', '1'] });
        const keys = ops.map(o => (o.payload as any).entry.key);
        expect(keys).toContain('3');
        expect(keys).toContain('6');
        expect(keys).toContain('1');
    });

    it('all elements appear in bstHistory after first encounter', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3', '6', '1'] });
        const hist = bstHistory()['s'];
        expect(hist).toHaveLength(3);
        const keys = hist.map(e => e.key);
        expect(keys).toContain('3');
        expect(keys).toContain('6');
        expect(keys).toContain('1');
    });

    it('new nodes are pre-hidden (op is returned, not silently swallowed)', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        // hiddenIds state is private; we verify indirectly: ops are returned,
        // meaning the plugin will animate them in from hidden state.
        expect(ops.every(o => o.type === 'insert')).toBe(true);
    });

    it('map type: label is "key→value"', () => {
        const ops = bstPlugin.diffOps('m', {
            type: 'map',
            values: [{ key: '1', value: 'apple' }],
        });
        expect((ops[0].payload as any).entry.label).toBe('1→apple');
    });

    it('map type: key field is just the key string', () => {
        const ops = bstPlugin.diffOps('m', {
            type: 'map',
            values: [{ key: '5', value: 'hello' }],
        });
        expect((ops[0].payload as any).entry.key).toBe('5');
    });
});

// ── diffOps: subsequent calls ──────────────────────────────────────────────────

describe('diffOps — subsequent calls', () => {
    beforeEach(() => {
        // Start with '3' already in history via empty + insert path
        bstPlugin.diffOps('s', { type: 'set', values: [] });
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
    });

    it('identical data returns [] (no spurious ops)', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(ops).toEqual([]);
    });

    it('insert new element returns one insert op with correct key', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('insert');
        expect((ops[0].payload as any).entry.key).toBe('6');
    });

    it('insert adds element to bstHistory', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        const keys = bstHistory()['s'].map(e => e.key);
        expect(keys).toContain('3');
        expect(keys).toContain('6');
    });

    it('erase returns one erase op with the removed key', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('erase');
        expect((ops[0].payload as any).entry.key).toBe('3');
    });

    it('erase compPath visits the node being deleted', () => {
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });
        const entry = (ops[0].payload as any).entry;
        const compPath: string[] = (ops[0].payload as any).compPath;
        expect(compPath).toContain(entry.id);
    });

    it('separate containers are tracked independently', () => {
        bstPlugin.diffOps('s2', { type: 'set', values: ['9'] });
        // 's' still only has '3'; inserting '6' should produce one op
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        expect(ops).toHaveLength(1);
        expect((ops[0].payload as any).entry.key).toBe('6');
    });
});

// ── diffOps: idempotency ───────────────────────────────────────────────────────

describe('diffOps — idempotency', () => {
    it('calling diffOps twice with the same non-empty data returns [] on the second call', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        expect(bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] })).toEqual([]);
    });

    it('empty → insert → erase sequence each return the expected op type', () => {
        bstPlugin.diffOps('s', { type: 'set', values: [] });

        const insertOps = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(insertOps).toHaveLength(1);
        expect(insertOps[0].type).toBe('insert');

        const eraseOps = bstPlugin.diffOps('s', { type: 'set', values: [] });
        expect(eraseOps).toHaveLength(1);
        expect(eraseOps[0].type).toBe('erase');
    });
});

// ── animateOp: insert ──────────────────────────────────────────────────────────

describe('animateOp — insert', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging (empty compPath)', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: [] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(ops).toHaveLength(1);

        const p = bstPlugin.animateOp('s', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('resolves without hanging (non-empty compPath)', async () => {
        // '3' already in history; '6' traverses root before inserting
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        expect(ops).toHaveLength(1);

        const p = bstPlugin.animateOp('s', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('calls requestRender at least once during insert animation', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: [] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const requestRender = jest.fn();

        const p = bstPlugin.animateOp('s', ops[0], requestRender);
        await flushAll();
        await p;
        expect(requestRender).toHaveBeenCalled();
    });

    it('calls requestRender multiple times (compare + reveal phases)', async () => {
        // Insert '6' after '3' exists → 1-node compare path + reveal
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        const requestRender = jest.fn();

        const p = bstPlugin.animateOp('s', ops[0], requestRender);
        await flushAll();
        await p;
        expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});

// ── animateOp: erase ──────────────────────────────────────────────────────────

describe('animateOp — erase', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves without hanging', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });
        expect(ops).toHaveLength(1);

        const p = bstPlugin.animateOp('s', ops[0], jest.fn());
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('removes the erased element from bstHistory after animation completes', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });

        const p = bstPlugin.animateOp('s', ops[0], jest.fn());
        await flushAll();
        await p;
        expect(bstHistory()['s']).toHaveLength(0);
    });

    it('calls requestRender at least once during erase animation', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const ops = bstPlugin.diffOps('s', { type: 'set', values: [] });
        const requestRender = jest.fn();

        const p = bstPlugin.animateOp('s', ops[0], requestRender);
        await flushAll();
        await p;
        expect(requestRender).toHaveBeenCalled();
    });
});

// ── prospectiveOp ─────────────────────────────────────────────────────────────

describe('prospectiveOp', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('returns null when the container has no history yet', () => {
        expect(bstPlugin.prospectiveOp('s', 'find', '3', jest.fn())).toBeNull();
    });

    it('returns null for an unrecognised opType', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(bstPlugin.prospectiveOp('s', 'unknownOp', '3', jest.fn())).toBeNull();
    });

    it('find returns a Promise that resolves without hanging', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        const p = bstPlugin.prospectiveOp('s', 'find', '6', jest.fn());
        expect(p).toBeInstanceOf(Promise);
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('dupInsert returns a Promise that resolves without hanging', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        const p = bstPlugin.prospectiveOp('s', 'dupInsert', '3', jest.fn());
        expect(p).toBeInstanceOf(Promise);
        await flushAll();
        await expect(p).resolves.toBeUndefined();
    });

    it('find calls requestRender during the compare-path animation', async () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3', '6'] });
        const requestRender = jest.fn();
        const p = bstPlugin.prospectiveOp('s', 'find', '6', requestRender);
        await flushAll();
        await p;
        expect(requestRender).toHaveBeenCalled();
    });
});

// ── resetAll ───────────────────────────────────────────────────────────────────

describe('resetAll', () => {
    it('clears __bst_history for every container', () => {
        bstPlugin.diffOps('s1', { type: 'set', values: ['3'] });
        bstPlugin.diffOps('s2', { type: 'set', values: ['6'] });
        bstPlugin.resetAll();
        expect((global_variable as any).__bst_history).toEqual({});
    });

    it('clears __bst_prev_json so stale snapshots are gone', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        bstPlugin.resetAll();
        expect((global_variable as any).__bst_prev_json).toEqual({});
    });

    it('after resetAll the same data is treated as first encounter again', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        bstPlugin.resetAll();
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        // Should produce an insert op (first encounter), not [] (no-change)
        expect(ops).toHaveLength(1);
        expect(ops[0].type).toBe('insert');
    });
});

// ── resetContainer ─────────────────────────────────────────────────────────────

describe('resetContainer', () => {
    it('clears only the named container, leaving others intact', () => {
        bstPlugin.diffOps('s1', { type: 'set', values: ['3'] });
        bstPlugin.diffOps('s2', { type: 'set', values: ['6'] });
        bstPlugin.resetContainer('s1');
        expect(bstHistory()['s1']).toBeUndefined();
        expect(bstHistory()['s2']).toHaveLength(1);
    });

    it('after resetContainer the same data triggers ops again for that container', () => {
        bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        bstPlugin.resetContainer('s');
        const ops = bstPlugin.diffOps('s', { type: 'set', values: ['3'] });
        expect(ops).toHaveLength(1);
    });

    it('sibling container still returns [] for unchanged data after sibling reset', () => {
        bstPlugin.diffOps('s1', { type: 'set', values: ['3'] });
        bstPlugin.diffOps('s2', { type: 'set', values: ['6'] });
        bstPlugin.resetContainer('s1');
        // s2 history is intact; same data should return []
        expect(bstPlugin.diffOps('s2', { type: 'set', values: ['6'] })).toEqual([]);
    });
});
