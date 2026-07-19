import { createCallTree, ingestStack, Frame, recordResultLocal, resolveSelectedInvId } from "../callTree";

// Stacks are top-first: stack[0] = innermost frame, last = main.
const f = (func: string, addr: string, line: number, args: any[] = []): Frame => ({ func, addr, line, args });

describe("ingestStack — single frame", () => {
    it("one frame produces one root node, no edges, active = that frame", () => {
        const t = createCallTree();
        const r = ingestStack(t, [f("main", "M", 10)]);
        expect(r.nodes).toHaveLength(1);
        expect(r.edges).toHaveLength(0);
        expect(r.nodes[0].parentInvId).toBeNull();
        expect(r.activeNodeId).toBe(r.nodes[0].invId);
        expect(r.activePath).toEqual([r.nodes[0].invId]);
        expect(r.nodes[0].returned).toBe(false);
    });
});

describe("ingestStack — linear recursion (factorial)", () => {
    it("each recursion level is a distinct node forming a chain", () => {
        const t = createCallTree();
        ingestStack(t, [f("fact", "F", 5), f("main", "M", 10)]);
        ingestStack(t, [f("fact", "F", 5), f("fact", "F", 5), f("main", "M", 10)]);
        const r = ingestStack(t, [f("fact", "F", 5), f("fact", "F", 5), f("fact", "F", 5), f("main", "M", 10)]);

        // main + 3 distinct fact invocations
        expect(r.nodes).toHaveLength(4);
        const facts = r.nodes.filter(n => n.func === "fact");
        expect(facts).toHaveLength(3);
        // chain: every fact has exactly one parent, each parent distinct
        expect(r.edges).toHaveLength(3);
        expect(r.activePath).toHaveLength(4); // main -> fact -> fact -> fact
        expect(r.nodes.every(n => !n.returned)).toBe(true);
    });

    it("marks deeper frames returned as the stack unwinds, keeping them in the tree", () => {
        const t = createCallTree();
        ingestStack(t, [f("fact", "F", 5), f("fact", "F", 5), f("main", "M", 10)]);
        const r = ingestStack(t, [f("fact", "F", 5), f("main", "M", 10)]); // one level returned

        expect(r.nodes).toHaveLength(3); // nothing deleted
        const returned = r.nodes.filter(n => n.returned);
        expect(returned).toHaveLength(1);
        expect(returned[0].func).toBe("fact");
        expect(r.activePath).toHaveLength(2); // back to main -> fact
    });
});

describe("ingestStack — tree recursion (fibonacci)", () => {
    // fib has two call sites: left 'L' (fib(n-1)), right 'R' (fib(n-2)).
    it("builds a real branching tree; a node can have two children", () => {
        const t = createCallTree();
        // main -> fib3
        ingestStack(t, [f("fib", "FibBody", 3), f("main", "M", 12)]);
        // fib3 -> fib2 (left)
        ingestStack(t, [f("fib", "FibBody", 3), f("fib", "L", 4), f("main", "M", 12)]);
        // fib2 -> fib1 (left)
        ingestStack(t, [f("fib", "FibBody", 3), f("fib", "L", 4), f("fib", "L", 4), f("main", "M", 12)]);
        // fib1 returns, fib2 -> fib0 (right)
        ingestStack(t, [f("fib", "FibBody", 3), f("fib", "R", 4), f("fib", "L", 4), f("main", "M", 12)]);
        // unwind to fib3, fib3 -> fib1b (right)
        const r = ingestStack(t, [f("fib", "FibBody", 3), f("fib", "R", 4), f("main", "M", 12)]);

        // main, fib3, fib2, fib1(LL), fib0(LR), fib1b(R) = 6 distinct invocations
        expect(r.nodes).toHaveLength(6);

        const childrenOf = (invId: number) => r.edges.filter(e => e.from === invId).map(e => e.to);
        const main = r.nodes.find(n => n.func === "main")!;
        const fib3 = r.nodes.find(n => n.parentInvId === main.invId)!;
        expect(childrenOf(fib3.invId)).toHaveLength(2); // fib3 branches into two subcalls

        const fib2 = r.nodes.find(n => n.parentInvId === fib3.invId && r.edges.filter(e => e.from === n.invId).length === 2);
        expect(fib2).toBeDefined(); // fib2 also branches into two

        // current live path is main -> fib3 -> fib1b
        expect(r.activePath).toHaveLength(3);
        expect(r.activeNodeId).toBe(r.activePath[2]);
        // returned subtree (fib2 and its children) is retained
        expect(r.nodes.filter(n => n.returned).length).toBe(3);
    });

    it("distinguishes sibling calls made on the same source line via addr", () => {
        const t = createCallTree();
        // two calls to g from f on the SAME line 7 but different call instructions
        ingestStack(t, [f("g", "G", 9), f("f", "callA", 7), f("main", "M", 1)]);
        const r = ingestStack(t, [f("g", "G", 9), f("f", "callB", 7), f("main", "M", 1)]);

        const gs = r.nodes.filter(n => n.func === "g");
        expect(gs).toHaveLength(2); // not merged, despite same func + same line
    });
});

