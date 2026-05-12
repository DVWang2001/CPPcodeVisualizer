import React from "react";
import { store } from "statorgfc";

const gv = () => (window as any).gdbgui_global_variable;

type State = {
    expressions: any[];
    locals: any[];
    rangeMax: number;
    configKey: string;
};

class RangeRuler extends React.Component<{}, State> {
    _poll: any = null;

    constructor(props: any) {
        super(props);
        this.state = { expressions: [], locals: [], rangeMax: 0, configKey: "" };
        // @ts-expect-error
        store.connectComponentState(this, ["expressions", "locals"]);
    }

    componentDidMount() {
        this._poll = setInterval(() => this.forceUpdate(), 500);
    }

    componentWillUnmount() {
        if (this._poll) clearInterval(this._poll);
    }

    componentDidUpdate(_pp: any, prevState: State) {
        const config = gv()?.__ruler_config;
        const newKey = config ? (config.varNames || []).join(",") : "";

        if (newKey !== this.state.configKey) {
            this.setState({ rangeMax: 0, configKey: newKey });
            return;
        }
        if (config?.varNames) {
            const high = this._val(config.varNames[1]);
            if (high !== null && high > this.state.rangeMax) {
                this.setState({ rangeMax: high });
            }
        }
    }

    _val(name: string): number | null {
        if (!name) return null;
        const exprs: any[] = store.get("expressions") || [];
        const locals: any[] = store.get("locals") || [];

        const e = exprs.find(o =>
            (o.expression === name || o.expression.endsWith(`::${name}`)) && o.in_scope === "true"
        );
        if (e?.value !== undefined) { const n = parseFloat(e.value); if (!isNaN(n)) return n; }

        const l = locals.find(o => o.name === name);
        if (l?.value !== undefined) { const n = parseFloat(l.value); if (!isNaN(n)) return n; }

        return null;
    }

    render() {
        const config = gv()?.__ruler_config;
        if (!config?.varNames) {
            return (
                <div style={{ padding: "12px", color: "#999", fontStyle: "italic", fontSize: "0.85em" }}>
                    尚未啟用。請在 Layout 欄位使用 <code>ruler:lowVar,highVar,midVar</code>。
                </div>
            );
        }

        const [lowName, highName, midName] = config.varNames as string[];
        const low  = this._val(lowName);
        const high = this._val(highName);
        const mid  = midName ? this._val(midName) : null;

        if (low === null || high === null) {
            return (
                <div style={{ padding: "12px", color: "#999", fontStyle: "italic", fontSize: "0.85em" }}>
                    等待變數：{lowName}、{highName}…
                </div>
            );
        }

        const maxV = Math.max(this.state.rangeMax, high, low, 0.001);
        const pct = (v: number) => Math.max(0, Math.min(100, (v / maxV) * 100));
        const lp = pct(low), hp = pct(high);
        const mp = mid !== null ? pct(mid) : null;
        const aw = Math.max(0, hp - lp);

        const barStyle: React.CSSProperties = {
            position: "absolute", top: 0, height: "100%", transition: "left 0.35s, width 0.35s"
        };

        return (
            <div style={{ padding: "10px 16px 18px", fontFamily: "monospace", fontSize: "0.87em", userSelect: "none" }}>
                {/* 數值列 */}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span style={{ color: "#2980b9", fontWeight: 600 }}>{lowName} = {low.toFixed(6)}</span>
                    {mid !== null && <span style={{ color: "#e74c3c", fontWeight: 600 }}>{midName} = {mid.toFixed(6)}</span>}
                    <span style={{ color: "#2980b9", fontWeight: 600 }}>{highName} = {high.toFixed(6)}</span>
                </div>

                {/* 數線 */}
                <div style={{ position: "relative", height: "34px", backgroundColor: "#dde4ea", borderRadius: "6px", overflow: "hidden" }}>
                    {/* 左排除 */}
                    <div style={{ ...barStyle, left: 0, width: `${lp}%`, backgroundColor: "rgba(80,80,80,0.25)" }} />
                    {/* 活躍區間 */}
                    <div style={{ ...barStyle, left: `${lp}%`, width: `${aw}%`, backgroundColor: "rgba(52,152,219,0.4)", borderLeft: "2px solid #2980b9", borderRight: "2px solid #2980b9" }} />
                    {/* 右排除 */}
                    <div style={{ ...barStyle, right: 0, left: "auto", width: `${100 - hp}%`, backgroundColor: "rgba(80,80,80,0.25)" }} />
                    {/* mid 線 */}
                    {mp !== null && (
                        <div style={{ position: "absolute", left: `${mp}%`, top: 0, width: "3px", height: "100%", backgroundColor: "#e74c3c", transform: "translateX(-50%)", transition: "left 0.35s", zIndex: 2 }} />
                    )}
                </div>

                {/* 標籤列 */}
                <div style={{ position: "relative", height: "18px", marginTop: "3px" }}>
                    {[
                        { name: lowName,  xPct: lp, color: "#2980b9" },
                        ...(mp !== null ? [{ name: midName!, xPct: mp, color: "#e74c3c" }] : []),
                        { name: highName, xPct: hp, color: "#2980b9" },
                    ].map(({ name, xPct, color }) => (
                        <span key={name} style={{
                            position: "absolute", left: `${xPct}%`, transform: "translateX(-50%)",
                            color, fontSize: "0.78em", whiteSpace: "nowrap", transition: "left 0.35s"
                        }}>{name}</span>
                    ))}
                </div>

                {/* 刻度 */}
                <div style={{ display: "flex", justifyContent: "space-between", color: "#aaa", fontSize: "0.76em", marginTop: "4px" }}>
                    <span>0</span>
                    <span style={{ color: "#bbb" }}>搜尋空間</span>
                    <span>{maxV.toFixed(4)}</span>
                </div>
            </div>
        );
    }
}

export default RangeRuler;
