/**
 * A component to show/hide variable exploration when hovering over a variable
 * in the source code
 */

import React from "react";
import { store } from "statorgfc";

import Breakpoints from "./Breakpoints";
import constants from "./constants";
import Expressions from "./Expressions";
import GdbMiOutput from "./GdbMiOutput";
import InferiorProgramInfo from "./InferiorProgramInfo";
import Locals from "./Locals";
import Memory from "./Memory";
import Registers from "./Registers";
import "../../static/css/reserch.css";
import Visualizer from "./Visualizer";
import ContainerVisualizer from "./ContainerVisualizer";
import UMLVisualizer from "./UMLVisualizer";
import CallGraph from "./CallGraph";
import WatchTable from "./WatchTable";
import MemoryWatch from "./MemoryWatch";
import CompileErrors from "./CompileErrors";
import { layoutSidebar, dragDivider } from "./sidebarLayout";
import { layoutOpenedPanels } from "./sidebarSelection";
import { global_variable } from "./global_variable";
import type { SidebarPanel, SidebarSizing } from "./sidebarLayout";

// Global registry so applyLayout() can open/close collapsers by id
if (!(window as any).gdbgui_collapser_registry) {
  (window as any).gdbgui_collapser_registry = {};
}

const DEFAULT_HEADER_PX = 32;
// 展開面板底部的拖曳條高度（對應 .rowresizer 的 10px）。
const RESIZER_PX = 10;
// 展開面板的內容區最小高度；少於這個就自動收合，見 sidebarLayout.ts。
const MIN_BODY_PX = 80;

let onmouseup_in_parent_callbacks: any[] = [],
  onmousemove_in_parent_callbacks: any[] = [];

let onmouseup_in_parent_callback = function () {
  onmouseup_in_parent_callbacks.map(fn => fn());
};
let onmousemove_in_parent_callback = function (e: any) {
  onmousemove_in_parent_callbacks.map(fn => {
    fn(e);
  });
};

class Collapser extends React.Component<any, any> {
  static defaultProps = { collapsed: true, id: "", primary: false };
  _resizing = false;
  _page_y_orig = 0;
  constructor(props: any) {
    super(props);
    // 執行模式且已勾選：一開始就展開（見 open_on_play）。
    this.state = { collapsed: props.open_on_play && !props.edit_locked ? false : props.collapsed };
    (store as any).connectComponentState(this, ["monaco_line_height"]);
    onmouseup_in_parent_callbacks.push(this.onmouseup_resizer.bind(this));
    onmousemove_in_parent_callbacks.push(this.onmousemove_resizer.bind(this));
  }

  componentDidMount() {
    const id: string = this.props.id;
    if (id) {
      (window as any).gdbgui_collapser_registry[id] = {
        open: () => { if (this.state.collapsed) this.setCollapsed(false); },
        close: () => { if (!this.state.collapsed) this.setCollapsed(true); },
        isOpen: () => !this.state.collapsed,
      };
    }
    this.props.onOpenChange?.(this.props.panel_key, this.isOpen());
  }

  componentDidUpdate(prev: any) {
    const p = this.props;
    // 編輯模式只能勾選、不能展開：進出編輯模式時，把「實際有沒有展開」回報給側欄排版。
    if (prev.edit_locked !== p.edit_locked) this.props.onOpenChange?.(p.panel_key, this.isOpen());
    // 執行時已勾選的面板預設展開（切到執行模式，或勾選設定晚一步載入時）。
    if (p.open_on_play && !p.edit_locked && this.state.collapsed && (prev.edit_locked || !prev.open_on_play)) {
      this.setCollapsed(false);
    }
  }

  isOpen(): boolean {
    return !this.state.collapsed && !this.props.edit_locked;
  }

  componentWillUnmount() {
    const id: string = this.props.id;
    if (id) {
      delete (window as any).gdbgui_collapser_registry[id];
    }
  }

  setCollapsed(collapsed: boolean) {
    this.setState({ collapsed }, () => this.props.onOpenChange?.(this.props.panel_key, this.isOpen()));
  }

  toggle_visibility() {
    if (this.props.edit_locked) return;
    this.setCollapsed(!this.state.collapsed);
  }

