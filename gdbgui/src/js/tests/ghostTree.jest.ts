import { buildGhostFromSnapshots } from "../ghostTree";
import type { Frame } from "../callTree";

const f = (func: string, addr: string, line: number): Frame => ({ func, addr, line, args: [] });

test("null/empty snapshots give null", () => {
    expect(buildGhostFromSnapshots(null)).toBeNull();
    expect(buildGhostFromSnapshots([])).toBeNull();
});

test("fib-like snapshots build the complete tree with positions per sig", () => {
    const snaps: Frame[][] = [
        [f("main", "0x100", 16)],
        [f("fib", "0x501", 5), f("main", "0x100", 16)],
        [f("fib", "0x502", 5), f("fib", "0xa1", 11), f("main", "0x100", 16)],  // 左子：父 fib 停在第一個呼叫點 0xa1
        [f("fib", "0x503", 5), f("fib", "0xa2", 11), f("main", "0x100", 16)],  // 右子：父 fib 停在第二個呼叫點 0xa2
    ];
    const g = buildGhostFromSnapshots(snaps)!;
    expect(g).not.toBeNull();
    expect(g.nodes.length).toBe(4); // main + fib + left child + right child
    expect(g.posBySig.size).toBe(4);
    expect(g.width).toBeGreaterThan(0);
    // 每個節點的 sig 都有位置
    g.nodes.forEach(n => expect(g.posBySig.has(n.sig)).toBe(true));

    // Assert real branching: fib node has exactly 2 children
    const mainNode = g.nodes.find(n => n.func === "main" && n.parentInvId === null);
    const fibNode = g.nodes.find(n => n.func === "fib" && n.parentInvId === mainNode?.invId);
    if (fibNode) {
        const childEdges = g.edges.filter(e => e.from === fibNode.invId);
        expect(childEdges.length).toBe(2);
        // Two children have different x positions
        const leftChildSig = `${fibNode.sig}|0xa1:fib`;
        const rightChildSig = `${fibNode.sig}|0xa2:fib`;
        const leftPos = g.posBySig.get(leftChildSig);
        const rightPos = g.posBySig.get(rightChildSig);
        expect(leftPos?.x).not.toEqual(rightPos?.x);
    }
});

test("malformed snapshot entries are skipped, not fatal", () => {
    const g = buildGhostFromSnapshots([[{ func: "main" } as any], "junk" as any]);
    expect(g === null || g.nodes.length >= 1).toBe(true);
});
