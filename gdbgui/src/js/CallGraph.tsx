import React from "react";
import { store } from "statorgfc";

// vis is loaded globally via HTML script tag, not NPM
const vis = (window as any).vis;

type CallGraphState = {
    call_graph_updated: number;
    locals: any[];
    paused_on_frame: any;
};

class CallGraph extends React.Component<{}, CallGraphState> {
    network: any | null = null;
    nodes: any | null = null;
    edges: any | null = null;
    containerRef: React.RefObject<HTMLDivElement>;

    constructor() {
        super({});
        this.containerRef = React.createRef();
        this.state = { call_graph_updated: 0, locals: [], paused_on_frame: null };
        // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on...
        store.connectComponentState(this, ["call_graph_updated", "locals", "paused_on_frame"]);
    }

    componentDidMount() {
        this.nodes = new vis.DataSet();
        this.edges = new vis.DataSet();

        const data = {
            nodes: this.nodes,
            edges: this.edges,
        };

        const options = {
            layout: {
                hierarchical: {
                    direction: "UD",
                    sortMethod: "directed",
                    levelSeparation: 100,
                    nodeSpacing: 100
                }
            },
            nodes: {
                shape: "box",
                margin: 10,
                color: {
                    background: "#ecf0f1",
                    border: "#bdc3c7",
                    highlight: {
                        background: "#3498db",
                        border: "#2980b9"
                    }
                },
                font: { face: "monospace", size: 14 }
            },
            edges: {
                arrows: "to",
                smooth: {
                    type: "cubicBezier",
                    forceDirection: "vertical",
                    roundness: 0.4
                },
                color: { color: "#7f8c8d" }
            },
            physics: false,
            interaction: {
                dragNodes: true,
                dragView: true,
                zoomView: true
            }
        };

        if (this.containerRef.current) {
            this.network = new vis.Network(this.containerRef.current, data, options);
        }

        this.refreshGraph();
    }

    componentDidUpdate(prevProps: any, prevState: CallGraphState) {
        if (
            this.state.call_graph_updated !== prevState.call_graph_updated ||
            this.state.locals !== prevState.locals ||
            this.state.paused_on_frame !== prevState.paused_on_frame
        ) {
            this.refreshGraph();
        }
    }

    refreshGraph() {
        let global_variable = (window as any).gdbgui_global_variable;
        if (!global_variable || !this.nodes || !this.edges) return;

        const gNodes = global_variable.__call_graph_nodes;
        const gEdges = global_variable.__call_graph_edges;
        const activeNodeId = global_variable.__active_node_id;

        if (gNodes) {
            const pausedFrame = this.state.paused_on_frame;
            const locals = this.state.locals || [];

            const visNodes = gNodes.map((n: any) => {
                // 函式名稱與參數整合為 functionName(arg1=val1, ...)
                let argsStr = "";
                if (n.args && n.args.length > 0) {
                    argsStr = n.args.map((a: any) => `${a.name}=${a.value ?? '?'}`).join(", ");
                }
                let label = `${n.func_name}(${argsStr})`;

                let color;
                const font = { face: "monospace", size: 13, color: "#2c3e50" };

                // 顯示當前行號
                if (n.line) {
                    label += `\n\nLine: ${n.line}`;
                }

                if (n.id === activeNodeId) {
                    // Active node also shows current locals
                    const locals = this.state.locals || [];

                    // Filter out variables that are already displayed as parameters
                    const paramNames = n.args ? n.args.map((a: any) => a.name) : [];
                    const trueLocals = locals.filter((l: any) => !paramNames.includes(l.name));

                    if (trueLocals.length > 0) {
                        const localsStr = trueLocals.map((l: any) => `${l.name} = ${l.value ?? '...'}`).join('\n');
                        label += `\n\n[Local Variables]\n${localsStr}`;
                    }
                    // Yellow highlight
                    color = { background: '#f1c40f', border: '#e67e22', highlight: { background: '#f39c12', border: '#e67e22' } };
                } else {
                    color = {
                        background: "#ecf0f1",
                        border: "#bdc3c7",
                        highlight: { background: "#3498db", border: "#2980b9" }
                    };
                }

                return { ...n, label, color, font };
            });

            this.nodes.update(visNodes);
        }

        if (gEdges) {
            this.edges.update(gEdges);
        }

        // Attempt to center and fit if we have nodes
        if (this.network && gNodes && gNodes.length > 0) {
            // Small timeout to let vis calculate layout first
            setTimeout(() => {
                if (this.network) this.network.fit({ animation: true });
            }, 100);
        }
    }

    render() {
        return (
            <div
                ref={this.containerRef}
                style={{ width: "100%", height: "300px", border: "1px solid #ddd", backgroundColor: "#fafafa" }}
            />
        );
    }
}

export default CallGraph;
