import type { CallNode } from "./callTree";

// Layout constants (small teaching trees, ≤ ~30 nodes).
export const NODE_W = 150;
export const NODE_H = 50;
export const GAP_X = 28;
export const GAP_Y = 46;
export const COL = NODE_W + GAP_X;
export const ROW = NODE_H + GAP_Y;
export const PAD = 16;

export type Placed = CallNode & { x: number; y: number };

export function layoutTree(nodes: CallNode[]): { placed: Placed[]; width: number; height: number } {
    if (nodes.length === 0) return { placed: [], width: 0, height: 0 };

    const byId = new Map<number, CallNode>(nodes.map(n => [n.invId, n]));
    const children = new Map<number, number[]>();
    const roots: number[] = [];
    for (const n of nodes) {
        if (n.parentInvId != null && byId.has(n.parentInvId)) {
            if (!children.has(n.parentInvId)) children.set(n.parentInvId, []);
            children.get(n.parentInvId)!.push(n.invId);
        } else {
            roots.push(n.invId);
        }
    }

    const depth = new Map<number, number>();
    const xSlot = new Map<number, number>();
    let nextLeaf = 0;
    const walk = (id: number, d: number) => {
        depth.set(id, d);
        const kids = children.get(id) ?? [];
        if (kids.length === 0) {
            xSlot.set(id, nextLeaf++);
        } else {
            kids.forEach(k => walk(k, d + 1));
            // Centered (textbook) layout: parent sits above the midpoint of its
            // children — the balanced, symmetric look. This shifts as later
            // siblings appear; stability comes from the ghost pre-run (F7), which
            // computes these final positions from the complete tree up front.
            xSlot.set(id, (xSlot.get(kids[0])! + xSlot.get(kids[kids.length - 1])!) / 2);
        }
    };
    roots.forEach(r => walk(r, 0));

    const placed: Placed[] = nodes.map(n => ({
        ...n,
        x: PAD + xSlot.get(n.invId)! * COL,
        y: PAD + depth.get(n.invId)! * ROW,
    }));
    const maxDepth = Math.max(...Array.from(depth.values()));
    const width = PAD * 2 + (nextLeaf > 0 ? nextLeaf - 1 : 0) * COL + NODE_W;
    const height = PAD * 2 + maxDepth * ROW + NODE_H;
    return { placed, width, height };
}
