/**
 * A component to show/hide variable exploration when hovering over a variable
 * in the source code
 */

import React from "react";

import Breakpoints from "./Breakpoints";
import constants from "./constants";
import Expressions from "./Expressions";
import GdbMiOutput from "./GdbMiOutput";
import InferiorProgramInfo from "./InferiorProgramInfo";
import Locals from "./Locals";
import Memory from "./Memory";
import Registers from "./Registers";
import ToolTipTourguide from "./ToolTipTourguide";
import "../../static/css/reserch.css";
import Visualizer from "./Visualizer";
import ContainerVisualizer from "./ContainerVisualizer";
import CallGraph from "./CallGraph";
import WatchTable from "./WatchTable";
import MemoryWatch from "./MemoryWatch";


// Global registry so applyLayout() can open/close collapsers by id
if (!(window as any).gdbgui_collapser_registry) {
  (window as any).gdbgui_collapser_registry = {};
}

let onmouseup_in_parent_callbacks: any = [],
  onmousemove_in_parent_callbacks: any = [];

let onmouseup_in_parent_callback = function () {
  // @ts-expect-error ts-migrate(7006) FIXME: Parameter 'fn' implicitly has an 'any' type.
  onmouseup_in_parent_callbacks.map(fn => fn());
};
let onmousemove_in_parent_callback = function (e: any) {
  // @ts-expect-error ts-migrate(7006) FIXME: Parameter 'fn' implicitly has an 'any' type.
  onmousemove_in_parent_callbacks.map(fn => {
    fn(e);
  });
};

type OwnCollapserState = any;

type CollapserState = OwnCollapserState & typeof Collapser.defaultProps;

class Collapser extends React.Component<{}, CollapserState> {
  static defaultProps = { collapsed: true, id: "" };
  _height_when_clicked: any;
  _page_y_orig: any;
  _resizing: any;
  collapser_box_node: any;
  constructor(props: {}) {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    this.state = {
      // @ts-expect-error ts-migrate(2339) FIXME: Property 'collapsed' does not exist on type '{}'.
      collapsed: props.collapsed,
      autosize: true,
      height_px: null, // if an integer, force height to this value
      _mouse_y_click_pos_px: null,
      _height_when_clicked: null
    };
    this.onmousedown_resizer = this.onmousedown_resizer.bind(this);
    this.onmouseup_resizer = this.onmouseup_resizer.bind(this);
    this.onmousemove_resizer = this.onmousemove_resizer.bind(this);
    this.onclick_restore_autosize = this.onclick_restore_autosize.bind(this);

    onmouseup_in_parent_callbacks.push(this.onmouseup_resizer.bind(this));
    onmousemove_in_parent_callbacks.push(this.onmousemove_resizer.bind(this));
  }
  componentDidMount() {
    // @ts-expect-error ts-migrate(2339)
    const id: string = this.props.id;
    if (id) {
      (window as any).gdbgui_collapser_registry[id] = {
        open:  () => { if (this.state.collapsed)  this.setState({ collapsed: false }); },
        close: () => { if (!this.state.collapsed) this.setState({ collapsed: true  }); },
      };
    }
  }

  componentWillUnmount() {
    // @ts-expect-error ts-migrate(2339)
    const id: string = this.props.id;
    if (id) {
      delete (window as any).gdbgui_collapser_registry[id];
    }
  }