  onmousedown_resizer(e: any) {
    this._resizing = true;
    this._page_y_orig = e.pageY;
    this.props.onDividerDragStart?.(this.props.panel_key);
  }
  onmouseup_resizer() {
    this._resizing = false;
  }
  onmousemove_resizer(e: any) {
    if (this._resizing) {
      this.props.onDividerDrag?.(this.props.panel_key, e.pageY - this._page_y_orig);
    }
  }

  render() {
    const collapsed: boolean = this.state.collapsed || !!this.props.forced_collapsed || !!this.props.edit_locked;
    const header_px: number = (this.state as any).monaco_line_height || DEFAULT_HEADER_PX;
    const sel: { checked: boolean; onChange: (v: boolean) => void } | undefined = this.props.selection;

    // 高度由 RightSidebar 依 sidebarLayout 算好傳進來；收合或未量到時交給瀏覽器自然排版。
    let body_style: any = { overflow: "visible" };
    if (!collapsed && this.props.height_px != null) {
      body_style = { height: Math.max(0, this.props.height_px - header_px - RESIZER_PX) + "px", overflow: "auto" };
    }

    let resizer = null;
    if (!collapsed) {
      resizer = (
        <div
          className="rowresizer"
          onMouseDown={this.onmousedown_resizer.bind(this)}
          style={{ textAlign: "right" }}
          title="拖曳以調整高度"
        />
      );
    }

    return (
      <div
        className="collapser"
        style={this.props.hidden ? { display: "none" } : undefined}
        data-panel-key={this.props.panel_key}
      >
        <div
          className={(this.props.edit_locked ? "" : "pointer ") + "titlebar" + (this.props.primary ? " titlebar--primary" : "")}
          onClick={this.toggle_visibility.bind(this)}
          style={{ height: `${header_px}px`, opacity: sel && !sel.checked ? 0.5 : undefined }}
        >
          {sel && (
            <input
              type="checkbox"
              checked={sel.checked}
              aria-label={"在右側欄顯示 " + this.props.title}
              onClick={e => e.stopPropagation()}
              onChange={e => sel.onChange(e.target.checked)}
              style={{ marginRight: "6px" }}
            />
          )}
          <span
            className={`glyphicon glyphicon-chevron-${collapsed ? "right" : "down"}`}
            style={{ marginRight: "6px" }}
          />
          <span className="lighttext">{this.props.title}</span>
          {this.props.forced_collapsed && <span className="sidebar-hint">（空間不足，已自動收合）</span>}
        </div>

        <div
          className={collapsed ? "hidden" : ""}
          id={this.props.id}
          style={body_style}
        >
          {this.props.content}
        </div>

        {resizer}
      </div>
    );
  }
}

type PanelDef = {
  key: string;
  id: string;
  title: string;
  primary?: boolean;
  collapsed?: boolean;
  content: React.ReactNode;
};

class RightSidebar extends React.Component<any, any> {
  _collapsers_node: HTMLDivElement | null = null;
  _drag_base: SidebarPanel[] | null = null;
  _drag_sizing: SidebarSizing | null = null;
  _resize_observer: any = null;

  constructor(props: any) {
    super(props);
    this.state = { total_px: 0, weights: {}, open_map: {}, fixed_px: {} };
    (store as any).connectComponentState(this, ["edit_mode", "sidebar_selection", "sidebar_forced", "monaco_line_height"]);
    this.measure = this.measure.bind(this);
  }

  _layout_key = "";
  onLayoutUpdated = () => {
    // 只有「layout 會開哪些面板」真的變了才重畫，打字時不必每鍵重繪整個側欄。
    const key = layoutOpenedPanels((global_variable as any).__layout).join(",");
    if (key !== this._layout_key) {
      this._layout_key = key;
      this.forceUpdate();
    }
  };

  componentDidMount() {
    window.addEventListener("gdbgui-layout-updated", this.onLayoutUpdated);
    this.onLayoutUpdated();
    this.measure();
    if ((window as any).ResizeObserver && this._collapsers_node) {
      this._resize_observer = new (window as any).ResizeObserver(this.measure);
      this._resize_observer.observe(this._collapsers_node);
    }
    window.addEventListener("resize", this.measure);
  }

