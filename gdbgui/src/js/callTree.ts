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
    lastResult?: string;   // result 變數的最新緩存（活著時持續覆寫）
    retValue?: string;     // 返回瞬間定格的回傳值
    callSiteLine?: string | number;  // 父 frame 建立當下停駐的行 = 呼叫行
    callSiteAddr?: string;           // 呼叫指令的返回位址（同行多呼叫的排序鍵）
};

/** MI 給零填充位址、gdb Python 給短 hex — 身分計算前先正規化。 */
export function normalizeAddr(addr?: string): string | undefined {
    if (!addr) return undefined;
    const a = String(addr).toLowerCase();
    return a.startsWith("0x") ? "0x" + (a.slice(2).replace(/^0+/, "") || "0") : a;
}

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
    justReturned: number[];     // invIds that flipped to returned in this snapshot
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
        return { nodes: [...tree.bySig.values()], edges: buildEdges(tree), activeNodeId: null, activePath: [], justReturned: [] };
    }

    // Signatures, computed bottom-up so each frame can reference its parent's.
    const sigByIndex: string[] = new Array(L);
    for (let i = L - 1; i >= 0; i--) {
        if (i === L - 1) {
            sigByIndex[i] = String(stack[i].func);
        } else {
            const parent = stack[i + 1];
            const callSite = normalizeAddr(parent.addr) ?? parent.line ?? "";
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
                callSiteLine: i < L - 1 ? stack[i + 1].line : undefined,
                callSiteAddr: i < L - 1 ? stack[i + 1].addr : undefined,
            };
            tree.bySig.set(sig, node);
        } else {
            if (node.returned) {
                // Same call site invoked again (loop) — stale value must not leak.
                node.retValue = undefined;
                node.lastResult = undefined;
            }
            node.line = frame.line ?? node.line;
            if (frame.args && frame.args.length > 0) node.args = frame.args;
        }
        liveInvIds.add(node.invId);
        pathBottomUp[i] = node.invId;
    }

    // Any node not on the current stack has returned; live ones have not.
    const justReturned: number[] = [];
    for (const node of tree.bySig.values()) {
        const nowReturned = !liveInvIds.has(node.invId);
        if (nowReturned && !node.returned) {
            node.retValue = node.lastResult;
            justReturned.push(node.invId);
        }
        node.returned = nowReturned;
    }

    const activePath: number[] = [];
    for (let i = L - 1; i >= 0; i--) activePath.push(pathBottomUp[i]); // root → top

    return {
        nodes: [...tree.bySig.values()],
        edges: buildEdges(tree),
        activeNodeId: pathBottomUp[0],
        activePath,
        justReturned,
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

/**
 * Cache the teaching-convention `result` local onto one invocation. Called
 * whenever fresh locals arrive; the value is frozen into `retValue` at the
 * moment the invocation returns (see ingestStack).
 */
export function recordResultLocal(
    tree: CallTree,
    invId: number | null,
    locals: Array<{ name: string; value: any }>
): void {
    if (invId == null || !locals) return;
    const local = locals.find(l => l.name === "result");
    if (!local) return;
    for (const node of tree.bySig.values()) {
        if (node.invId === invId) {
            // A frozen (returned) invocation must never be overwritten by locals
            // from a later pause — those belong to whatever frame is now active
            // at this call site, not the invocation that already returned. If the
            // same call site is re-entered (a loop), ingestStack flips `returned`
            // back to false first, so this guard does not block legitimate updates.
            if (node.returned) return;
            node.lastResult = String(local.value);
            return;
        }
    }
}

/** Map gdbgui's selected_frame_num (0 = top) onto the activePath (root → top). */
export function resolveSelectedInvId(
    activePath: number[],
    selectedFrameNum: number
): number | null {
    if (!activePath || activePath.length === 0) return null;
    const idx = activePath.length - 1 - (selectedFrameNum || 0);
    return idx >= 0 && idx < activePath.length ? activePath[idx] : null;
}
