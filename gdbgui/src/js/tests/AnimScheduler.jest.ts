// AnimScheduler.jest.ts
// Tests for the animation scheduling / barrier system.
// These guard against "run button stuck" regressions caused by a barrier that
// never resolves, or by concurrent animations for the same container.

import { AnimScheduler } from '../AnimScheduler';
import type { PluginOp } from '../AnimScheduler';

// Alternately fires all pending fake timers and flushes the microtask queue.
// Needed because async/await interleaves setTimeout continuations with Promise
// microtasks; a single runAllTimers() call is not enough.
const flushAll = async (iterations = 15) => {
    for (let i = 0; i < iterations; i++) {
        jest.runAllTimers();
        await Promise.resolve();
    }
};

const op = (type: string): PluginOp => ({ type, payload: null });

describe('AnimScheduler', () => {
    let scheduler: AnimScheduler;

    beforeEach(() => {
        jest.useFakeTimers();
        (window as any).gdbgui_bst_anim_done = null;
        scheduler = new AnimScheduler();
    });

    afterEach(() => {
        (window as any).gdbgui_bst_anim_done = null;
        jest.useRealTimers();
    });

    // ── pushOps ────────────────────────────────────────────────────────────────

    describe('pushOps', () => {
        it('does nothing when ops array is empty', async () => {
            const animFn = jest.fn().mockResolvedValue(undefined);
            scheduler.pushOps('c', [], animFn);
            await flushAll();
            expect(animFn).not.toHaveBeenCalled();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('calls animFn with the correct op object', async () => {
            const animFn = jest.fn().mockResolvedValue(undefined);
            const myOp = op('insert');
            scheduler.pushOps('c', [myOp], animFn);
            await flushAll();
            expect(animFn).toHaveBeenCalledWith(myOp);
        });

        it('calls animFn for every op in the original order', async () => {
            const order: string[] = [];
            const animFn = jest.fn().mockImplementation(async (o: PluginOp) => {
                order.push(o.type);
            });
            scheduler.pushOps('c', [op('insert'), op('erase'), op('insert')], animFn);
            await flushAll();
            expect(order).toEqual(['insert', 'erase', 'insert']);
        });

        it('creates the barrier as soon as the first op is pushed', () => {
            expect(scheduler.isBarrierActive()).toBe(false);
            scheduler.pushOps('c', [op('a')], jest.fn().mockResolvedValue(undefined));
            expect(scheduler.isBarrierActive()).toBe(true);
        });

        it('resolves the barrier after all ops complete', async () => {
            scheduler.pushOps('c', [op('a'), op('b')], jest.fn().mockResolvedValue(undefined));
            await flushAll();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('marks the container as running while drain is in progress', async () => {
            let resolve!: () => void;
            const animFn = jest.fn().mockImplementation(
                () => new Promise<void>(r => { resolve = r; })
            );
            scheduler.pushOps('c', [op('a')], animFn);
            await Promise.resolve();
            expect(scheduler.isRunning('c')).toBe(true);
            resolve();
            await flushAll();
            expect(scheduler.isRunning('c')).toBe(false);
        });

        it('ops for the same container run serially, not concurrently', async () => {
            const started: string[] = [];
            let resolveFirst!: () => void;
            const animFn = jest.fn()
                .mockImplementationOnce(() => {
                    started.push('first');
                    return new Promise<void>(r => { resolveFirst = r; });
                })
                .mockImplementationOnce(async () => {
                    started.push('second');
                });

            scheduler.pushOps('c', [op('a'), op('b')], animFn);
            await Promise.resolve();
            // Only the first op should have started
            expect(started).toEqual(['first']);
            resolveFirst();
            await flushAll();
            expect(started).toEqual(['first', 'second']);
        });

        it('ops pushed while drain is running are queued and executed', async () => {
            const executed: string[] = [];
            let resolveFirst!: () => void;

            // Drain captures the first animFn; realistic callers always pass the
            // same plugin.animateOp wrapper per container.
            const animFn = jest.fn().mockImplementation(async (o: PluginOp) => {
                if (o.type === 'first') {
                    return new Promise<void>(r => { resolveFirst = r; });
                }
                executed.push(o.type);
            });

            scheduler.pushOps('c', [op('first')], animFn);
            await Promise.resolve();

            // Push a second batch while first is still running
            scheduler.pushOps('c', [op('second')], animFn);
            resolveFirst();
            await flushAll();
            expect(executed).toContain('second');
        });

        it('two different containers can animate concurrently', async () => {
            const started: string[] = [];
            let r1!: () => void, r2!: () => void;

            scheduler.pushOps('c1', [op('a')], jest.fn().mockImplementation(() => {
                started.push('c1');
                return new Promise<void>(r => { r1 = r; });
            }));
            scheduler.pushOps('c2', [op('b')], jest.fn().mockImplementation(() => {
                started.push('c2');
                return new Promise<void>(r => { r2 = r; });
            }));
            await Promise.resolve();
            // Both containers should have started without waiting for each other
            expect(started).toContain('c1');
            expect(started).toContain('c2');
            r1(); r2();
            await flushAll();
        });
    });

    // ── Barrier lifecycle ──────────────────────────────────────────────────────

    describe('barrier lifecycle', () => {
        it('reserveBarrier returns true and activates barrier when idle', () => {
            expect(scheduler.isBarrierActive()).toBe(false);
            const result = scheduler.reserveBarrier();
            expect(result).toBe(true);
            expect(scheduler.isBarrierActive()).toBe(true);
        });

        it('reserveBarrier returns false when barrier is already active (queue)', () => {
            scheduler.pushOps('c', [op('a')], jest.fn().mockResolvedValue(undefined));
            expect(scheduler.reserveBarrier()).toBe(false);
        });

        it('reserveBarrier returns false when already reserved prospectively', () => {
            scheduler.reserveBarrier();
            expect(scheduler.reserveBarrier()).toBe(false);
        });

        it('releaseBarrier resolves a prospective barrier', () => {
            scheduler.reserveBarrier();
            expect(scheduler.isBarrierActive()).toBe(true);
            scheduler.releaseBarrier();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('releaseBarrier has no effect on a queue-driven barrier', async () => {
            let resolve!: () => void;
            scheduler.pushOps('c', [op('a')], jest.fn().mockImplementation(
                () => new Promise<void>(r => { resolve = r; })
            ));
            scheduler.releaseBarrier(); // should be a no-op
            expect(scheduler.isBarrierActive()).toBe(true);
            resolve();
            await flushAll();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('barrier stays active until every concurrent container finishes', async () => {
            let r1!: () => void, r2!: () => void;
            scheduler.pushOps('c1', [op('a')], jest.fn().mockImplementation(
                () => new Promise<void>(r => { r1 = r; })
            ));
            scheduler.pushOps('c2', [op('b')], jest.fn().mockImplementation(
                () => new Promise<void>(r => { r2 = r; })
            ));

            r1();
            await flushAll(4);
            // c2 is still running; barrier must not resolve yet
            expect(scheduler.isBarrierActive()).toBe(true);

            r2();
            await flushAll();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('barrier is exposed as a Promise on window.gdbgui_bst_anim_done', () => {
            scheduler.reserveBarrier();
            expect((window as any).gdbgui_bst_anim_done).toBeInstanceOf(Promise);
        });

        it('barrier is null on window after it resolves', async () => {
            scheduler.reserveBarrier();
            scheduler.releaseBarrier();
            expect((window as any).gdbgui_bst_anim_done).toBeNull();
        });
    });

    // ── resetAll ───────────────────────────────────────────────────────────────

    describe('resetAll', () => {
        it('resolves and clears an active prospective barrier', () => {
            scheduler.reserveBarrier();
            expect(scheduler.isBarrierActive()).toBe(true);
            scheduler.resetAll();
            expect(scheduler.isBarrierActive()).toBe(false);
        });

        it('marks all previously running containers as stopped', async () => {
            let resolve!: () => void;
            scheduler.pushOps('c', [op('a')], jest.fn().mockImplementation(
                () => new Promise<void>(r => { resolve = r; })
            ));
            await Promise.resolve();
            expect(scheduler.isRunning('c')).toBe(true);
            scheduler.resetAll();
            expect(scheduler.isRunning('c')).toBe(false);
            resolve(); // avoid unhandled rejection
        });

        it('allows a new barrier to be reserved immediately after reset', () => {
            scheduler.reserveBarrier();
            scheduler.resetAll();
            expect(scheduler.reserveBarrier()).toBe(true);
        });
    });
});