  componentWillUnmount() {
    window.removeEventListener("gdbgui-layout-updated", this.onLayoutUpdated);
    this._resize_observer?.disconnect();
    window.removeEventListener("resize", this.measure);
  }

  measure() {
    const h = this._collapsers_node ? this._collapsers_node.clientHeight : 0;
    if (h !== this.state.total_px) this.setState({ total_px: h });
  }

  /** 所有面板定義；gdb mi 輸出只在 debug 模式出現。 */
  panelDefs(): PanelDef[] {
    const defs: PanelDef[] = [
      { key: "compile_errors", id: "compile_errors", title: "編譯錯誤", collapsed: true, content: <CompileErrors /> },
      { key: "memory_watch", id: "memory_watch", title: "記憶體與指標追蹤", content: <MemoryWatch /> },
      { key: "callgraph", id: "callgraph", title: "呼叫歷史圖", content: <CallGraph /> },
      { key: "visualizer", id: "visualizer", title: "程式追蹤表", primary: true, content: <Visualizer /> },
      { key: "container", id: "container", title: "資料結構視覺化", primary: true, collapsed: true, content: <ContainerVisualizer /> },
      { key: "uml_visualizer", id: "uml_visualizer", title: "UML 物件圖", collapsed: !!(window as any).initial_data?.tutorial, content: <UMLVisualizer /> },
      { key: "locals", id: "locals", title: "區域變數", collapsed: true, content: <Locals /> },
      { key: "watch_table", id: "watch_table", title: "教學儀表板", content: <WatchTable /> },
      { key: "breakpoints", id: "", title: "中斷點", collapsed: true, content: <Breakpoints /> },
    ];
    if (this.props.debug) {
      defs.push({ key: "gdb_mi_output", id: "", title: "gdb mi output", content: React.createElement(GdbMiOutput as any, { id: "gdb_mi_output" }) });
    }
    return defs;
  }

  /** 面板是否勾選；沒有勾選設定時一律不勾（執行模式仍走舊行為，見 isHidden；老師第一次勾選才建立設定）。 */
  isChecked(key: string, play = false): boolean {
    const selection = this.state.sidebar_selection;
    // 執行模式：教案 layout 點名開過的面板強制算勾選（編輯模式的 checkbox 只反映老師的勾選）。
    if (play && this.state.sidebar_forced?.[key]) return true;
    return selection ? !!selection[key] : false;
  }

  isOpen(def: PanelDef): boolean {
    const v = this.state.open_map[def.key];
    return v === undefined ? !(def.collapsed ?? true) : v;
  }

  /** 教學頁收合的面板一律隱藏；執行模式下，沒勾的面板隱藏（舊行為：收合的隱藏）。 */
  isHidden(def: PanelDef, play_mode: boolean): boolean {
    const tutorial = !!(window as any).initial_data?.tutorial;
    // 教學頁：收合的面板隱藏，但教案 layout 會開的面板先以收合的標題列露臉，右欄不會一片空白。
    if (tutorial && !this.isOpen(def)) return !layoutOpenedPanels((global_variable as any).__layout).includes(def.key);
    if (!play_mode) return false;
    if (this.state.sidebar_selection) return !this.isChecked(def.key, true);
    return !this.isOpen(def);
  }

  setChecked(key: string, checked: boolean, defs: PanelDef[]) {
    const full: Record<string, boolean> = {};
    defs.forEach(d => { full[d.key] = this.isChecked(d.key); });
    store.set("sidebar_selection", { ...full, [key]: checked });
  }

  sizing(): SidebarSizing {
    const header_px = this.state.monaco_line_height || DEFAULT_HEADER_PX;
    return { total_px: this.state.total_px, header_px, min_open_px: header_px + RESIZER_PX + MIN_BODY_PX };
  }

  onOpenChange = (key: string, open: boolean) => {
    if (this.state.open_map[key] === open) return;
    this.setState((prev: any) => ({ open_map: { ...prev.open_map, [key]: open } }));
  };

