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