describe("ingestStack — edges", () => {
    it("are deduped and reference parent/child invIds", () => {
        const t = createCallTree();
        ingestStack(t, [f("a", "A", 2), f("main", "M", 1)]);
        const r = ingestStack(t, [f("a", "A", 2), f("main", "M", 1)]); // identical snapshot again
        expect(r.edges).toHaveLength(1);
        expect(r.edges[0].from).toBe(r.nodes.find(n => n.func === "main")!.invId);
        expect(r.edges[0].to).toBe(r.nodes.find(n => n.func === "a")!.invId);
    });
});

describe("return values — recordResultLocal + retValue", () => {
  const f = (func: string, addr: string, line: number, args: Frame["args"] = []): Frame =>
    ({ func, addr, line, args });

  test("cached result is stamped as retValue when the node returns", () => {
    const tree = createCallTree();
    ingestStack(tree, [f("sum", "0x2", 12, [{ name: "n", value: "2" }]), f("main", "0x1", 20)]);
    const r1 = ingestStack(tree, [f("sum", "0x2", 13, [{ name: "n", value: "2" }]), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "result", value: "3" }]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]);
    const sum = r2.nodes.find(n => n.func === "sum")!;
    expect(sum.returned).toBe(true);
    expect(sum.retValue).toBe("3");
    expect(r2.justReturned).toEqual([sum.invId]);
  });

  test("no `result` local → retValue stays undefined, node just dims", () => {
    const tree = createCallTree();
    const r1 = ingestStack(tree, [f("g", "0x2", 5), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "x", value: "9" }]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]);
    const g = r2.nodes.find(n => n.func === "g")!;
    expect(g.returned).toBe(true);
    expect(g.retValue).toBeUndefined();
  });

  test("justReturned lists only nodes flipped in this snapshot", () => {
    const tree = createCallTree();
    ingestStack(tree, [f("a", "0x2", 5), f("main", "0x1", 20)]);
    const r2 = ingestStack(tree, [f("main", "0x1", 20)]); // a returns
    expect(r2.justReturned.length).toBe(1);
    const r3 = ingestStack(tree, [f("main", "0x1", 21)]); // nothing new returns
    expect(r3.justReturned).toEqual([]);
  });

  test("recordResultLocal tolerates null/unknown invId", () => {
    const tree = createCallTree();
    expect(() => recordResultLocal(tree, null, [{ name: "result", value: "1" }])).not.toThrow();
    expect(() => recordResultLocal(tree, 999, [{ name: "result", value: "1" }])).not.toThrow();
  });

  test("re-activated same-sig node (loop call) clears stale retValue", () => {
    const tree = createCallTree();
    const r1 = ingestStack(tree, [f("h", "0x2", 5), f("main", "0x1", 20)]);
    recordResultLocal(tree, r1.activeNodeId, [{ name: "result", value: "7" }]);
    ingestStack(tree, [f("main", "0x1", 20)]);           // h returns, retValue=7
    const r3 = ingestStack(tree, [f("h", "0x2", 5), f("main", "0x1", 20)]); // same call site again
    const h = r3.nodes.find(n => n.func === "h")!;
    expect(h.returned).toBe(false);
    expect(h.retValue).toBeUndefined();
  });
});

describe("resolveSelectedInvId", () => {
  test("frame 0 (top) maps to last element of activePath", () => {
    expect(resolveSelectedInvId([1, 2, 3], 0)).toBe(3);
  });
  test("deeper selected frame walks toward the root", () => {
    expect(resolveSelectedInvId([1, 2, 3], 2)).toBe(1);
  });
  test("empty path or out-of-range returns null", () => {
    expect(resolveSelectedInvId([], 0)).toBeNull();
    expect(resolveSelectedInvId([1], 5)).toBeNull();
  });
});
