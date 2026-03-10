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
    resizeObserver: ResizeObserver | null = null;
    _lastNodeCount: number = 0;
    _lastActiveNodeId: string = "";
    _isFirstVisible: boolean = true;
    _lastVisNodesStr: string = "";
    _lastEdgesStr: string = "";

    constructor(props: any) {
        super(props);
        this.containerRef = React.createRef();
        this.state = { call_graph_updated: 0, locals: [], paused_on_frame: null };
        // @ts-expect-error
        store.connectComponentState(this, ["call_graph_updated", "locals", "paused_on_frame", "expressions"]);
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
                    enabled: true,
                    direction: "UD",
                    sortMethod: "directed", // Strictly from top to bottom
                    levelSeparation: 120,
                    nodeSpacing: 150
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
            physics: {
                enabled: true,
                hierarchicalRepulsion: {
                    centralGravity: 0.0,
                    springLength: 100,
                    springConstant: 1.0, // High stiffness
                    nodeDistance: 150,
                    damping: 1.0, // Max friction to stop all bouncy oscillations instantly
                    avoidOverlap: 1
                },
                solver: 'hierarchicalRepulsion',
                stabilization: {
                    enabled: true,
                    iterations: 50,
                    fit: false
                }
            },
            interaction: {
                dragNodes: true,
                dragView: true,
                zoomView: true
            }
        };

        if (this.containerRef.current) {
            this.network = new vis.Network(this.containerRef.current, data, options);
            
            // 監聽容器大小，避免畫布初始 0x0
            if (window.ResizeObserver) {
                this.resizeObserver = new ResizeObserver((entries) => {
                    if (this.network) {
                        for (let entry of entries) {
                            if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                                if (this._isFirstVisible) {
                                    this.network.setSize(entry.contentRect.width + 'px', entry.contentRect.height + 'px');
                                    this.network.redraw();
                                    this.network.fit({ animation: false });
                                    this._isFirstVisible = false;
                                }
                            } else {
                                this._isFirstVisible = true;
                            }
                        }
                    }
                });
                this.resizeObserver.observe(this.containerRef.current);
            }
        }

        // 初始畫圖
        this.refreshGraph();
    }

    componentWillUnmount() {
        if (this.resizeObserver && this.containerRef.current) {
            this.resizeObserver.unobserve(this.containerRef.current);
            this.resizeObserver.disconnect();
        }
        if (this.network) {
            this.network.destroy();
            this.network = null;
        }
    }

    componentDidUpdate(prevProps: any, prevState: CallGraphState) {
        this.refreshGraph();
    }

    refreshGraph() {
        let global_variable = (window as any).gdbgui_global_variable;
        if (!global_variable || !this.nodes || !this.edges) {
            return;
        }

        const gNodes = global_variable.__call_graph_nodes;
        const gEdges = global_variable.__call_graph_edges;
        const activeNodeId = global_variable.__active_node_id;

        if (gNodes) {
             // 從 store 取最新狀態 (因為我們不用 state 了) -> 這裡需要改回用 state
            const locals = store.get("locals") || [];

            const visNodes = gNodes.map((n: any) => {
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
                    let trueLocals: any[] = [];
                    const paramNames = n.args ? n.args.map((a: any) => a.name) : [];
                    
                    if (locals && locals.length > 0) {
                        trueLocals = locals.filter((l: any) => !paramNames.includes(l.name));
                        if (trueLocals.length > 0) {
                            const localsStr = trueLocals.map((l: any) => `${l.name} = ${l.value ?? '...'}`).join('\n');
                            label += `\n\n[Local Variables]\n${localsStr}`;
                        }
                    }
                    
                    color = { background: '#f1c40f', border: '#e67e22', highlight: { background: '#f39c12', border: '#e67e22' } };

                    // 檢查是否有自訂的 Call Graph 標籤
                    const customLabels = global_variable.__call_graph_custom_labels;
                    if (customLabels && n.line && customLabels[n.line]) {
                        const customData = customLabels[n.line];
                        label = `[${customData.labelName}]`;
                        
                        // 嘗試抓取指定的 {變數}
                        if (customData.vars && customData.vars.length > 0) {
                            label += `\n\n`;
                            const expressions = store.get("expressions") || [];
                            customData.vars.forEach((varName: string) => {
                                const displayKey = n.func_name ? `${n.func_name}::${varName}` : varName;
                                const exprObj = expressions.find((obj: any) => obj.expression === displayKey && obj.in_scope === "true") || 
                                                expressions.find((obj: any) => obj.expression === varName && obj.in_scope === "true");
                                                
                                const varValue = exprObj && exprObj.value !== undefined ? exprObj.value : "...";
                                label += `${varName} = ${varValue}\n`;
                            });
                        }

                        // 如果有指定顏色，覆蓋顏色
                        if (customData.color) {
                            const c = customData.color.toLowerCase();
                            if (c === 'green') {
                                color = { background: '#2ecc71', border: '#27ae60', highlight: { background: '#2ecc71', border: '#27ae60' } };
                            } else if (c === 'red') {
                                color = { background: '#e74c3c', border: '#c0392b', highlight: { background: '#e74c3c', border: '#c0392b' } };
                            } else if (c === 'blue') {
                                color = { background: '#3498db', border: '#2980b9', highlight: { background: '#3498db', border: '#2980b9' } };
                            } else {
                                color = { background: c, border: c, highlight: { background: c, border: c } };
                            }
                        }
                    }

                } else {
                    color = {
                        background: "#ecf0f1",
                        border: "#bdc3c7",
                        highlight: { background: "#3498db", border: "#2980b9" }
                    };
                }

                return { ...n, label, color, font };
            });

            const newDataStr = JSON.stringify(visNodes);
            if (this._lastVisNodesStr !== newDataStr) {
                this._lastVisNodesStr = newDataStr;
                
                // Remove nodes that are no longer in the state
                const newIds = visNodes.map((n: any) => n.id);
                const currentIds = this.nodes.getIds();
                const idsToRemove = currentIds.filter((id: any) => !newIds.includes(id));
                if (idsToRemove.length > 0) {
                    this.nodes.remove(idsToRemove);
                }

                this.nodes.update(visNodes);
            }
        }

        if (gEdges) {
            const newEdgesStr = JSON.stringify(gEdges);
            if (this._lastEdgesStr !== newEdgesStr) {
                this._lastEdgesStr = newEdgesStr;
                
                // Remove edges that are no longer in the state
                const newEdgeIds = gEdges.map((e: any) => e.id);
                const currentEdgeIds = this.edges.getIds();
                const edgeIdsToRemove = currentEdgeIds.filter((id: any) => !newEdgeIds.includes(id));
                if (edgeIdsToRemove.length > 0) {
                    this.edges.remove(edgeIdsToRemove);
                }

                this.edges.update(gEdges);
            }
        }

        if (this.network && gNodes && gNodes.length > 0) {
            const currentNodesLength = gNodes.length;
            const needsFit = currentNodesLength !== this._lastNodeCount;
            this._lastNodeCount = currentNodesLength;

            if (activeNodeId) {
                this.network.selectNodes([activeNodeId]);
                
                if (needsFit || this._lastActiveNodeId !== activeNodeId) {
                    this._lastActiveNodeId = activeNodeId;
                    
                    // Focus on the active node instead of zooming out to fit everything.
                    // Keep the user's current zoom scale.
                    this.network.focus(activeNodeId, {
                        scale: this.network.getScale(),
                        animation: {
                            duration: 300,
                            easingFunction: "easeOutQuad"
                        }
                    });
                }
            }
        }
    }

    render() {
        return (
            <div style={{ width: "100%", padding: "5px" }}>
                <div
                    ref={this.containerRef}
                    style={{ 
                        width: "100%", 
                        height: "400px", 
                        border: "1px solid #ddd", 
                        backgroundColor: "#fafafa",
                        display: "block" 
                    }}
                />
            </div>
        );
    }
}

export default CallGraph;