  onDividerDragStart = (key: string) => {
    this._legacy_drag = null;
    if (!this.state.sidebar_selection) {
      // 舊行為：拖曳就是把這個面板固定成一個高度，從拖曳開始時的實際高度往下加。
      const node = this._collapsers_node?.querySelector(`[data-panel-key="${key}"]`) as HTMLElement | null;
      this._legacy_drag = { key, start: node ? node.clientHeight : 0 };
      return;
    }
    const shown = this._shownDefs;
    this._drag_sizing = this.sizing();
    this._drag_base = shown.map(d => ({ id: d.key, open: this.isOpen(d), weight: this.state.weights[d.key] || 0 }));
    this._drag_key = key;
  };

  onDividerDrag = (key: string, dy: number) => {
    if (this._legacy_drag && this._legacy_drag.key === key) {
      const h = Math.max(this.sizing().min_open_px, this._legacy_drag.start + dy);
      this.setState((prev: any) => ({ fixed_px: { ...prev.fixed_px, [key]: h } }));
      return;
    }
    if (!this._drag_base || !this._drag_sizing) return;
    const idx = this._drag_base.findIndex(p => p.id === key);
    if (idx < 0) return;
    const next = dragDivider(this._drag_base, this._drag_sizing, idx, dy);
    const weights = { ...this.state.weights };
    next.forEach(p => { weights[p.id] = p.weight; });
    this.setState({ weights });
  };

  _drag_key: string | null = null;
  _shownDefs: PanelDef[] = [];
  _legacy_drag: { key: string; start: number } | null = null;

  render() {
    const play_mode = !this.state.edit_mode;
    const defs = this.panelDefs();
    const legacy = !this.state.sidebar_selection;

    // 真正佔高度的面板：沒被隱藏的那些。
    const shown = defs.filter(d => !this.isHidden(d, play_mode));
    this._shownDefs = shown;

    // 量不到欄高（例如還沒掛載）或舊行為：不做高度分配，交給自然排版。
    const layout = !legacy && this.state.total_px > 0
      ? layoutSidebar(shown.map(d => ({ id: d.key, open: this.isOpen(d), weight: this.state.weights[d.key] || 0 })), this.sizing())
      : null;

    return (
      <div
        className={"content right-sidebar-content" + (legacy ? " sidebar-legacy" : "")}
        onMouseUp={onmouseup_in_parent_callback}
        onMouseMove={onmousemove_in_parent_callback}
      >
        {/*
          即時課堂面板的掛載點。面板本身由 SourceCode 用 createPortal 畫進來——
          它需要的 props（lessonId、prepareVersion、onSessionEnded…）全是 SourceCode
          的方法，把那些狀態往上提到側欄只會讓兩邊都變複雜；portal 讓擁有權留在原處。
        */}
        <div id="live-quiz-slot" className="live-quiz-slot-flex" />

        <div
          className="sidebar-collapsers"
          ref={n => (this._collapsers_node = n)}
        >
          {defs.map(d => {
            const dropped = !!layout?.dropped.includes(d.key);
            const open = this.isOpen(d);
            const height_px = layout
              ? (open && !dropped ? layout.heights[d.key] : undefined)
              : (legacy && open ? this.state.fixed_px[d.key] : undefined);
            return (
              <Collapser
                key={d.key}
                panel_key={d.key}
                id={d.id}
                title={d.title}
                primary={d.primary}
                collapsed={d.collapsed ?? true}
                play_mode={play_mode}
                hidden={this.isHidden(d, play_mode)}
                forced_collapsed={dropped}
                edit_locked={!play_mode}
                open_on_play={!legacy && this.isChecked(d.key, true) && !(window as any).initial_data?.tutorial}
                height_px={height_px}
                content={d.content}
                selection={play_mode ? undefined : { checked: this.isChecked(d.key), onChange: (v: boolean) => this.setChecked(d.key, v, defs) }}
                onOpenChange={this.onOpenChange}
                onDividerDragStart={this.onDividerDragStart}
                onDividerDrag={this.onDividerDrag}
              />
            );
          })}
          <div id="grid-container"></div>
        </div>
      </div>
    );
  }

  componentDidUpdate() {
    // 面板數或收合狀態變了，欄高可能要重量。
    this.measure();
  }
}
export default RightSidebar;
