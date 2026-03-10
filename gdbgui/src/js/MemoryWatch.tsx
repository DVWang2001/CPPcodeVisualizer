import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";

class MemoryWatch extends React.Component<any, any> {
    intervalId: any;

    constructor(props: any) {
        super(props);
        this.state = {
            trackedVars: [] // [{ name: "x", address: "0x...", value: "10" }]
        };
    }

    componentDidMount() {
        this.intervalId = setInterval(() => this.updateTrackedVars(), 500);
    }

    componentWillUnmount() {
        clearInterval(this.intervalId);
    }

    updateTrackedVars() {
        if (!global_variable.__active_visualizer_exprs) return;

        const expressions = store.get("expressions") || [];
        const newTracked = [];

        // 過濾出原始變數名 (排除被我們加上 `&(...)` 的運算式與字串常數)
        const baseExprs = Array.from(global_variable.__active_visualizer_exprs).filter(
            (e: any) => !e.startsWith("&(") && !e.startsWith('"') && !e.endsWith('"')
        );

        for (const expr of baseExprs) {
            const varObj = expressions.find((obj: any) => obj.expression === expr && obj.in_scope === "true");

            // 找出我們剛剛在 helper 中偷加的位址監看項
            const addrExpr = `&(${expr})`;
            const addrObj = expressions.find((obj: any) => obj.expression === addrExpr && obj.in_scope === "true");

            if (varObj) {
                let displayAddr = addrObj ? (addrObj.value || "Calculating...") : "N/A";

                // 判斷 expression 是否為常數（數字、浮點數、十六進位、字元、布林等）
                if (displayAddr === "N/A") {
                    const exprStr = String(varObj.expression).trim();
                    const isNumericConst = /^-?\d+(\.\d+)?$/.test(exprStr);       // 整數或浮點數
                    const isHexConst = /^0x[0-9a-fA-F]+$/.test(exprStr);          // 十六進位
                    const isCharConst = /^'.'$/.test(exprStr);                     // 字元常數
                    const isBoolConst = (exprStr === "true" || exprStr === "false");

                    if (isNumericConst || isHexConst || isCharConst || isBoolConst) {
                        displayAddr = "Constant Value";
                    }
                }

                newTracked.push({
                    name: varObj.expression,
                    address: displayAddr,
                    value: varObj.value || "{...}"
                });
            }
        }

        // 額外處理字串常數 (直接從 global_variable.__static_strings 找)
        if (global_variable.__static_strings) {
            for (const staticStr of global_variable.__static_strings) {
                // 必須與 VisualizerHelper.js 中的 key 完全一致
                const addrExpr = `"(void*)(\\"${staticStr}\\")"`;
                const addrObj = expressions.find((obj: any) => obj.expression === addrExpr && obj.in_scope === "true");

                let displayAddr = addrObj ? (addrObj.value || "Calculating...") : "Calculating...";

                // 如果是字串常數且卡在 Calculating，可能是 GDB 不支援該語句，顯示較有意義的 (RODATA)
                if (displayAddr === "Calculating...") {
                    // 若持續計算中，提示使用者這可能是唯讀字串
                    displayAddr = "Read-Only Data";
                } else if (displayAddr.includes(' ')) {
                    // 只取 0x... 部分
                    displayAddr = displayAddr.split(' ')[0];
                }

                newTracked.push({
                    name: `"${staticStr}"`,
                    address: displayAddr,
                    value: `"${staticStr}"`
                });
            }
        }

        this.setState({ trackedVars: newTracked });
    }

    render() {
        const { trackedVars } = this.state;

        return (
            <div style={{ padding: "10px", backgroundColor: "#fdfdfd" }}>
                {trackedVars.length === 0 ? (
                    <div style={{ fontStyle: "italic", color: "#888", textAlign: "center" }}>
                        尚無觀測變數
                    </div>
                ) : (
                        <table className="table table-bordered table-condensed" style={{ background: "white", marginBottom: 0 }}>
                            <thead>
                                <tr style={{ backgroundColor: "#eaeaea" }}>
                                    <th>變數 (Expression)</th>
                                    <th>位址 (Address)</th>
                                    <th>數值 (Value)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {trackedVars.map((v: any, idx: number) => (
                                    <tr key={idx}>
                                        <td style={{ fontWeight: "bold", color: "#d32f2f" }}>{v.name}</td>
                                        <td style={{ fontFamily: "monospace", color: "#1976d2" }}>{v.address}</td>
                                        <td style={{ fontFamily: "monospace" }}>{v.value}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
            </div>
        );
    }
}

export default MemoryWatch;
