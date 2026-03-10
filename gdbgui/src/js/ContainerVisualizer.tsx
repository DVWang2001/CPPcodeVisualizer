import React from "react";
import { global_variable } from "./global_variable";

type State = any;

class ContainerVisualizer extends React.Component<{}, State> {
    updateInterval: any;

    constructor(props: {}) {
        super(props);
        this.state = {};
    }

    componentDidMount() {
        this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
    }

    componentWillUnmount() {
        if (this.updateInterval) clearInterval(this.updateInterval);
    }

    renderContainerShape(name: string, data: any, highlightIndex: number | undefined) {
        const { type, values } = data;
        const len = values.length;
        let shape = null;

        switch (type) {
            case "string":
            case "vector":
            case "array":
                const rawCap = data.capacity !== undefined ? parseInt(data.capacity) : len;
                const cap = (!isNaN(rawCap) && rawCap >= 0) ? rawCap : len;
                const emptySlots = (cap > len && cap - len < 1000) ? cap - len : 0;

                // Check if it's a 2D vector / grid (the first element is an array)
                const is2D = len > 0 && Array.isArray(values[0]);

                if (is2D) {
                    shape = (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', backgroundColor: '#f9f9f9', padding: '6px', border: '2px solid #333', borderRadius: '6px' }}>
                            {values.map((row: any[], rowIdx: number) => (
                                <div key={`row-${rowIdx}`} style={{ display: 'flex', gap: '3px' }}>
                                    {row.map((colVal: string, colIdx: number) => (
                                        <div key={`col-${rowIdx}-${colIdx}`} style={{ border: '1px solid #888', padding: '4px 10px', minWidth: '35px', textAlign: 'center', backgroundColor: '#fff', borderRadius: '3px', boxShadow: '1px 1px 3px rgba(0,0,0,0.1)' }}>
                                            {type === "string" && colVal !== "" ? `'${colVal}'` : colVal}
                                        </div>
                                    ))}
                                    {row.length === 0 && <div style={{ padding: '4px 10px', color: '#999', fontStyle: 'italic', border: '1px dashed #999', backgroundColor: '#fff', borderRadius: '3px' }}>empty row</div>}
                                </div>
                            ))}
                        </div>
                    );
                } else {
                    shape = (
                        <div style={{ display: 'inline-flex', verticalAlign: 'middle', alignItems: 'stretch', gap: '2px' }}>
                            <div style={{ display: 'inline-flex', border: '2px solid #333', borderRadius: '4px', backgroundColor: '#f9f9f9', overflow: 'hidden' }}>
                                {values.map((v: string, idx: number) => {
                                    const isHighlighted = highlightIndex === idx;
                                    const bgColor = isHighlighted ? '#fff6b3' : 'transparent';
                                    const fontWeight = isHighlighted ? 'bold' : 'normal';
                                    const borderRight = idx < len - 1 ? '1px solid #777' : 'none';
                                    return (
                                        <div key={`val-${idx}`} style={{ padding: '2px 8px', borderRight: borderRight, minWidth: '20px', textAlign: 'center', backgroundColor: bgColor, fontWeight: fontWeight }}>
                                            {type === "string" && v !== "" ? `'${v}'` : v}
                                        </div>
                                    );
                                })}
                                {len === 0 && <div style={{ padding: '2px 8px', color: '#999', fontStyle: 'italic' }}>empty</div>}
                            </div>
                            {emptySlots > 0 && Array.from({ length: emptySlots }).map((_, idx) => (
                                <div key={`cap-${idx}`} style={{ display: 'inline-block', minWidth: '20px', border: '2px dashed #aaa', backgroundColor: '#f0f0f0', borderRadius: '2px' }} title="Unused Capacity" />
                            ))}
                        </div>
                    );
                }
                break;
            case "list":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#e6f2ff';
                            const borderColor = isHighlighted ? '#cca300' : '#0056b3';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <React.Fragment key={idx}>
                                    <div style={{ padding: '4px 10px', borderRadius: '16px', border: `2px solid ${borderColor}`, backgroundColor: bgColor, minWidth: '30px', textAlign: 'center', fontWeight: fontWeight }}>
                                        {v}
                                    </div>
                                    {idx < len - 1 && <span style={{ color: '#0056b3', fontWeight: 'bold' }}>&harr;</span>}
                                </React.Fragment>
                            );
                        })}
                        {len === 0 && <div style={{ padding: '4px 10px', borderRadius: '16px', border: '2px dashed #0056b3', color: '#999', fontStyle: 'italic' }}>empty node</div>}
                    </div>
                );
                break;
            case "stack":
                shape = (
                    <div style={{ display: 'inline-flex', flexDirection: 'row-reverse', border: '3px solid #b30000', borderLeft: 'none', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', padding: '4px', minHeight: '30px', alignItems: 'center', backgroundColor: '#fff', verticalAlign: 'middle', gap: '4px' }}>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#ffe6e6';
                            const borderColor = isHighlighted ? '#cca300' : '#ff6666';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <div key={idx} style={{ border: `2px solid ${borderColor}`, padding: '2px 8px', textAlign: 'center', backgroundColor: bgColor, minWidth: '30px', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '0 10px' }}>empty</div>}
                    </div>
                );
                break;
            case "queue":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', backgroundColor: '#f0fff0', borderTop: '3px solid #00b300', borderBottom: '3px solid #00b300', padding: '4px', gap: '4px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        <span style={{ color: '#00b300', fontSize: '1.2em' }}>&larr;</span>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#fff';
                            const borderColor = isHighlighted ? '#cca300' : '#66cc66';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            const borderStyle = isHighlighted ? '2px solid' : '2px dashed';
                            return (
                                <div key={idx} style={{ border: `${borderStyle} ${borderColor}`, padding: '2px 8px', backgroundColor: bgColor, textAlign: 'center', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '2px 8px' }}>empty</div>}
                        <span style={{ color: '#00b300', fontSize: '1.2em' }}>&larr;</span>
                    </div>
                );
                break;
            case "deque":
                shape = (
                    <div style={{ display: 'inline-flex', alignItems: 'center', borderBottom: '4px solid #6600cc', paddingBottom: '4px', gap: '6px', verticalAlign: 'middle', flexWrap: 'wrap' }}>
                        <span style={{ color: '#6600cc', fontSize: '1.2em' }}>&harr;</span>
                        {values.map((v: string, idx: number) => {
                            const isHighlighted = highlightIndex === idx;
                            const bgColor = isHighlighted ? '#fff6b3' : '#f9f2ff';
                            const borderColor = isHighlighted ? '#cca300' : '#b366ff';
                            const fontWeight = isHighlighted ? 'bold' : 'normal';
                            return (
                                <div key={idx} style={{ padding: '4px 10px', border: `2px solid ${borderColor}`, backgroundColor: bgColor, borderRadius: '4px', textAlign: 'center', fontWeight: fontWeight }}>
                                    {v}
                                </div>
                            );
                        })}
                        {len === 0 && <div style={{ color: '#999', fontStyle: 'italic', padding: '4px 10px' }}>empty</div>}
                        <span style={{ color: '#6600cc', fontSize: '1.2em' }}>&harr;</span>
                    </div>
                );
                break;
            default:
                shape = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{values.join(", ")}</span>;
        }

        const displayCapacity = data.capacity !== undefined ? data.capacity : len;

        const showCapacitySize = (type === "vector");

        return (
            <div key={name} style={{ marginBottom: "16px", padding: "8px", border: "1px solid #ddd", borderRadius: "4px", backgroundColor: "#fff" }}>
                <div style={{ marginBottom: "8px", fontWeight: "bold", fontFamily: "monospace", color: "#333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{name} <span style={{ color: "#888", fontWeight: "normal", fontSize: "0.9em" }}>({type})</span></span>
                    {showCapacitySize && (
                        <span style={{ color: "#0066cc", fontSize: "0.85em", backgroundColor: "#e6f2ff", padding: "2px 6px", borderRadius: "4px" }}>
                            Size: {len}, Capacity: {displayCapacity}
                        </span>
                    )}
                </div>
                <div style={{ overflowX: "auto" }}>
                    {shape}
                </div>
            </div>
        );
    }

    render() {
        const latestContainers = (global_variable as any).__latest_containers as Map<string, any>;
        if (!latestContainers || latestContainers.size === 0) {
            return <div style={{ padding: "10px", color: "#666", fontStyle: "italic" }}>No container data available. Run and trace code to see containers.</div>;
        }

        const latestHighlights = (global_variable as any).__latest_highlights as Map<string, number> || new Map<string, number>();

        const containerElements = Array.from(latestContainers.entries()).map(([name, data]) => {
            const highlightIndex = latestHighlights.get(name);
            return this.renderContainerShape(name, data, highlightIndex);
        });

        return (
            <div style={{ padding: "10px", backgroundColor: "#fdfdfd" }}>
                {containerElements}
            </div>
        );
    }
}

export default ContainerVisualizer;