  toggle_visibility() {
    this.setState({ collapsed: !this.state.collapsed });
  }
  onmousedown_resizer(e: any) {
    this._resizing = true;
    this._page_y_orig = e.pageY;
    this._height_when_clicked = this.collapser_box_node.clientHeight;
  }
  onmouseup_resizer() {
    this._resizing = false;
  }
  onmousemove_resizer(e: any) {
    if (this._resizing) {
      let dh = e.pageY - this._page_y_orig;
      this.setState({
        height_px: this._height_when_clicked + dh,
        autosize: false
      });
    }
  }
  onclick_restore_autosize() {
    this.setState({ autosize: true });
  }
  render() {
    let style = {
      height: this.state.autosize ? "auto" : this.state.height_px + "px",
      overflow: this.state.autosize ? "visible" : "auto"
    };

    let reset_size_button = "";
    if (!this.state.autosize) {
      // @ts-expect-error ts-migrate(2322) FIXME: Type 'Element' is not assignable to type 'string'.
      reset_size_button = (
        <span
          onClick={this.onclick_restore_autosize}
          className="placeholder"
          title={
            "Height frozen at " + this.state.height_px + "px. Click to restore autosize."
          }
          style={{
            // @ts-expect-error ts-migrate(2322) FIXME: Object literal may only specify known properties, ... Remove this comment to see the full error message
            align: "right",
            position: "relative",
            top: "-10px",
            cursor: "pointer"
          }}
        >
          reset height
        </span>
      );
    }

    let resizer = "";
    if (!this.state.collapsed) {
      // @ts-expect-error ts-migrate(2322) FIXME: Type 'Element' is not assignable to type 'string'.
      resizer = (
        <React.Fragment>
          <div
            className="rowresizer"
            onMouseDown={this.onmousedown_resizer}
            style={{ textAlign: "right" }}
            title="Click and drag to resize height"
          >
            {" "}
            {reset_size_button}
          </div>
        </React.Fragment>
      );
    }

    return (
      <div className="collapser">
        <div className="pointer titlebar" onClick={this.toggle_visibility.bind(this)}>
          <span
            className={`glyphicon glyphicon-chevron-${
              this.state.collapsed ? "right" : "down"
              }`}
            style={{ marginRight: "6px" }}
          />
          {/* @ts-expect-error ts-migrate(2339) FIXME: Property 'title' does not exist on type 'Readonly<... Remove this comment to see the full error message */}
          <span className="lighttext">{this.props.title}</span>
        </div>

        <div
          className={this.state.collapsed ? "hidden" : ""}
          // @ts-expect-error ts-migrate(2339) FIXME: Property 'id' does not exist on type 'Readonly<{}>... Remove this comment to see the full error message
          id={this.props.id}
          style={style}
          ref={n => (this.collapser_box_node = n)}
        >
          {/* @ts-expect-error ts-migrate(2339) FIXME: Property 'content' does not exist on type 'Readonl... Remove this comment to see the full error message */}
          {this.props.content}
        </div>

        {resizer}
      </div>
    );
  }
}

class RightSidebar extends React.Component {
  render() {
    let input_style = {
      display: "inline",
      width: "100px",
      padding: "6px 6px",
      height: "25px",
      fontSize: "1em"
    },
      mi_output = "";
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'debug' does not exist on type 'Readonly<... Remove this comment to see the full error message
    if (this.props.debug) {
      // @ts-expect-error ts-migrate(2322) FIXME: Type 'Element' is not assignable to type 'string'.
      mi_output = (
        // @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message
        <Collapser title="gdb mi output" content={<GdbMiOutput id="gdb_mi_output" />} />
      );
    }

    return (
      <div
        className="content"
        onMouseUp={onmouseup_in_parent_callback}
        onMouseMove={onmousemove_in_parent_callback}
      >
        <ToolTipTourguide
          // @ts-expect-error ts-migrate(2322) FIXME: Property 'position' does not exist on type 'Intrin... Remove this comment to see the full error message
          position={"topleft"}
          content={
            <div>
              <h5>
                This sidebar contains a visual, interactive representation of the state of
                your program
              </h5>
              <p>
                You can see which function the process is stopped in, explore variables,
                and much more.
              </p>
              <p>
                There is more to discover, but this should be enough to get you started.
              </p>
              <p>
                Something missing? Found a bug?{" "}
                <a href="https://github.com/cs01/gdbgui/issues/">Create an issue</a> on
                github.
              </p>

              <p>Happy debugging!</p>
            </div>
          }
          step_num={5}
        />

        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="memory_watch" title="記憶體與指標追蹤 (Memory Watch)" content={<MemoryWatch />} />

        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="callgraph" title="call graph (歷史呼叫圖)" content={<CallGraph />} />
        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="visualizer" title="visualizer" content={<Visualizer />} />
        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="container" title="container" content={<ContainerVisualizer />} />

        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="locals" title="local variables" collapsed={true} content={<Locals />} />
        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser id="watch_table" title="teaching dashboard (table)" content={<WatchTable />} />
        {/* @ts-expect-error ts-migrate(2322) FIXME: Property 'title' does not exist on type 'Intrinsic... Remove this comment to see the full error message */}
        <Collapser title="breakpoints" collapsed={true} content={<Breakpoints />} />

        <div id="grid-container"></div>
        {mi_output}
      </div>
    );
  }

  componentDidMount() {
    // Tree module is removed, no longer need to init
  }
}
export default RightSidebar;
