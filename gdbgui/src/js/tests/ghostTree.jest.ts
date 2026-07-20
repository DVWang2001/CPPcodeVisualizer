import { buildGhostFromSnapshots } from "../ghostTree";
import type { Frame } from "../callTree";

const f = (func: string, addr: string, line: number): Frame => ({ func, addr, line, args: [] });

test("null/empty snapshots give null", () => {
    expect(buildGhostFromSnapshots(null)).toBeNull();
    expect(buildGhostFromSnapshots([])).toBeNull();
});

test("fib-like snapshots build the complete tree with positions per sig", () => {
    const main = f("main", "0x100", 16);
    const snaps: Frame[][] = [
        [main],
        [f("fib", "0xa1", 5), main],                          // fib(4) via site a1
        [f("fib", "0xa1", 5), f("fib", "0xa1", 11), main],    // 左子
        [f("fib", "0xa2", 5), f("fib", "0xa1", 11), main],    // 右子（同層不同呼叫點）
        [f("fib", "0xa2", 5), main],                          // fib(4) 的右子
    ];
    const g = buildGhostFromSnapshots(snaps)!;
    expect(g).not.toBeNull();
    expect(g.nodes.length).toBe(3); // main + fib + nested fib
    expect(g.posBySig.size).toBe(3);
    expect(g.width).toBeGreaterThan(0);
    // 每個節點的 sig 都有位置
    g.nodes.forEach(n => expect(g.posBySig.has(n.sig)).toBe(true));
});

test("malformed snapshot entries are skipped, not fatal", () => {
    const g = buildGhostFromSnapshots([[{ func: "main" } as any], "junk" as any]);
    expect(g === null || g.nodes.length >= 1).toBe(true);
});
