import React from "react";
import { store } from "statorgfc";
import GdbApi from "./GdbApi";
import Actions from "./Actions";
import Util from "./Util";
import FileOps from "./FileOps";
import { FileLink } from "./Links";
import constants from "./constants";

const BreakpointSourceLineCache = {
  _cache: {},
  get_line: function (fullname: any, linenum: any) {
    if (
      // @ts-expect-error ts-migrate(7053) FIXME: Property 'fullname' does not exist on type '{}'.
      BreakpointSourceLineCache._cache["fullname"] !== undefined &&
      // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
      _.isString(BreakpointSourceLineCache._cache["fullname"][linenum])
    ) {
      // @ts-expect-error ts-migrate(7053) FIXME: Property 'fullname' does not exist on type '{}'.
      return BreakpointSourceLineCache._cache["fullname"][linenum];
    }
    return null;
  },
  add_line: function (fullname: any, linenum: any, escaped_text: any) {
    // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
    if (!_.isObject(BreakpointSourceLineCache._cache["fullname"])) {
      // @ts-expect-error ts-migrate(7053) FIXME: Property 'fullname' does not exist on type '{}'.
      BreakpointSourceLineCache._cache["fullname"] = {};
    }
    // @ts-expect-error ts-migrate(7053) FIXME: Property 'fullname' does not exist on type '{}'.
    BreakpointSourceLineCache._cache["fullname"][linenum] = escaped_text;
  }
};

type BreakpointState = any;

