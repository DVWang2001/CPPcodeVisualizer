import { createCallTree, ingestStack } from "./callTree";
import type { CallNode, Frame } from "./callTree";
import { layoutTree } from "./callGraphLayout";

export type Ghost = {
    posBySig: Map<string, { x: number; y: number }>;
    nodes: CallNode[];        // 完整幽靈樹節點（含 sig/parentInvId）
    edges: { from: number; to: number; id: string }[];
    width: number;
    height: number;
};

export function buildGhostFromSnapshots(snapshots: Frame[][] | null | undefined): Ghost | null {
    if (!snapshots || !Array.isArray(snapshots) || snapshots.length === 0) return null;
    const tree = createCallTree();
    let last: ReturnType<typeof ingestStack> | null = null;
    for (const snap of snapshots) {
        if (!Array.isArray(snap) || snap.length === 0) continue;
        try { last = ingestStack(tree, snap); } catch { /* skip malformed */ }
    }
    if (!last || tree.bySig.size === 0) return null;
    const nodes = [...tree.bySig.values()];
    const { placed, width, height } = layoutTree(nodes);
    const posBySig = new Map<string, { x: number; y: number }>();
    placed.forEach(p => posBySig.set(p.sig, { x: p.x, y: p.y }));
    const edges = last.edges;
    return { posBySig, nodes, edges, width, height };
}
