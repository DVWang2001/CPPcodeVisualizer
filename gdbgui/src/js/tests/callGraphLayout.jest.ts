import { layoutTree } from "../callGraphLayout";
import type { CallNode } from "../callTree";

const n = (invId: number, parentInvId: number | null): CallNode =>
    ({ invId, sig: String(invId), func: "f", args: [], line: "", parentInvId, returned: false });

test("linear chain lays out as one vertical column", () => {
    const { placed } = layoutTree([n(1, null), n(2, 1), n(3, 2)]);
    const xs = new Set(placed.map(p => p.x));
    expect(xs.size).toBe(1);
    expect(placed[0].y).toBeLessThan(placed[2].y);
});

test("two children spread horizontally, parent aligns over the FIRST child", () => {
    const { placed } = layoutTree([n(1, null), n(2, 1), n(3, 1)]);
    const p = placed.find(q => q.invId === 1)!;
    const a = placed.find(q => q.invId === 2)!; // first-called child (kids[0])
    const b = placed.find(q => q.invId === 3)!; // later sibling
    expect(a.x).not.toBe(b.x);
    expect(p.x).toBe(a.x);       // left-anchored, not centered between a and b
    expect(b.x).toBeGreaterThan(a.x); // later siblings fan out to the right
});

test("a later-appearing sibling never shifts already-placed nodes (the whole point of left-anchoring)", () => {
    // Tree grows incrementally the way live recursion does: first only the
    // left spine exists, then a second child of the root appears.
    const before = layoutTree([n(1, null), n(2, 1), n(3, 2)]).placed; // 1 -> 2 -> 3 (left spine)
    const after = layoutTree([n(1, null), n(2, 1), n(3, 2), n(4, 1)]).placed; // root gets a 2nd child
    const posBefore = new Map(before.map(p => [p.invId, { x: p.x, y: p.y }]));
    after.forEach(p => {
        const prior = posBefore.get(p.invId);
        if (prior) expect(p).toMatchObject(prior); // every pre-existing node: identical x/y
    });
});