class Breakpoint extends React.Component<{}, BreakpointState> {
  constructor(props: {}) {
    super(props);
    this.state = {
      breakpoint_condition: "",
      editing_breakpoint_condition: false
    };
  }
  get_source_line(fullname: any, linenum: any) {
    // if we have the source file cached, we can display the line of text
    const MAX_CHARS_TO_SHOW_FROM_SOURCE = 40;
    let line = null;
    if (BreakpointSourceLineCache.get_line(fullname, linenum)) {
      line = BreakpointSourceLineCache.get_line(fullname, linenum);
      // @ts-expect-error ts-migrate(2554) FIXME: Expected 3 arguments, but got 2.
    } else if (FileOps.line_is_cached(fullname, linenum)) {
      let syntax_highlighted_line = FileOps.get_line_from_file(fullname, linenum);
      // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
      line = _.trim(Util.get_text_from_html(syntax_highlighted_line));

      if (line.length > MAX_CHARS_TO_SHOW_FROM_SOURCE) {
        line = line.slice(0, MAX_CHARS_TO_SHOW_FROM_SOURCE) + "...";
      }
      BreakpointSourceLineCache.add_line(fullname, linenum, line);
    }

    if (line) {
      return (
        <span className="monospace" style={{ whiteSpace: "nowrap", fontSize: "0.9em" }}>
          {line || <br />}
        </span>
      );
    }
    return "(file not cached)";
  }
  get_delete_jsx(bkpt_num_to_delete: any) {
    return (
      <div
        style={{ width: "10px", display: "inline" }}
        className="pointer breakpoint_trashcan"
        onClick={e => {
          e.stopPropagation();
          Breakpoints.delete_breakpoint(bkpt_num_to_delete);
        }}
        title={`Delete breakpoint ${bkpt_num_to_delete}`}
      >
        <span className="glyphicon glyphicon-trash"> </span>
      </div>
    );
  }
  get_num_times_hit(bkpt: any) {
    if (
      bkpt.times === undefined || // E.g. 'bkpt' is a child breakpoint
      bkpt.times == 0
    ) {
      return "";
    } else if (bkpt.times == 1) {
      return "1 hit";
    } else {
      return `${bkpt.times} hits`;
    }
  }
  on_change_bkpt_cond(e: any) {
    this.setState({
      breakpoint_condition: e.target.value,
      editing_breakpoint_condition: true
    });
  }
  on_key_up_bktp_cond(number: any, e: any) {
    if (e.keyCode === constants.ENTER_BUTTON_NUM) {
      this.setState({ editing_breakpoint_condition: false });
      Breakpoints.set_breakpoint_condition(e.target.value, number);
    }
  }
  on_break_cond_click(e: any) {
    this.setState({
      editing_breakpoint_condition: true
    });
  }
  render() {
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'bkpt' does not exist on type 'Readonly<{... Remove this comment to see the full error message
    let b = this.props.bkpt,
      checked = b.enabled === "y" ? "checked" : "",
      source_line = this.get_source_line(b.fullname_to_display, b.line);

    let info_glyph, function_jsx, bkpt_num_to_delete;
    if (b.is_child_breakpoint) {
      bkpt_num_to_delete = b.parent_breakpoint_number;
      info_glyph = (
        <span
          className="glyphicon glyphicon-th-list"
          title="Child breakpoint automatically created from parent. If parent or any child of this tree is deleted, all related breakpoints will be deleted."
        />
      );
    } else if (b.is_parent_breakpoint) {
      info_glyph = (
        <span
          className="glyphicon glyphicon-th-list"
          title="Parent breakpoint with one or more child breakpoints. If parent or any child of this tree is deleted, all related breakpoints will be deleted."
        />
      );
      bkpt_num_to_delete = b.number;
    } else {
      bkpt_num_to_delete = b.number;
      info_glyph = "";
    }

    const delete_jsx = this.get_delete_jsx(bkpt_num_to_delete);
    let location_jsx = (
      <FileLink
        fullname={b.fullname_to_display}
        file={b.fullname_to_display}
        line={b.line}
      />
    );

    if (b.is_parent_breakpoint) {
      function_jsx = (
        <span className="placeholder">
          {info_glyph} parent breakpoint on inline, template, or ambiguous location
        </span>
      );
    } else {
      let func = b.func === undefined ? "(unknown function)" : b.func;
      let break_condition = (
        <div
          onClick={this.on_break_cond_click.bind(this)}
          className="inline"
          title={`${
            this.state.breakpoint_condition ? "Modify or remove" : "Add"
            } breakpoint condition`}
        >
          <span className="glyphicon glyphicon-edit"></span>
          <span className={`italic ${this.state.breakpoint_condition ? "bold" : ""}`}>
            condition
          </span>
        </div>
      );
      if (this.state.editing_breakpoint_condition) {
        break_condition = (
          <input
            type="text"
            style={{
              display: "inline",
              width: "110px",
              padding: "10px 10px",
              height: "25px",
              fontSize: "1em"
            }}
            placeholder="Break condition"
            className="form-control"
            onKeyUp={this.on_key_up_bktp_cond.bind(this, b.number)}
            onChange={this.on_change_bkpt_cond.bind(this)}
            value={this.state.breakpoint_condition}
          />
        );
      }

      const times_hit = this.get_num_times_hit(b);
      function_jsx = (
        <div style={{ display: "inline" }}>
          <span className="monospace" style={{ paddingRight: "5px" }}>
            {info_glyph} {func}
          </span>
          <span
            style={{
              color: "#bbbbbb",
              fontStyle: "italic",
              paddingRight: "5px"
            }}
          >
            thread groups: {b["thread-groups"]}
          </span>
          <span>{break_condition}</span>
          <span
            style={{
              color: "#bbbbbb",
              fontStyle: "italic",
              paddingLeft: "5px"
            }}
          >
            {times_hit}
          </span>
        </div>
      );
    }

    return (
      <div
        className="breakpoint"
        onClick={() => Actions.view_file(b.fullname_to_display, b.line)}
      >
        <table
          style={{
            width: "100%",
            fontSize: "0.9em",
            borderWidth: "0px"
          }}
          className="lighttext table-condensed"
        >
          <tbody>
            <tr>
              <td>
                <input
                  type="checkbox"
                  // @ts-expect-error ts-migrate(2322) FIXME: Type 'string' is not assignable to type 'boolean |... Remove this comment to see the full error message
                  checked={checked}
                  onChange={() => Breakpoints.enable_or_disable_bkpt(checked, b.number)}
                />
                {function_jsx} {delete_jsx}
              </td>
            </tr>

            <tr>
              <td>{location_jsx}</td>
            </tr>

            <tr>
              <td>{source_line}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  } // render function
}

class Breakpoints extends React.Component {
  private storeSubscriptionCallback: any;

  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, ["breakpoints"]);

