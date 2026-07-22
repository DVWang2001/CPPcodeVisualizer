import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import type { UmlPayload } from "./umlPayload";

class UMLVisualizer extends React.Component<{}, {}> {
    private timer: any;
    componentDidMount() {
        this.timer = setInterval(() => this.forceUpdate(), 1000);
        // @ts-expect-error statorgfc augmentation
        store.connectComponentState(this, ["inferior_program"]);
    }
    componentWillUnmount() { clearInterval(this.timer); }

    render() {
        const map = (global_variable as any).__latest_uml as Map<string, UmlPayload> | undefined;
        const payloads = map ? [...map.values()] : [];
        if (payloads.length === 0) {
            return <div style={{ padding: "10px", color: "var(--ink-soft)", fontStyle: "italic", fontSize: "0.9em" }}>
                在教案行尾寫 <code>uml:變數名</code> 後執行，這裡會畫出該物件的 UML 圖。
            </div>;
        }
        return (
            <div style={{ padding: "8px", display: "flex", flexWrap: "wrap", gap: "14px" }}>
                {payloads.map(p => (
                    <div key={p.name} style={{
                        border: "1.5px solid var(--accent)", borderRadius: "8px", background: "var(--surface)",
                        fontFamily: "var(--font-mono, monospace)", minWidth: "160px", overflow: "hidden",
                    }}>
                        <div style={{
                            background: "var(--hdr, var(--accent-soft))", fontWeight: 700, fontSize: "13px",
                            padding: "5px 10px", textAlign: "center", borderBottom: "1.5px solid var(--line)",
                        }}>
                            {p.className}<span style={{ color: "var(--ink-faint)", fontWeight: 400, fontSize: "11px" }}> {p.name}</span>
                        </div>
                        <div style={{ padding: "5px 10px", display: "flex", flexDirection: "column", gap: "2px" }}>
                            {p.fields.map((f, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12px" }}>
                                    <span style={{ color: "var(--ink-soft)" }}>{f.name}</span>
                                    <span style={{ fontWeight: 700, color: "var(--ink)" }}>{f.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }
}
export default UMLVisualizer;
