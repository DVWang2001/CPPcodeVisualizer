import React from "react";
import { store } from "statorgfc";
import GdbVariable from "./GdbVariable";
import constants from "./constants";

class WatchTable extends React.Component {
    objs_to_delete: any;
    objs_to_render: any;

    constructor() {
        // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
        super();
        // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
        store.connectComponentState(this, ["expressions"]);
    }

    render() {
        // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
        let sorted_expression_objs = _.sortBy(
            store.get("expressions"),
            (unsorted_obj: any) => unsorted_obj.expression
        );
        // only render variables in scope that were not created for the Locals component
        this.objs_to_render = sorted_expression_objs.filter(
            (obj: any) => obj.in_scope === "true" && obj.expr_type === "watch"
        );
        this.objs_to_delete = sorted_expression_objs.filter(
            (obj: any) => obj.in_scope === "invalid"
        );

        // delete invalid objects
        this.objs_to_delete.map((obj: any) => GdbVariable.delete_gdb_variable(obj.name));

        let rows = this.objs_to_render.map((obj: any) => {
            // 這裡直接套用我們先前增強過的渲染函式
            const valJsx = GdbVariable._get_value_jsx(obj);
            // 原本 gdb 變數型別字串可能會有前後空白
            // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
            const typeStr = _.trim(obj.type) || "";

            return (
                <tr key={obj.expression} style={{ borderBottom: "1px solid #ccc" }}>
                    <td style={{ padding: "4px 8px", fontWeight: "bold", width: "30%", textOverflow: "ellipsis", overflow: "hidden" }}>
                        {obj.expression}
                    </td>
                    <td style={{ padding: "4px 8px", width: "20%", fontSize: "0.9em", color: "#666", textOverflow: "ellipsis", overflow: "hidden" }}>
                        {typeStr}
                    </td>
                    <td style={{ padding: "4px 8px", width: "40%", wordBreak: "break-all" }}>
                        {valJsx}
                    </td>
                    <td style={{ padding: "4px 8px", width: "10%", textAlign: "center" }}>
                        <span
                            style={{ fontSize: "0.8em", cursor: "pointer", color: "red" }}
                            className="glyphicon glyphicon-trash"
                            onClick={() => GdbVariable.delete_gdb_variable(obj.name)}
                            title="Delete Expression"
                        />
                    </td>
                </tr>
            );
        });

        if (rows.length === 0) {
            rows.push(
                <tr key="empty">
                    <td colSpan={4} style={{ padding: "8px", textAlign: "center", color: "#888", fontStyle: "italic" }}>
                        No variables to watch. Add one below.
          </td>
                </tr>
            );
        }

        return (
            <div style={{ backgroundColor: "#fafafa", border: "1px solid #ddd", borderRadius: "4px", padding: "8px", margin: "5px 0" }}>
                <div style={{ maxHeight: "250px", overflowY: "auto" }}>
                    <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}>
                        <thead>
                            <tr style={{ backgroundColor: "#eee", textAlign: "left" }}>
                                <th style={{ padding: "4px 8px", width: "30%" }}>Name</th>
                                <th style={{ padding: "4px 8px", width: "20%" }}>Type</th>
                                <th style={{ padding: "4px 8px", width: "40%" }}>Value</th>
                                <th style={{ padding: "4px 8px", width: "10%" }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows}
                        </tbody>
                    </table>
                </div>

                <div style={{ marginTop: "10px" }}>
                    <input
                        id="watch_table_input"
                        className="form-control"
                        placeholder="Expression or variable to watch... (e.g. k)"
                        style={{
                            width: "100%",
                            padding: "6px 8px",
                            height: "28px",
                            fontSize: "1em",
                            boxSizing: "border-box"
                        }}
                        onKeyUp={WatchTable.keydown_on_input}
                    />
                </div>
            </div>
        );
    }

    componentDidUpdate() {
        for (let obj of this.objs_to_render) {
            if (obj.show_plot) {
                GdbVariable.plot_var_and_children(obj);
            }
        }
    }

    static keydown_on_input(e: any) {
        if (e.keyCode === constants.ENTER_BUTTON_NUM) {
            let expr = e.currentTarget.value,
                // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
                trimmed_expr = _.trim(expr);

            if (trimmed_expr !== "") {
                GdbVariable.create_variable(trimmed_expr, "watch");
                e.currentTarget.value = ""; // Clear input after submit
            }
        }
    }
}

export default WatchTable;