    this.storeSubscriptionCallback = (key: any, val: any) => {
      if (key === "breakpoints") {
        localStorage.setItem("breakpoints", JSON.stringify(val));
      }
    };
    store.subscribeToKeys(["breakpoints"], this.storeSubscriptionCallback);
  }
  componentWillUnmount() {
    // @ts-expect-error
    if (store.disconnectComponentState) {
      store.disconnectComponentState(this);
    }
    // @ts-expect-error
    if (store.unsubscribeFromKeys) {
      store.unsubscribeFromKeys(["breakpoints"], this.storeSubscriptionCallback);
    }
  }
  render() {
    let breakpoints_jsx = [];
    for (let b of store.get("breakpoints")) {
      // @ts-expect-error ts-migrate(2322) FIXME: Property 'bkpt' does not exist on type 'IntrinsicA... Remove this comment to see the full error message
      breakpoints_jsx.push(<Breakpoint bkpt={b} key={b.number} />);
    }

    if (breakpoints_jsx.length) {
      return breakpoints_jsx;
    } else {
      return <span className="placeholder">no breakpoints</span>;
    }
  }
  static enable_or_disable_bkpt(checked: any, bkpt_num: any) {
    if (typeof bkpt_num === 'string' && bkpt_num.startsWith('frontend_')) {
      let bkpts = store.get("breakpoints");
      for (let b of bkpts) {
        if (b.number === bkpt_num) {
          b.enabled = checked ? "n" : "y";
        }
      }
      store.set("breakpoints", bkpts);
      return;
    }
    if (checked) {
      GdbApi.run_gdb_command([`-break-disable ${bkpt_num}`, GdbApi.get_break_list_cmd()]);
    } else {
      GdbApi.run_gdb_command([`-break-enable ${bkpt_num}`, GdbApi.get_break_list_cmd()]);
    }
  }
  static set_breakpoint_condition(condition: any, bkpt_num: any) {
    if (typeof bkpt_num === 'string' && bkpt_num.startsWith('frontend_')) {
      let bkpts = store.get("breakpoints");
      for (let b of bkpts) {
        if (b.number === bkpt_num) {
          b.cond = condition;
        }
      }
      store.set("breakpoints", bkpts);
      return;
    }
    GdbApi.run_gdb_command([
      `-break-condition ${bkpt_num} ${condition}`,
      GdbApi.get_break_list_cmd()
    ]);
  }
  static remove_breakpoint_if_present(fullname: any, line: any) {
    if (Breakpoints.has_breakpoint(fullname, line)) {
      let number = Breakpoints.get_breakpoint_number(fullname, line);
      Breakpoints.delete_breakpoint(number);
    }
  }
  static add_or_remove_breakpoint(fullname: any, line: any) {
    // 用行號比對（不比對 fullname），因為 import 後和編譯後 fullname 會不同，
    // 若用 fullname 比對會找不到舊斷點，導致同一行出現兩個斷點。
    const bkpts = store.get("breakpoints");
    const existings = bkpts.filter(
      (b: any) => b.line == line && b.is_normal_breakpoint !== false && !b.is_child_breakpoint
    );
    if (existings && existings.length > 0) {
      const gdbOnes = existings.filter((b: any) => !String(b.number).startsWith('frontend_'));
      const frontendOnes = existings.filter((b: any) => String(b.number).startsWith('frontend_'));

      // Remove all matching entries from the store immediately
      const allNums = new Set(existings.map((b: any) => b.number));
      store.set("breakpoints", store.get("breakpoints").filter((b: any) => !allNums.has(b.number)));

      if (gdbOnes.length > 0) {
        // Use GDB's "clear FILE:LINE" to delete ALL breakpoints at this location in one shot.
        // This handles hidden duplicates (e.g., from line-number relocation) that may exist in
        // GDB but are not yet visible in the store.
        const bkptFn: string = gdbOnes[0].fullname || gdbOnes[0].fullname_to_display || fullname;
        const safeFn = bkptFn.replace(/\\/g, '/');
        GdbApi.run_gdb_command([
          `-interpreter-exec console "clear ${safeFn}:${line}"`,
          GdbApi.get_break_list_cmd()
        ]);
      } else if (frontendOnes.length > 0) {
        // All were frontend_* (pre-run state) — already removed from store, nothing in GDB
      }
    } else {
      Breakpoints.add_breakpoint(fullname, line);
    }
  }
  static add_breakpoint(fullname: any, line: any) {
    // 永遠存成 frontend_*，等 Run 編譯完成後再統一送給 GDB，
    // 不在點擊當下立即發送 -break-insert。
    let bkpt = {
      fullname: fullname,
      fullname_to_display: fullname,
      line: line,
      number: `frontend_${Math.random().toString(36).substr(2, 9)}`,
      enabled: "y",
      is_parent_breakpoint: false,
      is_child_breakpoint: false,
      is_normal_breakpoint: true
    };
    Breakpoints.save_breakpoint(bkpt);
  }
  static has_breakpoint(fullname: any, line: any) {
    let bkpts = store.get("breakpoints");
    for (let b of bkpts) {
      if (b.fullname === fullname && b.line == line) {
        return true;
      }
    }
    return false;
  }
  static get_breakpoint_number(fullname: any, line: any) {
    let bkpts = store.get("breakpoints");
    for (let b of bkpts) {
      if (b.fullname === fullname && b.line == line) {
        return b.number;
      }
    }
    console.error(`could not find breakpoint for ${fullname}:${line}`);
  }
  static delete_breakpoint(breakpoint_number: any) {
    if (typeof breakpoint_number === 'string' && breakpoint_number.startsWith('frontend_')) {
      let bkpts = store.get("breakpoints");
      bkpts = bkpts.filter((b: any) => b.number !== breakpoint_number);
      store.set("breakpoints", bkpts);
      return;
    }
    GdbApi.run_gdb_command([
      GdbApi.get_delete_break_cmd(breakpoint_number),
      GdbApi.get_break_list_cmd()
    ]);
  }
  static get_breakpoint_lines_for_file(fullname: any) {
    return store
      .get("breakpoints")
      .filter((b: any) => b.fullname_to_display === fullname && b.enabled === "y")
      .map((b: any) => parseInt(b.line));
  }
  static get_disabled_breakpoint_lines_for_file(fullname: any) {
    return store
      .get("breakpoints")
      .filter((b: any) => b.fullname_to_display === fullname && b.enabled !== "y")
      .map((b: any) => parseInt(b.line));
  }
  static get_conditional_breakpoint_lines_for_file(fullname: any) {
    return store
      .get("breakpoints")
      .filter((b: any) => b.fullname_to_display === fullname && b.cond !== undefined)
      .map((b: any) => parseInt(b.line));
  }
  static save_breakpoints(payload: any) {
    // Preserve frontend_* (user-set editor markers); only replace GDB-confirmed numeric ones
    const existingFrontend = (store.get("breakpoints") || []).filter(
      (b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_')
    );
    store.set("breakpoints", existingFrontend);
    if (payload && payload.BreakpointTable && payload.BreakpointTable.body) {
      // Track locations already seen to detect GDB duplicates caused by line-number relocation.
      // When the user shrinks a program, out-of-bounds breakpoints all relocate to the last line,
      // piling up as separate GDB breakpoints. Deduplicate here and delete the extras from GDB.
      const seenLocations = new Map<string, boolean>();
      const dupNumbers: string[] = [];

      for (let breakpoint of payload.BreakpointTable.body) {
        const num = String(breakpoint.number || "");
        const isFrontend = num.startsWith('frontend_');
        const isChild = !isFrontend && parseFloat(num) !== parseInt(num);
        const isParent = breakpoint.addr === "(MULTIPLE)";
        const isNormal = !isChild && !isParent && !isFrontend;

        if (isNormal) {
          const fn = breakpoint.fullname || (breakpoint["original-location"] || "").split(":")[0] || "";
          const ln = String(breakpoint.line || "");
          const key = `${fn}:${ln}`;
          if (seenLocations.has(key)) {
            dupNumbers.push(num);
            continue; // skip saving; will delete from GDB below
          }
          seenLocations.set(key, true);
        }
        Breakpoints.save_breakpoint(breakpoint);
      }

      if (dupNumbers.length > 0) {
        GdbApi.run_gdb_command(dupNumbers.map((n: string) => GdbApi.get_delete_break_cmd(n)));
      }
    }
  }
  static save_breakpoint(breakpoint: any) {
    let bkpt = Object.assign({}, breakpoint);

    bkpt.is_parent_breakpoint = bkpt.addr === "(MULTIPLE)";

    if (typeof bkpt.number === 'string' && bkpt.number.startsWith('frontend_')) {
      bkpt.is_child_breakpoint = false;
    } else {
      // parent breakpoints have numbers like "5.6", whereas normal breakpoints and parent breakpoints have numbers like "5"
      bkpt.is_child_breakpoint = parseInt(bkpt.number) !== parseFloat(bkpt.number);
    }
    bkpt.is_normal_breakpoint = !bkpt.is_parent_breakpoint && !bkpt.is_child_breakpoint;

    if (bkpt.is_child_breakpoint) {
      bkpt.parent_breakpoint_number = parseInt(bkpt.number);
    }

    if ("fullname" in breakpoint && breakpoint.fullname !== undefined && breakpoint.fullname !== null) {
      // this is a normal/child breakpoint; gdb gives it the fullname
      bkpt.fullname_to_display = breakpoint.fullname;
    } else if ("original-location" in breakpoint && breakpoint["original-location"]) {
      // this breakpoint is the parent breakpoint of multiple other breakpoints. gdb does not give it
      // the fullname field, but rather the "original-location" field.
      // example breakpoint['original-location']: /home/file.h:19
      // so we need to parse out the line number, and store it
      [bkpt.fullname_to_display, bkpt.line] = Util.parse_fullname_and_line(
        breakpoint["original-location"]
      );
    } else {
      bkpt.fullname_to_display = null;
    }

    // add the breakpoint if it's not stored already
    let bkpts = store.get("breakpoints");
    if (bkpts.indexOf(bkpt) === -1) {
      // 同一行只允許一個 normal breakpoint（排除 child breakpoint）
      if (bkpt.is_normal_breakpoint && !bkpt.is_child_breakpoint) {
        const dupIdx = bkpts.findIndex(
          (b: any) => b.line == bkpt.line && b.is_normal_breakpoint && !b.is_child_breakpoint
        );
        if (dupIdx !== -1) {
          bkpts.splice(dupIdx, 1); // 移除舊的，以新的取代
        }
      }
      bkpts.push(bkpt);
      store.set("breakpoints", bkpts);
    }
    return bkpt;
  }
}

export default Breakpoints;
