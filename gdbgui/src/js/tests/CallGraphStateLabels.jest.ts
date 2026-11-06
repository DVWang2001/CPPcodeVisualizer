import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { store } from "statorgfc";
import CallGraph from "../CallGraph";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize(
    { call_graph_updated: 0, locals: [], paused_on_frame: null, expressions: [] },
    { immutable: false, debounce_ms: 0 }
  );
});

const node = (invId: number, parentInvId: number | null, extra: any = {}) => ({
  invId,
  sig: `s${invId}`,
  func: "f",
  args: [{ name: "n", value: String(invId) }],
  line: 5,
  parentInvId,
  returned: false,
  ...extra
});

function mount(opts: {
  path: number[];
  active: number;
  nodes: any[];
  ghost?: boolean;
}): HTMLDivElement {
  const edges = opts.nodes
    .filter(n => n.parentInvId != null)
    .map(n => ({ id: `${n.parentInvId}->${n.invId}`, from: n.parentInvId, to: n.invId }));
  const gv = (window as any).gdbgui_global_variable;
  gv.__call_graph_nodes = opts.nodes;
  gv.__call_graph_edges = edges;
  gv.__active_node_id = opts.active;
  gv.__active_path = opts.path;
  gv.__just_returned = [];
  gv.__ghost = opts.ghost
    ? {
        posBySig: new Map([
          ["s1", { x: 0, y: 0 }],
          ["s2", { x: 0, y: 80 }],
          ["s3", { x: 100, y: 80 }],
          ["s9", { x: 200, y: 80 }]
        ]),
        nodes: [...opts.nodes, { ...node(9, 1), sig: "s9" }],
        edges: [],
        width: 300,
        height: 200
      }
    : null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    ReactDOM.render(React.createElement(CallGraph), host);
  });
  return host;
}

const stateOf = (host: HTMLElement, id: number) =>
  (
    host.querySelector(`[data-invid="${id}"] [data-role="state"]`) || {
      textContent: null
    }
  ).textContent;

describe("CallGraph state labels", () => {
  // 1 (waiting) -> 2 (current), 3 (returned child of 1)
  const nodes = [
    node(1, null),
    node(2, 1),
    node(3, 1, { returned: true, retValue: "7" })
  ];

  test("global: current / waiting / returned / ghost / legend", () => {
    const host = mount({ path: [1, 2], active: 2, nodes, ghost: true });
    expect(stateOf(host, 2)).toBe("現在");
    expect(stateOf(host, 1)).toBe("等下一層");
    expect(stateOf(host, 3)).toBe("回傳 7");
    expect(host.querySelector('[data-ghost="1"]')!.textContent).toBe("還沒發生");
    const legend = host.querySelector('[data-testid="cg-legend"]')!.textContent!;
    ["現在", "等下一層", "回傳", "還沒發生"].forEach(w => expect(legend).toContain(w));
    // data contract preserved
    expect(host.querySelector('[data-invid="3"]')!.getAttribute("data-state")).toBe(
      "returned"
    );
    expect(host.querySelector('[data-invid="3"]')!.getAttribute("data-ret")).toBe("7");
  });

  test("local mode: child of current is not 等下一層", () => {
    // current = 1; its children 2 (live) and 3 (returned) are onPath in local mode
    const host = mount({ path: [1], active: 1, nodes });
    (Array.from(host.querySelectorAll("button")).find(
      b => b.textContent === "局部"
    ) as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(stateOf(host, 1)).toBe("現在");
    expect(host.querySelector('[data-invid="2"]')!.getAttribute("data-state")).toBe(
      "active"
    );
    expect(stateOf(host, 2)).toBeNull();
    expect(stateOf(host, 3)).toBe("回傳 7");
  });
});
