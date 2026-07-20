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

test("two children spread horizontally, parent centered", () => {
    const { placed } = layoutTree([n(1, null), n(2, 1), n(3, 1)]);
    const p = placed.find(q => q.invId === 1)!;
    const a = placed.find(q => q.invId === 2)!;
    const b = placed.find(q => q.invId === 3)!;
    expect(a.x).not.toBe(b.x);
    expect(p.x).toBeCloseTo((a.x + b.x) / 2, 5);
});
