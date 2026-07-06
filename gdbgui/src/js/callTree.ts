/**
 * Call-tree reconstruction from GDB stack snapshots.
 *
 * GDB only hands us the *current* stack each time execution pauses, never
 * call/return events. We reconstruct a faithful call tree by giving every
 * invocation a stable identity derived from its call-site chain:
 *
 *   sig(bottom frame)  = func name              (e.g. "main")
 *   sig(frame i)       = sig(parent) + "|" + parent.addr + ":" + frame.func
 *
 * The parent frame's `addr` is the return address = the call site that created
 * this frame. It distinguishes sibling recursive calls made on the *same*
 * source line (e.g. `return fib(n-1) + fib(n-2);` — two different call
 * instructions, two different return addresses), which a line number cannot.
 * While stepping inside a child, the parent's addr is fixed, so identity is
 * stable across snapshots.
 *
 * Returned invocations are kept (marked `returned`), so the tree accumulates.
 */

export type Frame = {
    func: string;
    addr?: string;
    line?: string | number;
    args?: Array<{ name: string; value: any }>;
};

export type CallNode = {
    invId: number;
    sig: string;
    func: string;
    args: Array<{ name: string; value: any }>;
    line: string | number;
    parentInvId: number | null;
    returned: boolean;
};

export type CallEdge = { id: string; from: number; to: number };

export type CallTree = {
    bySig: Map<string, CallNode>;
    nextInvId: number;
};

export type IngestResult = {
    nodes: CallNode[];          // the persistent node objects (mutable, shared with the tree)
    edges: CallEdge[];
    activeNodeId: number | null;
    activePath: number[];       // live stack, root → top
};

export function createCallTree(): CallTree {
    return { bySig: new Map(), nextInvId: 1 };
}

/**
 * Fold one stack snapshot into the tree. `stack` is top-first (stack[0] is the
 * innermost/current frame, last element is the bottom/main).
 */
export function ingestStack(tree: CallTree, stack: Frame[]): IngestResult {
    const L = stack.length;
    if (L === 0) {
        return { nodes: [...tree.bySig.values()], edges: buildEdges(tree), activeNodeId: null, activePath: [] };
    }

    // Signatures, computed bottom-up so each frame can reference its parent's.
    const sigByIndex: string[] = new Array(L);
    for (let i = L - 1; i >= 0; i--) {
        if (i === L - 1) {
            sigByIndex[i] = String(stack[i].func);
        } else {
            const parent = stack[i + 1];
            const callSite = parent.addr ?? parent.line ?? "";
            sigByIndex[i] = `${sigByIndex[i + 1]}|${callSite}:${stack[i].func}`;
        }
    }

    // Upsert nodes bottom-up so a parent always exists before its child.
    const liveInvIds = new Set<number>();
    const pathBottomUp: number[] = []; // index L-1 (main) .. 0 (top)
    for (let i = L - 1; i >= 0; i--) {
        const sig = sigByIndex[i];
        const frame = stack[i];
        const parentSig = i < L - 1 ? sigByIndex[i + 1] : null;
        const parentInvId = parentSig ? tree.bySig.get(parentSig)!.invId : null;

        let node = tree.bySig.get(sig);
        if (!node) {
            node = {
                invId: tree.nextInvId++,
                sig,
                func: String(frame.func),
                args: frame.args ?? [],
                line: frame.line ?? "",
                parentInvId,
                returned: false,
            };
            tree.bySig.set(sig, node);
        } else {
            node.line = frame.line ?? node.line;
            if (frame.args && frame.args.length > 0) node.args = frame.args;
        }
        liveInvIds.add(node.invId);
        pathBottomUp[i] = node.invId;
    }

    // Any node not on the current stack has returned; live ones have not.
    for (const node of tree.bySig.values()) {
        node.returned = !liveInvIds.has(node.invId);
    }

    const activePath: number[] = [];
    for (let i = L - 1; i >= 0; i--) activePath.push(pathBottomUp[i]); // root → top

    return {
        nodes: [...tree.bySig.values()],
        edges: buildEdges(tree),
        activeNodeId: pathBottomUp[0],
        activePath,
    };
}

function buildEdges(tree: CallTree): CallEdge[] {
    const edges: CallEdge[] = [];
    for (const node of tree.bySig.values()) {
        if (node.parentInvId != null) {
            edges.push({ id: `${node.parentInvId}->${node.invId}`, from: node.parentInvId, to: node.invId });
        }
    }
    return edges;
}
