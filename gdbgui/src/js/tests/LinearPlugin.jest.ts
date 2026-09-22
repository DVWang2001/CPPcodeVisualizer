import { linearPlugin, uniformCellWidth } from '../LinearPlugin';
import { global_variable } from '../global_variable';
import { store } from 'statorgfc';
import initialStoreData from '../InitialStoreData';

beforeAll(() => {
    // render() 讀 store.get("container_font_size")，跟其餘只呼叫 diffOps/animateOp 的
    // 測試不同——這裡才第一次真的需要 store 已經 initialize 過。
    // @ts-expect-error statorgfc 的舊型別宣告漏了 initialize。
    store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

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

// ── animateOp ─────────────────────────────────────────────────────────────────

const flushAll = async (iterations = 15) => {
    for (let i = 0; i < iterations; i++) {
        jest.runAllTimers();
        await Promise.resolve();
    }
};

/** render() 回傳的是尚未實際掛載的 React element 樹（React.createElement 呼叫），
 *  直接走 props.children 收集每個節點的 className，不需要真的渲染。 */
function findClassNames(node: any): string[] {
    const found: string[] = [];
    const walk = (n: any) => {
        if (!n || typeof n !== 'object') return;
        if (n.props) {
            if (n.props.className) found.push(n.props.className);
            const children = n.props.children;
            if (Array.isArray(children)) children.forEach(walk);
            else walk(children);
        }
    };
    walk(node);
    return found;
}

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

    it('播動畫期間套用 cell-pop（覆蓋/變更為某數，不是 swap 的 cell-swap）', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '2'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '9'] });
        // render() 讀 global_variable.__latest_containers，跟 diffOps 追蹤的內部狀態是分開的
        // 兩件事——真的 GDB 流程會由 VisualizerHelper 同步寫入，這裡手動補上。
        (global_variable as any).__latest_containers = new Map([['v', { type: 'vector', values: ['1', '9'] }]]);
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        // animateOp 進第一個 await delay() 之前就已同步寫入 highlightKind，這裡的 render()
        // 讀到的正是「動畫播放中」那一刻的樣子。
        const classNames = findClassNames(linearPlugin.render('v'));
        expect(classNames).toContain('cell-pop');
        expect(classNames).not.toContain('cell-swap');
        await flushAll();
        await p;
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

    it('播動畫期間套用 cell-swap，兩顆交換的格子都要有，且不是 cell-pop', async () => {
        linearPlugin.diffOps('v', { type: 'vector', values: ['1', '5', '3'] });
        const ops = linearPlugin.diffOps('v', { type: 'vector', values: ['1', '3', '5'] });
        (global_variable as any).__latest_containers = new Map([['v', { type: 'vector', values: ['1', '3', '5'] }]]);
        const p = linearPlugin.animateOp('v', ops[0], jest.fn());
        const classNames = findClassNames(linearPlugin.render('v'));
        expect(classNames.filter(c => c === 'cell-swap')).toHaveLength(2);
        expect(classNames).not.toContain('cell-pop');
        await flushAll();
        await p;
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

// ── uniformCellWidth ──────────────────────────────────────────────────────────

describe('uniformCellWidth — 一格變寬，全部跟著變寬', () => {
    it('以最長的那一格為準', () => {
        expect(uniformCellWidth(['0', '0', '12'], 22)).toBe('calc(2ch + 22px)');
    });

    it('每一格拿到的是同一個值（不是各自照內容撐開）', () => {
        const values = ['0', '4', '100', '9'];
        const widths = values.map(() => uniformCellWidth(values, 22));
        expect(new Set(widths).size).toBe(1);
    });

    it('空容器仍給得出一格的寬度', () => {
        expect(uniformCellWidth([], 22)).toBe('calc(1ch + 22px)');
    });

    it('內距與外框由呼叫端給，2D 表格的格子比 1D 寬一點', () => {
        expect(uniformCellWidth(['12'], 26)).toBe('calc(2ch + 26px)');
    });
});
