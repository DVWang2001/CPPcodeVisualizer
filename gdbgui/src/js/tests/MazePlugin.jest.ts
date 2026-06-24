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
