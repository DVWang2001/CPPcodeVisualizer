/**
 * A component to render source code, assembly, and break points
 */

import { store } from "statorgfc";
import React from "react";
import MonacoEditor from "@monaco-editor/react";
import FileOps from "./FileOps";
import Breakpoints from "./Breakpoints";
import Memory from "./Memory";
import MemoryLink from "./MemoryLink";
import constants from "./constants";
import Actions from "./Actions";
import { global_variable } from "./global_variable";
import VisualizerHelper from "./VisualizerHelper";
import GdbApi from "./GdbApi";

type State = any;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class SourceCode extends React.Component<{}, State> {
  static el_code_container = null; // todo: no jquery
  static el_code_container_node = null;
  static code_container_node = null;
  static view_more_top_node = null;
  static view_more_bottom_node = null;

  private initialFullname: string | null = null;

  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    let savedInputValues = {};
    let savedTtsValues = {};
    // Previously loaded globally, now loaded dynamically in componentDidUpdate per file 

    this.state = {
      inputValues: savedInputValues,
      ttsValues: savedTtsValues,
      layoutValues: {} as any,
      splitPos: -1, // -1 means uninitialized/auto
      isDragging: false,
      lineCount: 0,
      hoverLine: null as number | null,
      dragLines: [] as number[],        // 正在拖曳的行（已排序）
      dragOverLine: null as number | null,
      selectedLines: [] as number[],    // Ctrl/Shift 選中的行
      lastClickedLine: null as number | null, // Shift 選取的錨點
      lineEditorModal: null as null | {
        lineNum: number;
        activeTab: 'guide' | 'tts' | 'layout';
        draftGuide: string;
        draftTtsSpeed: string;
        draftTtsContinue: boolean;
        draftTtsText: string;
        draftLayoutSidebar: string;
        draftLayoutOpen: string;
        draftLayoutClose: string;
        draftLayoutMaze: string;
      },
    };
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, [
      "fullname_to_render",
      "cached_source_files",
      "missing_files",
      "disassembly_for_missing_file",
      "line_of_source_to_flash",
      "paused_on_frame",
      "breakpoints",
      "source_code_state",
      "make_current_line_visible",
      "source_code_selection_state",
      "current_theme",
      "inferior_binary_path",
      "source_linenum_to_display_start",
      "source_linenum_to_display_end",
      "max_lines_of_code_to_fetch",
      "source_code_infinite_scrolling",
      "tts_subtitle",
      "edit_mode",
      "inferior_program",
      "compile_errors",
      "user_source_fullname",
    ]);

    // bind methods
    this.get_body_assembly_only = this.get_body_assembly_only.bind(this);
    this._get_source_line = this._get_source_line.bind(this);
    this._get_assm_row = this._get_assm_row.bind(this);
    this.click_gutter = this.click_gutter.bind(this);
    this.is_gdb_paused_on_this_line = this.is_gdb_paused_on_this_line.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleTtsChange = this.handleTtsChange.bind(this);
    this.handleLayoutChange = this.handleLayoutChange.bind(this);
  }

  componentDidMount() {
    // 優先從 autosave JSON 還原（最可靠，格式同 Export JSON）
    try {
      const _as = JSON.parse(localStorage.getItem("gdbgui_autosave") || "null");
      if (_as && _as.version && _as.line_data && Object.keys(_as.line_data).length > 0) {
        const newInputs: any = {};
        const newTts: any = {};
        const newLayout: any = {};
        for (const [line, data] of Object.entries(_as.line_data as any)) {
          const d = data as any;
          if (d.guide) newInputs[line] = d.guide;
          if (d.tts) newTts[line] = d.tts;
          if (d.layout) newLayout[line] = d.layout;
        }
        this.setState({ inputValues: newInputs, ttsValues: newTts, layoutValues: newLayout });
        (global_variable as any).__line = { ...newInputs };
        (global_variable as any).__tts = { ...newTts };
        (global_variable as any).__layout = { ...newLayout };
        window.addEventListener("beforeunload", this.saveAutosave);
        return;
      }
    } catch (_) {}

    // Fallback：沒有 autosave 時，從分散的 localStorage key 讀取
    const fn = this.state.fullname_to_render
      || localStorage.getItem("gdbgui_last_edited_filename")
      || "";

    if (fn && fn !== "__pending__") {
      let newInputs = {};
      let newTts = {};
      let newLayout = {};

      let sourceFn = fn;
      const hasCurrentCode = !!localStorage.getItem("gdbgui_editor_code_" + fn);
      if (!hasCurrentCode) {
        const lastFn = localStorage.getItem("gdbgui_last_edited_filename");
        if (lastFn && lastFn !== "__pending__" && lastFn !== fn && localStorage.getItem("gdbgui_editor_code_" + lastFn)) {
          sourceFn = lastFn;
        }
      }

      try {
        const storedInputs = localStorage.getItem("gdbgui_guide_inputs_" + sourceFn);
        if (storedInputs) newInputs = JSON.parse(storedInputs);
        const storedTts = localStorage.getItem("gdbgui_tts_inputs_" + sourceFn);
        if (storedTts) newTts = JSON.parse(storedTts);
        const storedLayout = localStorage.getItem("gdbgui_layout_inputs_" + sourceFn);
        if (storedLayout) newLayout = JSON.parse(storedLayout);
      } catch (e) {
        console.error("Failed to load initial project state", e);
      }
      this.setState({ inputValues: newInputs, ttsValues: newTts, layoutValues: newLayout });
      (global_variable as any).__line = { ...newInputs };
      (global_variable as any).__tts = { ...newTts };
      (global_variable as any).__layout = { ...newLayout };
    }

    window.addEventListener("beforeunload", this.saveAutosave);
  }

  editorInstance: any = null;
  monaco: any = null;
  decorations: any[] = [];
  _programmaticEdit: boolean = false;
  _autosaveTimer: any = null;

  componentWillUnmount() {
    window.removeEventListener("beforeunload", this.saveAutosave);
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
  }

  saveAutosave = () => {
    try {
      const source_code = this.editorInstance?.getValue?.() || "";
      if (!source_code.trim()) {
        // Editor is in a transient empty state (e.g. right after run/exit toggles edit_mode).
        // Don't overwrite the full autosave, but patch the breakpoints + fullname so they
        // survive an F5 reload even when the source text is momentarily unavailable.
        try {
          const raw = localStorage.getItem("gdbgui_autosave");
          if (raw) {
            const existingAs = JSON.parse(raw);
            if (existingAs && existingAs.version) {
              existingAs.breakpoints = store.get("breakpoints") || [];
              existingAs.fullname_to_render =
                this.state.fullname_to_render ||
                existingAs.fullname_to_render ||
                "";
              localStorage.setItem("gdbgui_autosave", JSON.stringify(existingAs));
            }
          }
        } catch (_) {}
        return;
      }

      const inputValues = this.state.inputValues || {};
      const ttsValues = this.state.ttsValues || {};
      const layoutValues = (global_variable as any).__layout || this.state.layoutValues || {};

      const line_data: any = {};
      new Set([...Object.keys(inputValues), ...Object.keys(ttsValues), ...Object.keys(layoutValues)])
        .forEach(line => {
          if (inputValues[line] || ttsValues[line] || layoutValues[line]) {
            line_data[line] = {
              guide: inputValues[line] || "",
              tts: ttsValues[line] || "",
              ...(layoutValues[line] ? { layout: layoutValues[line] } : {}),
            };
          }
        });

      localStorage.setItem("gdbgui_autosave", JSON.stringify({
        version: "1.0",
        fullname_to_render: this.state.fullname_to_render || "",
        source_code,
        line_data,
        breakpoints: store.get("breakpoints") || [],
        program_input: store.get("program_input") || "",
      }));
    } catch (_) {}
  };

  _debouncedSaveAutosave = () => {
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(this.saveAutosave, 800);
  };
  inputContainerRef: React.RefObject<HTMLDivElement> = React.createRef();
  layoutContainerRef: React.RefObject<HTMLDivElement> = React.createRef();
  dragHandleContainerRef: React.RefObject<HTMLDivElement> = React.createRef();
  containerRef: React.RefObject<HTMLDivElement> = React.createRef();
  fileInputRef: React.RefObject<HTMLInputElement> = React.createRef();

  ttsWidget: any = null;
  ttsTimeout: any = null;

  showTtsBubble() {
    if (!this.state.tts_subtitle) return;

    // 清除舊的 ContentWidget（相容舊版殘留）
    if (this.ttsWidget && this.editorInstance) {
      this.editorInstance.removeContentWidget(this.ttsWidget);
      this.ttsWidget = null;
    }
    if (this.ttsTimeout) { clearTimeout(this.ttsTimeout); this.ttsTimeout = null; }

    // TTS 結束時清除字幕 state，React 會自動隱藏字幕列
    const clearSubtitle = () => {
      store.set("tts_subtitle", null);
      if (this.ttsTimeout) { clearTimeout(this.ttsTimeout); this.ttsTimeout = null; }
      (window as any).gdbgui_on_tts_end = null;
    };

    (window as any).gdbgui_on_tts_end = clearSubtitle;
    // 依據需求：完全依賴 TTS 音訊播放完畢的 onended/onerror 回呼事件清除字幕，不設定固定計時器自動消失
  }

  handleEditorDidMount = (_getValue: any, editor: any) => {
    this.editorInstance = editor;
    this.monaco = (window as any).monaco;
    // Expose editor content getter for GdbApi to use
    (window as any).gdbgui_get_editor_value = () => this.editorInstance.getValue();
    (window as any).gdbgui_get_editor_filename = () => this.state.fullname_to_render;
    // Navigate to a compile error line and set cursor
    (window as any).gdbgui_navigate_to_error = (line: number, col: number) => {
      if (!this.editorInstance) return;
      this.editorInstance.revealLineInCenter(line);
      this.editorInstance.setPosition({ lineNumber: line, column: col || 1 });
      this.editorInstance.focus();
    };
    // 不在這裡設 last_compiled_code：
    // 只有 GdbApi 成功編譯後才設，確保 "code unchanged" 判斷對應的是真正跑過的 binary，
    // 而不是 editor 的初始顯示值（可能來自 localStorage，與現有 binary 不一致）。
    this.updateDecorations();

    // 若 editor 掛載前已有 tts_subtitle（第一次 TTS 時 editor 尚未 ready），補顯字幕
    if (this.state.tts_subtitle) {
      setTimeout(() => this.showTtsBubble(), 100);
    }

    // Sync scroll
    editor.onDidScrollChange((e: any) => {
      if (this.inputContainerRef.current) {
        this.inputContainerRef.current.scrollTop = e.scrollTop;
      }
      if (this.layoutContainerRef.current) {
        this.layoutContainerRef.current.scrollTop = e.scrollTop;
      }
      if (this.dragHandleContainerRef.current) {
        this.dragHandleContainerRef.current.scrollTop = e.scrollTop;
      }
    });

    // Persist source text for Visualizer (survives code_body view switches)
    const syncSourceText = () => {
      try { (global_variable as any).__source_text = editor.getValue(); } catch (_) {}
    };
    syncSourceText();
    editor.onDidChangeModelContent(syncSourceText);

    // Dynamic line count sync
    const updateLineCount = () => {
      const model = editor.getModel();
      if (model) {
        const newLineCount = model.getLineCount();
        if (newLineCount !== this.state.lineCount) {
          this.setState({ lineCount: newLineCount });
        }
      }
    };
    // Initial set
    updateLineCount();

    // 當程式碼行數增減時，自動 shift guide/TTS/layout 輸入框，保持對齊
    const shiftGuideOnLineChange = (changes: any[]) => {
      // 若是 moveMultipleLines 觸發的程式化編輯，跳過（避免雙重處理）
      if (this._programmaticEdit) {
        this._programmaticEdit = false;
        return;
      }
      // Monaco changes 是由上到下排列，需倒序處理避免偏移累積
      const sortedChanges = [...changes].sort(
        (a, b) => b.range.startLineNumber - a.range.startLineNumber
      );
      let newInputValues = { ...this.state.inputValues };
      let newTtsValues   = { ...this.state.ttsValues };
      let newLayoutValues = { ...this.state.layoutValues };
      let anyChange = false;

      for (const change of sortedChanges) {
        const startLine = change.range.startLineNumber;
        const removedLines = change.range.endLineNumber - change.range.startLineNumber;
        const addedLines = (change.text.match(/\n/g) || []).length;
        const delta = addedLines - removedLines;
        if (delta === 0) continue;
        anyChange = true;

        console.log(`[shift] startLine=${startLine} delta=${delta} removedLines=${removedLines} addedLines=${addedLines}`);
        console.log(`[shift] inputValues BEFORE:`, JSON.stringify(newInputValues));
        if (delta > 0) {
          // 插入行：從最後一行往下，把 >= startLine+1 的內容往後移 delta 格
          const maxLine = Math.max(...[
            ...Object.keys(newInputValues),
            ...Object.keys(newTtsValues),
            ...Object.keys(newLayoutValues),
          ].map(Number).filter(n => !isNaN(n)), startLine);

          for (let line = maxLine; line >= startLine + 1; line--) {
            const g = newInputValues[line];
            const t = newTtsValues[line];
            const l = newLayoutValues[line];
            if (g !== undefined) { newInputValues[line + delta] = g; delete newInputValues[line]; }
            if (t !== undefined) { newTtsValues[line + delta]   = t; delete newTtsValues[line]; }
            if (l !== undefined) { newLayoutValues[line + delta] = l; delete newLayoutValues[line]; }
          }
          // 新插入的行明確設為空字串
          for (let newLine = startLine + 1; newLine <= startLine + delta; newLine++) {
            newInputValues[newLine] = "";
            newTtsValues[newLine]   = "";
            newLayoutValues[newLine] = "";
          }
          console.log(`[shift] inputValues AFTER:`, JSON.stringify(newInputValues));
        } else {
          // 刪除行：移除 [startLine+1, startLine-delta] 範圍內的內容，再把後面的往前移
          const deleteEnd = startLine - delta; // delta < 0，所以 -delta > 0
          for (let line = startLine + 1; line <= deleteEnd; line++) {
            delete newInputValues[line];
            delete newTtsValues[line];
            delete newLayoutValues[line];
          }
          const maxLine = Math.max(...[
            ...Object.keys(newInputValues),
            ...Object.keys(newTtsValues),
            ...Object.keys(newLayoutValues),
          ].map(Number).filter(n => !isNaN(n)), deleteEnd);
          for (let line = deleteEnd + 1; line <= maxLine; line++) {
            const g = newInputValues[line];
            const t = newTtsValues[line];
            const l = newLayoutValues[line];
            if (g !== undefined) { newInputValues[line + delta] = g; delete newInputValues[line]; }
            if (t !== undefined) { newTtsValues[line + delta]   = t; delete newTtsValues[line]; }
            if (l !== undefined) { newLayoutValues[line + delta] = l; delete newLayoutValues[line]; }
          }
        }
      }

      if (!anyChange) return;

      // 斷點行號 shift（只更新 store 的前端表示，不重新呼叫 GDB）
      const currentFile = this.state.fullname_to_render;
      if (currentFile) {
        const bkpts: any[] = store.get("breakpoints");
        let bkptsChanged = false;
        const newBkpts = bkpts.map((b: any) => {
          if (b.fullname_to_display !== currentFile) return b;
          const bLine = parseInt(b.line);
          if (isNaN(bLine)) return b;
          // 套用每個 change 的 delta
          let shifted = bLine;
          for (const change of sortedChanges) {
            const startLine = change.range.startLineNumber;
            const removedLines = change.range.endLineNumber - change.range.startLineNumber;
            const addedLines = (change.text.match(/\n/g) || []).length;
            const delta = addedLines - removedLines;
            if (delta === 0) continue;
            if (shifted > startLine) {
              shifted += delta;
              bkptsChanged = true;
            }
          }
          if (shifted === bLine) return b;
          return { ...b, line: String(shifted), original_location: b.original_location?.replace(`:${bLine}`, `:${shifted}`) };
        });
        if (bkptsChanged) store.set("breakpoints", newBkpts);
      }

      // 更新 state、localStorage、global_variable
      this.setState({ inputValues: newInputValues, ttsValues: newTtsValues, layoutValues: newLayoutValues });
      const fn = this.state.fullname_to_render || "default";
      localStorage.setItem("gdbgui_guide_inputs_" + fn, JSON.stringify(newInputValues));
      localStorage.setItem("gdbgui_tts_inputs_"   + fn, JSON.stringify(newTtsValues));
      localStorage.setItem("gdbgui_layout_inputs_" + fn, JSON.stringify(newLayoutValues));

      if (!('__line' in global_variable)) (global_variable as any).__line = {};
      if (!('__tts'  in global_variable)) (global_variable as any).__tts  = {};
      if (!('__layout' in global_variable)) (global_variable as any).__layout = {};
      (global_variable as any).__line   = { ...newInputValues };
      (global_variable as any).__tts    = { ...newTtsValues };
      (global_variable as any).__layout = { ...newLayoutValues };
    };

    // Listen for changes
    let saveTimeout: any;
    editor.onDidChangeModelContent((e: any) => {
      shiftGuideOnLineChange(e.changes);
      updateLineCount();
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        if (this.editorInstance && this.state.fullname_to_render) {
          const fn = this.state.fullname_to_render;
          localStorage.setItem("gdbgui_editor_code_" + fn, this.editorInstance.getValue());
          localStorage.setItem("gdbgui_editor_filename_" + fn, fn);
          localStorage.setItem("gdbgui_last_edited_filename", fn);
        }
      }, 500);
    });

    // Auto-size split position to 50%
    setTimeout(() => {
      if (this.containerRef.current) {
        // Default to 50% of container width
        const halfWidth = this.containerRef.current.clientWidth / 2;
        this.setState({ splitPos: halfWidth });
      }
    }, 100);

    // In v3 we might need to listen to mouse events differently or it works the same on editor instance
    editor.onMouseDown((e: any) => {
      if (this.monaco && e.target.position) {
        const t = e.target.type;
        const M = this.monaco.editor.MouseTargetType;
        // 允許點擊 glyph margin 或行號區域都能切換斷點
        if (t === M.GUTTER_GLYPH_MARGIN || t === M.GUTTER_LINE_NUMBERS || t === M.GUTTER_LINE_DECORATIONS) {
          const lineNum = e.target.position.lineNumber;
          this.click_gutter(lineNum);
        }
      }
    });

    editor.onMouseMove((e: any) => {
      if (this.monaco && e.target.position) {
        const t = e.target.type;
        const M = this.monaco.editor.MouseTargetType;
        if (t === M.GUTTER_GLYPH_MARGIN || t === M.GUTTER_LINE_NUMBERS || t === M.GUTTER_LINE_DECORATIONS) {
          const lineNum = e.target.position.lineNumber;
          if (this.state.hoverLine !== lineNum) {
            this.setState({ hoverLine: lineNum });
          }
          return;
        }
      }
      if (this.state.hoverLine !== null) {
        this.setState({ hoverLine: null });
      }
    });

    editor.onMouseLeave(() => {
      if (this.state.hoverLine !== null) {
        this.setState({ hoverLine: null });
      }
    });
  };

  startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    this.setState({ isDragging: true });
    document.addEventListener('mousemove', this.doDrag);
    document.addEventListener('mouseup', this.stopDrag);

    // Overlay iframe protection if needed? No iframes here.
  };

  doDrag = (e: MouseEvent) => {
    if (this.containerRef.current) {
      const rect = this.containerRef.current.getBoundingClientRect();
      let newSplit = e.clientX - rect.left;

      // Min/Max constraints
      if (newSplit < 100) newSplit = 100;
      if (newSplit > rect.width - 50) newSplit = rect.width - 50;

      this.setState({ splitPos: newSplit });
      // Layout monaco
      if (this.editorInstance) this.editorInstance.layout();
    }
  };

  stopDrag = () => {
    this.setState({ isDragging: false });
    document.removeEventListener('mousemove', this.doDrag);
    document.removeEventListener('mouseup', this.stopDrag);
  };

  updateDecorations = () => {
    if (!this.editorInstance || !this.monaco) return;
    try {
      this._updateDecorationsImpl();
    } catch (e) {
      console.warn("[updateDecorations] caught error:", e);
    }
  };

  _updateDecorationsImpl = () => {
    if (!this.editorInstance || !this.monaco) return;

    const { paused_on_frame, fullname_to_render } = this.state;
    // Normalize null → "" so post-F5 breakpoints (fullname_to_display="") are found
    const effectiveFTR = fullname_to_render || "";

    const bkpt_lines = Breakpoints.get_breakpoint_lines_for_file(effectiveFTR) || [];
    const disabled_bkpt_lines = Breakpoints.get_disabled_breakpoint_lines_for_file(effectiveFTR) || [];
    const conditional_bkpt_lines = Breakpoints.get_conditional_breakpoint_lines_for_file(effectiveFTR) || [];

    const newDecorations: any[] = [];

    // Current execution line
    if (paused_on_frame && paused_on_frame.fullname === fullname_to_render) {
      const line = parseInt(paused_on_frame.line);
      newDecorations.push({
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "paused_on_line",
          glyphMarginClassName: "fas fa-arrow-right"
        },
      });
      // Scroll Monaco to the current line if make_current_line_visible is true
      if (this.state.make_current_line_visible) {
        this.editorInstance.revealLineInCenter(line);
      }
    }

    // Breakpoints
    bkpt_lines.forEach((line: any) => {
      newDecorations.push({
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "monaco-breakpoint",
        },
      });
    });

    // Disabled Breakpoints
    disabled_bkpt_lines.forEach((line: any) => {
      newDecorations.push({
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "monaco-disabled-breakpoint",
        },
      });
    });

    // Conditional Breakpoints
    conditional_bkpt_lines.forEach((line: any) => {
      newDecorations.push({
        range: new this.monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "monaco-conditional-breakpoint",
        },
      });
    });

    // Hover Hint
    const { hoverLine } = this.state;
    if (hoverLine !== null) {
      const hasAnyBkpt = bkpt_lines.includes(hoverLine) || 
                         disabled_bkpt_lines.includes(hoverLine) || 
                         conditional_bkpt_lines.includes(hoverLine);
      if (!hasAnyBkpt) {
        newDecorations.push({
          range: new this.monaco.Range(hoverLine, 1, hoverLine, 1),
          options: {
            glyphMarginClassName: "monaco-breakpoint-hover",
          },
        });
      }
    }

    // Compile error/warning decorations and markers
    const compileErrors: any[] = store.get("compile_errors") || [];
    const model = this.editorInstance.getModel();
    const totalLines = model ? model.getLineCount() : 0;

    // Only include errors whose line is within the current model (code may have changed since last compile)
    const validErrors = compileErrors.filter(
      (err: any) => typeof err.line === "number" && err.line >= 1 && err.line <= totalLines
    );

    // Whole-line background decorations
    validErrors.forEach((err: any) => {
      if (err.severity === "error") {
        newDecorations.push({
          range: new this.monaco.Range(err.line, 1, err.line, 1),
          options: { isWholeLine: true, className: "monaco-compile-error-line" },
        });
      } else if (err.severity === "warning") {
        newDecorations.push({
          range: new this.monaco.Range(err.line, 1, err.line, 1),
          options: { isWholeLine: true, className: "monaco-compile-warning-line" },
        });
      }
    });

    this.decorations = this.editorInstance.deltaDecorations(this.decorations, newDecorations);

    // Monaco model markers — squiggly underlines, hover tooltips, overview ruler indicators
    if (model) {
      try {
        const markers = validErrors.map((err: any) => ({
          severity: err.severity === "error"
            ? this.monaco.MarkerSeverity.Error
            : err.severity === "warning"
            ? this.monaco.MarkerSeverity.Warning
            : this.monaco.MarkerSeverity.Info,
          startLineNumber: err.line,
          startColumn: Math.max(1, err.col || 1),
          endLineNumber: err.line,
          endColumn: model.getLineMaxColumn(err.line),
          message: err.message,
          source: "GCC",
        }));
        this.monaco.editor.setModelMarkers(model, "gcc", markers);
      } catch (e) {
        // Ignore marker errors (e.g., model replaced between calls)
        this.monaco.editor.setModelMarkers(model, "gcc", []);
      }
    }
  };

  get_monaco_value(source_code_obj: any, num_lines: any) {
    const defaultTemplate = `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}\n`;
    const fn = this.state.fullname_to_render;
    const isDefaultFile = !!(fn && fn.includes("default_hello_"));

    if (fn) {
        const savedCode = localStorage.getItem("gdbgui_editor_code_" + fn);
        const savedFilename = localStorage.getItem("gdbgui_editor_filename_" + fn);
        if (savedCode !== null && savedFilename === fn) {
            return savedCode;
        }
        // Fallback: server 可能派了新的 default_hello_*.cpp，
        // 但使用者上次的程式碼存在另一個 key 裡。
        // 找到最後一次編輯的 filename，把那份程式碼搬過來並回傳。
        const lastFn = localStorage.getItem("gdbgui_last_edited_filename");
        if (lastFn && lastFn !== fn) {
            const lastCode = localStorage.getItem("gdbgui_editor_code_" + lastFn);
            if (lastCode && lastCode.trim()) {
                // 同步到新的 filename key，讓之後的查詢直接命中
                localStorage.setItem("gdbgui_editor_code_" + fn, lastCode);
                localStorage.setItem("gdbgui_editor_filename_" + fn, fn);
                return lastCode;
            }
        }
        // 後端是預設檔案且找不到使用者的程式碼 → 直接顯示預設模板
        if (isDefaultFile) {
            return defaultTemplate;
        }
    }

    if (!source_code_obj) {
        // NONE_AVAILABLE: try last edited code from localStorage
        const lastFn = localStorage.getItem("gdbgui_last_edited_filename");
        if (lastFn) {
            const lastCode = localStorage.getItem("gdbgui_editor_code_" + lastFn);
            if (lastCode && lastCode.trim()) return lastCode;
        }
        // Ultimate fallback: default C++ template
        return defaultTemplate;
    }
    const lines = [];

    // Helper to strip HTML tags and decode HTML entities
    const stripHtml = (html: string) => {
      if (!html) return "";

      if (html.includes('<span') || html.includes('&lt;') || html.includes('&gt;') || html.includes('&amp;') || html.includes('&quot;') || html.includes('&#39;')) {
        let temp_el = document.createElement("div");
        temp_el.innerHTML = html;
        let text = temp_el.textContent || temp_el.innerText || "";
        // Replace non-breaking spaces with normal spaces if Pygments added them
        text = text.replace(/\u00A0/g, ' ');
        return text;
      }

      return html;
    };

    for (let i = 1; i <= num_lines; i++) {
      let lineContent = source_code_obj[i] || "";
      if (typeof lineContent === 'string' && lineContent.endsWith('\n')) {
        lineContent = lineContent.slice(0, -1);
      }
      lines.push(stripHtml(lineContent));
    }
    return lines.join("\n");
  }

  handleInputChange(index: number, value: string) {
    const newInputValues = {
      ...this.state.inputValues,
      [index]: value,
    };

    // Save to state and persistent storage
    this.setState({
      inputValues: newInputValues,
    });
    const fn = this.state.fullname_to_render || "default";
    localStorage.setItem("gdbgui_guide_inputs_" + fn, JSON.stringify(newInputValues));

    // 用global_variable儲存每個line的資訊。
    if (!('__line' in global_variable)) {
      (global_variable as any).__line = {};
    }
    // console.log(`第${index}行儲存的指導為${value}`);
    (global_variable as any).__line[index] = value;
    
    // 即時解析指導 (抽出 [標籤#顏色] 等資訊)，並打亂 store 讓 CallGraph 重新刷新
    VisualizerHelper.processing_guide(index, null);
    store.set("call_graph_updated", Math.random());
  }

  handleTtsChange(index: number, value: string) {
    const newTtsValues = {
      ...this.state.ttsValues,
      [index]: value,
    };

    this.setState({
      ttsValues: newTtsValues,
    });
    const fn = this.state.fullname_to_render || "default";
    localStorage.setItem("gdbgui_tts_inputs_" + fn, JSON.stringify(newTtsValues));

    if (!('__tts' in global_variable)) {
      (global_variable as any).__tts = {};
    }
    (global_variable as any).__tts[index] = value;
  }

  handleLayoutChange(index: number, value: string) {
    const newLayoutValues = {
      ...this.state.layoutValues,
      [index]: value,
    };

    this.setState({ layoutValues: newLayoutValues });
    const fn = this.state.fullname_to_render || "default";
    localStorage.setItem("gdbgui_layout_inputs_" + fn, JSON.stringify(newLayoutValues));

    if (!('__layout' in global_variable)) {
      (global_variable as any).__layout = {};
    }
    (global_variable as any).__layout[index] = value;
  }

  // ── Line Editor Modal helpers ─────────────────────────────────────────────

  /** 將 TTS 字串拆解為 speed / continue / 本文 三個欄位 */
  _parseTts(tts: string) {
    let text = tts || '';
    let speed = '';
    let hasContinue = false;
    const speedM = /\[speed:([\d.]+)\]/.exec(text);
    if (speedM) { speed = speedM[1]; text = text.replace(speedM[0], ''); }
    if (text.includes('[continue]')) { hasContinue = true; text = text.replace('[continue]', ''); }
    return { speed, hasContinue, text: text.trimStart() };
  }

  /** 將三個欄位重新組合成 TTS 字串 */
  _buildTts(speed: string, hasContinue: boolean, text: string) {
    let result = '';
    const s = parseFloat(speed);
    if (!isNaN(s) && s !== 1.0) result += `[speed:${s}]`;
    if (hasContinue) result += '[continue]';
    if (text.trim()) result += (result ? '' : '') + text;
    return result;
  }

  /** 將 Layout 字串拆解為結構化欄位 */
  _parseLayout(layout: string) {
    const fields: any = { sidebar: '', open: '', close: '', maze: '' };
    (layout || '').trim().split(/\s+/).forEach(token => {
      const c = token.indexOf(':');
      if (c < 0) return;
      const k = token.slice(0, c), v = token.slice(c + 1);
      if (k in fields) fields[k] = v;
    });
    return fields;
  }

  /** 將結構化欄位重新組合成 Layout 字串 */
  _buildLayout(sidebar: string, open: string, close: string, maze: string) {
    const parts: string[] = [];
    if (sidebar.trim()) parts.push(`sidebar:${sidebar.trim()}`);
    if (open.trim())    parts.push(`open:${open.trim()}`);
    if (close.trim())   parts.push(`close:${close.trim()}`);
    if (maze.trim())    parts.push(`maze:${maze.trim()}`);
    return parts.join(' ');
  }

  openLineEditor = (lineNum: number, tab: 'guide' | 'tts' | 'layout' = 'guide') => {
    const guide  = this.state.inputValues[lineNum]  || '';
    const tts    = this.state.ttsValues[lineNum]    || '';
    const layout = this.state.layoutValues[lineNum] || '';
    const { speed, hasContinue, text: ttsText } = this._parseTts(tts);
    const { sidebar, open, close, maze }         = this._parseLayout(layout);
    this.setState({
      lineEditorModal: {
        lineNum, activeTab: tab,
        draftGuide: guide,
        draftTtsSpeed: speed, draftTtsContinue: hasContinue, draftTtsText: ttsText,
        draftLayoutSidebar: sidebar, draftLayoutOpen: open,
        draftLayoutClose: close, draftLayoutMaze: maze,
      }
    });
  };

  saveLineEditor = () => {
    const m = this.state.lineEditorModal;
    if (!m) return;
    const { lineNum, draftGuide,
            draftTtsSpeed, draftTtsContinue, draftTtsText,
            draftLayoutSidebar, draftLayoutOpen, draftLayoutClose, draftLayoutMaze } = m;
    const ttsStr    = this._buildTts(draftTtsSpeed, draftTtsContinue, draftTtsText);
    const layoutStr = this._buildLayout(draftLayoutSidebar, draftLayoutOpen, draftLayoutClose, draftLayoutMaze);
    this.handleInputChange(lineNum, draftGuide);
    this.handleTtsChange(lineNum, ttsStr);
    this.handleLayoutChange(lineNum, layoutStr);
    this.setState({ lineEditorModal: null });
  };

  updateModalField = (field: string, value: any) => {
    this.setState((prev: any) => ({
      lineEditorModal: prev.lineEditorModal ? { ...prev.lineEditorModal, [field]: value } : null
    }));
  };

  // ─────────────────────────────────────────────────────────────────────────

  // 多行移動的 guide/TTS/layout 重新映射
  // sortedSources：要移動的行（已排序），insertAfterLine：插入到此行之後
  _shiftMapForMultiMove(obj: any, sortedSources: number[], insertAfterLine: number): any {
    const sourcesSet = new Set(sortedSources);
    const allKeys = Object.keys(obj).map(Number).filter(n => !isNaN(n));
    const maxKey = Math.max(...allKeys, insertAfterLine, ...sortedSources, 0);

    // 非 source 行，保持原本順序
    const remaining: number[] = [];
    for (let i = 1; i <= maxKey; i++) {
      if (!sourcesSet.has(i)) remaining.push(i);
    }

    // 找到 insertAfterLine 在 remaining 中的位置
    const insertIdx = remaining.indexOf(insertAfterLine);
    if (insertIdx === -1) return obj; // insertAfterLine 是 source 行，放棄

    // 最終行順序（以原始行號表示）
    const finalOrder: number[] = [
      ...remaining.slice(0, insertIdx + 1),
      ...sortedSources,
      ...remaining.slice(insertIdx + 1),
    ];

    const result: any = {};
    finalOrder.forEach((oldLine, newIdx) => {
      const newLine = newIdx + 1;
      if (obj[oldLine] !== undefined) result[newLine] = obj[oldLine];
    });
    return result;
  }

  moveMultipleLines(sources: number[], insertAfterLine: number) {
    if (!this.editorInstance || sources.length === 0) return;
    const model = this.editorInstance.getModel();
    if (!model) return;

    const totalLines = model.getLineCount();
    const sortedSources = [...new Set(sources)].sort((a, b) => a - b);
    const sourcesSet = new Set(sortedSources);

    if (sourcesSet.has(insertAfterLine)) return; // drop 在 source 行上無效

    // 取得所有行內容
    const allLines: string[] = [];
    for (let i = 1; i <= totalLines; i++) allLines.push(model.getLineContent(i));

    // 分離 source 與 remaining（保留原始行號資訊）
    const movedContent = sortedSources.map(s => allLines[s - 1]);
    const remaining: { orig: number; content: string }[] = [];
    for (let i = 1; i <= totalLines; i++) {
      if (!sourcesSet.has(i)) remaining.push({ orig: i, content: allLines[i - 1] });
    }

    const insertIdx = remaining.findIndex(r => r.orig === insertAfterLine);
    if (insertIdx === -1) return;

    const finalLines: string[] = [
      ...remaining.slice(0, insertIdx + 1).map(r => r.content),
      ...movedContent,
      ...remaining.slice(insertIdx + 1).map(r => r.content),
    ];

    // Monaco 全文替換（標記為程式化編輯，避免 shiftGuideOnLineChange 雙重處理）
    this._programmaticEdit = true;
    model.applyEdits([{
      range: new this.monaco.Range(1, 1, totalLines, model.getLineMaxColumn(totalLines)),
      text: finalLines.join('\n'),
      forceMoveMarkers: true,
    }]);

    // Guide / TTS / Layout
    const newInput  = this._shiftMapForMultiMove({ ...this.state.inputValues  }, sortedSources, insertAfterLine);
    const newTts    = this._shiftMapForMultiMove({ ...this.state.ttsValues    }, sortedSources, insertAfterLine);
    const newLayout = this._shiftMapForMultiMove({ ...this.state.layoutValues }, sortedSources, insertAfterLine);

    this.setState({ inputValues: newInput, ttsValues: newTts, layoutValues: newLayout, selectedLines: [], dragLines: [] });
    const fn = this.state.fullname_to_render || "default";
    localStorage.setItem("gdbgui_guide_inputs_"  + fn, JSON.stringify(newInput));
    localStorage.setItem("gdbgui_tts_inputs_"    + fn, JSON.stringify(newTts));
    localStorage.setItem("gdbgui_layout_inputs_" + fn, JSON.stringify(newLayout));
    (global_variable as any).__line   = { ...newInput  };
    (global_variable as any).__tts    = { ...newTts    };
    (global_variable as any).__layout = { ...newLayout };

    // 斷點：建立 oldLine → newLine 映射
    const finalOrderOrig: number[] = [
      ...remaining.slice(0, insertIdx + 1).map(r => r.orig),
      ...sortedSources,
      ...remaining.slice(insertIdx + 1).map(r => r.orig),
    ];
    const lineMap = new Map<number, number>();
    finalOrderOrig.forEach((oldLine, newIdx) => lineMap.set(oldLine, newIdx + 1));

    const bkpts: any[] = store.get("breakpoints");
    const newBkpts = bkpts.map((b: any) => {
      const bLine = parseInt(b.line);
      if (isNaN(bLine)) return b;
      const newLine = lineMap.get(bLine);
      if (newLine === undefined || newLine === bLine) return b;
      return { ...b, line: String(newLine) };
    });
    store.set("breakpoints", newBkpts);
  }

  applyLayout = (lineNum: string | number) => {
    const layoutMap = (global_variable as any).__layout;
    if (!layoutMap) return;
    const layoutStr: string = layoutMap[String(lineNum)];
    if (!layoutStr) return;

    const registry = (window as any).gdbgui_collapser_registry || {};
    const tokens = layoutStr.trim().split(/\s+/);
    for (const token of tokens) {
      const colonIdx = token.indexOf(":");
      if (colonIdx < 0) continue;
      const key = token.slice(0, colonIdx);
      const val = token.slice(colonIdx + 1);

      if (key === "sidebar") {
        const pct = parseFloat(val);
        if (!isNaN(pct)) {
          const splitObj = store.get("middle_panes_split_obj");
          if (splitObj) {
            const showFs = store.get("show_filesystem");
            if (showFs) {
              const fsPct = 30;
              splitObj.setSizes([fsPct, Math.max(0, 69 - pct), pct]);
            } else {
              splitObj.setSizes([0, Math.max(0, 99 - pct), pct]);
            }
          }
        }
      } else if (key === "open") {
        val.split(",").forEach((id: string) => {
          if (registry[id]) registry[id].open();
        });
      } else if (key === "close") {
        val.split(",").forEach((id: string) => {
          if (registry[id]) registry[id].close();
        });
      } else if (key === "maze") {
        // maze:containerName1,containerName2 → 自動勾選迷宮模式
        const setMazeMode = (window as any).gdbgui_set_maze_mode;
        if (setMazeMode) {
          val.split(",").forEach((containerName: string) => {
            setMazeMode(containerName.trim(), true);
          });
        }
      }
    }
  };

  clearAllBreakpoints = () => {
    store.set("breakpoints", []);
    localStorage.setItem("breakpoints", JSON.stringify([]));
    GdbApi.run_gdb_command(["-interpreter-exec console \"delete\"", GdbApi.get_break_list_cmd()]);
  };

  exportProject = () => {
    const source_code = this.editorInstance ? this.editorInstance.getValue() : "";
    const line_data: any = {};
    const inputValues = this.state.inputValues || {};
    const ttsValues = this.state.ttsValues || {};
    const layoutValues = (global_variable as any).__layout || {};

    const allLines = new Set([
      ...Object.keys(inputValues),
      ...Object.keys(ttsValues),
      ...Object.keys(layoutValues),
    ]);
    allLines.forEach(line => {
      line_data[line] = {
        guide: inputValues[line] || "",
        tts: ttsValues[line] || "",
        ...(layoutValues[line] ? { layout: layoutValues[line] } : {}),
      };
    });

    const programInput = localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "";
    const breakpoints = store.get("breakpoints") || [];

    const projectData = {
      version: "1.0",
      project_name: "gdbgui_project",
      source_code: source_code,
      line_data: line_data,
      program_input: programInput,
      breakpoints: breakpoints
    };

    const jsonStr = JSON.stringify(projectData, null, 2);

    // 優先使用 File System Access API（支援另存新檔 / 覆蓋本地檔案）
    if ((window as any).showSaveFilePicker) {
      (async () => {
        try {
          const fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: "project.gdbgui.json",
            types: [{
              description: "gdbgui project",
              accept: { "application/json": [".json"] },
            }],
          });
          const writable = await fileHandle.createWritable();
          await writable.write(jsonStr);
          await writable.close();
        } catch (err: any) {
          if (err.name !== "AbortError") {
            console.error("Save failed", err);
            Actions.add_console_entries("Save failed: " + err.message, constants.console_entry_type.STD_ERR);
          }
        }
      })();
    } else {
      // Fallback：瀏覽器不支援 File System Access API 時降級為下載
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(jsonStr);
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", "project.gdbgui.json");
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    }
  };

  triggerImport = () => {
    if (this.fileInputRef && this.fileInputRef.current) {
      this.fileInputRef.current.click();
    }
  };

  handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // 若 GDB inferior 正在執行或暫停中，先強制終止，再進行 import
    const infState = store.get("inferior_program");
    if (
      infState === constants.inferior_states.running ||
      infState === constants.inferior_states.paused
    ) {
      GdbApi.run_gdb_command("kill");
      Actions.inferior_program_exited();
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const projectData = JSON.parse(content);

        if (projectData.source_code) {
          if (this.editorInstance) {
            this.editorInstance.setValue(projectData.source_code);
            // 強制下次 Start 一定重新編譯（不論程式碼內容是否與上次相同）
            (window as any).last_compiled_code = null;
          } else {
            // Monaco 尚未掛載（FILE_MISSING / NONE_AVAILABLE 狀態）
            // 將 source_code 直接注入 FileOps cache，讓 Monaco 立刻顯示
            const lines = projectData.source_code.split("\n");
            const source_code_obj: any = {};
            lines.forEach((line: string, idx: number) => {
              source_code_obj[idx + 1] = escapeHtml(line);
            });
            const numLines = lines.length;
            // 用現有 fullname 或建立一個合成名稱
            const syntheticFullname = this.state.fullname_to_render || "imported_code.cpp";
            FileOps.add_source_file_to_cache(syntheticFullname, source_code_obj, Date.now() / 1000, numLines);
            store.set("fullname_to_render", syntheticFullname);
            store.set("source_code_state", constants.source_code_states.SOURCE_CACHED);
            store.set("source_code_selection_state", constants.source_code_selection_states.USER_SELECTION);
            // 存入 localStorage，讓 click_run_button 的 fallback 也能找到
            localStorage.setItem("gdbgui_editor_code_" + syntheticFullname, projectData.source_code);
            // 清除 last_compiled_code，避免 Run 誤判「程式碼未變」而跳過重新 compile
            (window as any).last_compiled_code = null;
          }
          // 把 import 進來的程式碼存進 localStorage 的 fallback 鏈：
          // get_monaco_value 在 Monaco 重新 mount 時會先查 gdbgui_last_edited_filename，
          // 若不存此處，Monaco 重 mount 後會撈回舊檔案，導致 Run 時跑舊程式碼。
          const _importKey = "__imported__";
          localStorage.setItem("gdbgui_editor_code_" + _importKey, projectData.source_code);
          localStorage.setItem("gdbgui_editor_filename_" + _importKey, _importKey);
          localStorage.setItem("gdbgui_last_edited_filename", _importKey);
        }

        const newInputValues: any = {};
        const newTtsValues: any = {};
        const newLayoutValues: any = {};
        if (projectData.line_data) {
          for (const line in projectData.line_data) {
            newInputValues[line] = projectData.line_data[line].guide || "";
            newTtsValues[line] = projectData.line_data[line].tts || "";
            if (projectData.line_data[line].layout) {
              newLayoutValues[line] = projectData.line_data[line].layout;
            }
          }
        }

        this.setState({
          inputValues: newInputValues,
          ttsValues: newTtsValues,
          layoutValues: newLayoutValues,
        });

        const fn = this.state.fullname_to_render || "default";
        localStorage.setItem("gdbgui_guide_inputs_" + fn, JSON.stringify(newInputValues));
        localStorage.setItem("gdbgui_tts_inputs_" + fn, JSON.stringify(newTtsValues));
        localStorage.setItem("gdbgui_layout_inputs_" + fn, JSON.stringify(newLayoutValues));

        (global_variable as any).__line = { ...newInputValues };
        (global_variable as any).__tts = { ...newTtsValues };
        (global_variable as any).__layout = { ...newLayoutValues };

        if (projectData.program_input !== undefined) {
          localStorage.setItem("gdbgui_program_input", projectData.program_input);
          store.set("program_input", projectData.program_input);
        }

        // import 後的 fullname_to_render（可能是合成名稱或舊路徑）
        const currentFullname = this.state.fullname_to_render || "imported_code.cpp";

        const normalizeBkpts = (bkpts: any[]) =>
          bkpts
            .filter((b: any) => b.is_normal_breakpoint !== false && !b.is_child_breakpoint)
            .map((b: any, idx: number) => ({
              ...b,
              // import 後 fullname_to_render 會被重設為 ""，用 "" 才能讓
              // get_breakpoint_lines_for_file("") 找到並在 Monaco gutter 顯示標記。
              // Run 後 save_breakpoints 的 dedup-by-line 會自動換成 GDB 確認的路徑。
              fullname: "",
              fullname_to_display: "",
              enabled: b.enabled ?? "y",
              number: typeof b.number === 'string' && b.number.startsWith('frontend_')
                ? b.number
                : `frontend_${idx + 1}`
            }));

        if (projectData.breakpoints !== undefined && Array.isArray(projectData.breakpoints)) {
          // JSON 有 breakpoints 欄位：匯入時一律套用（教案的斷點就是教案應該有的斷點）
          const frontendBkpts = normalizeBkpts(projectData.breakpoints);
          store.set("breakpoints", frontendBkpts);
          localStorage.setItem("breakpoints", JSON.stringify(frontendBkpts));
        }
        // JSON 沒有 breakpoints 欄位：保留現有斷點，不做任何更改

        Actions.add_console_entries("Project imported successfully. Please click Run/Restart to recompile.", constants.console_entry_type.GDBGUI_OUTPUT);

        // 清除 fullname 與 initialFullname，讓 render 回到 NONE_AVAILABLE 空白狀態，
        // Monaco 路徑的 isMonacoMainFile 條件（initialFullname===null）因此成立，
        // edit_mode 才能正確生效並顯示匯入的程式碼
        this.initialFullname = null;
        store.set("fullname_to_render", "");
        store.set("source_code_state", constants.source_code_states.NONE_AVAILABLE);
        store.set("edit_mode", true);

      } catch (err) {
        console.error("Error parsing project file", err);
        Actions.add_console_entries("Error parsing project file", constants.console_entry_type.STD_ERR);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };
  tempFullname = '';
  lastLoadedFilename: string | null = null;
  render() {
    if (this.tempFullname !== this.state.fullname_to_render) {
      this.tempFullname = this.state.fullname_to_render;
      console.log(this.tempFullname);
    }
    if (this.initialFullname === null) {
      this.initialFullname = this.state.fullname_to_render;
    }

    // ── Line Editor Modal ─────────────────────────────────────────────────────
    const lm = this.state.lineEditorModal;
    const lineEditorModal = lm ? (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.45)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) this.setState({ lineEditorModal: null }); }}
      >
        <div style={{
          background: '#fff', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
          width: '640px', maxWidth: '96vw', fontFamily: 'sans-serif', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f5f5f5' }}>
            <strong style={{ fontSize: '15px' }}>第 {lm.lineNum} 行 — 行編輯器</strong>
            <button onClick={() => this.setState({ lineEditorModal: null })} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#666', lineHeight: 1 }}>✕</button>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e0e0e0' }}>
            {(['guide', 'tts', 'layout'] as const).map(tab => (
              <button key={tab} onClick={() => this.updateModalField('activeTab', tab)} style={{
                flex: 1, padding: '8px', border: 'none', borderBottom: lm.activeTab === tab ? '2px solid #4a9eff' : '2px solid transparent',
                background: lm.activeTab === tab ? '#f0f7ff' : 'transparent', cursor: 'pointer', fontWeight: lm.activeTab === tab ? 600 : 400, fontSize: '13px',
              }}>
                {tab === 'guide' ? '📝 指導文字' : tab === 'tts' ? '🔊 語音 TTS' : '📐 版面 Layout'}
              </button>
            ))}
          </div>

          {/* Body */}
          <div style={{ padding: '16px', minHeight: '220px' }}>
            {lm.activeTab === 'guide' && (
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '6px' }}>指導文字（支援 GDB 指令佔位符，如 <code style={{background:'#f0f0f0',padding:'1px 4px',borderRadius:'3px'}}>{'{varName}'}</code>）</label>
                <textarea
                  autoFocus
                  value={lm.draftGuide}
                  onChange={(e) => this.updateModalField('draftGuide', e.target.value)}
                  rows={6}
                  style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '13px', border: '1px solid #ccc', borderRadius: '4px', padding: '8px', resize: 'vertical' }}
                  placeholder="輸入指導文字，支援換行與 {變數名} 佔位符"
                />
                <p style={{ fontSize: '11px', color: '#888', marginTop: '6px', marginBottom: 0 }}>
                  換行符 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>\n</code> 會顯示為多行。佔位符 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>{'{varName}'}</code> 會被替換為目前變數值。
                </p>
              </div>
            )}

            {lm.activeTab === 'tts' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>語速倍率</label>
                    <input type="number" min="0.5" max="4.0" step="0.1"
                      value={lm.draftTtsSpeed}
                      onChange={(e) => this.updateModalField('draftTtsSpeed', e.target.value)}
                      placeholder="1.0"
                      style={{ width: '90px', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}
                    />
                    <span style={{ fontSize: '11px', color: '#aaa', marginLeft: '6px' }}>留空 = 預設 1.0</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '4px' }}>
                    <input type="checkbox" id="le-continue" checked={lm.draftTtsContinue}
                      onChange={(e) => this.updateModalField('draftTtsContinue', e.target.checked)}
                    />
                    <label htmlFor="le-continue" style={{ fontSize: '13px', cursor: 'pointer' }}>
                      <code style={{background:'#f0f0f0',padding:'1px 4px',borderRadius:'3px'}}>[continue]</code>　播完後自動繼續執行
                    </label>
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>語音朗讀文字</label>
                  <textarea
                    value={lm.draftTtsText}
                    onChange={(e) => this.updateModalField('draftTtsText', e.target.value)}
                    rows={5}
                    style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '13px', border: '1px solid #ccc', borderRadius: '4px', padding: '8px', resize: 'vertical' }}
                    placeholder="輸入 TTS 朗讀文字（留空則此行不播語音）"
                  />
                </div>
                <div style={{ background: '#f7f7f7', borderRadius: '4px', padding: '6px 10px', fontSize: '12px', color: '#666' }}>
                  <strong>預覽：</strong> <code style={{ wordBreak: 'break-all' }}>{this._buildTts(lm.draftTtsSpeed, lm.draftTtsContinue, lm.draftTtsText) || '（空）'}</code>
                </div>
              </div>
            )}

            {lm.activeTab === 'layout' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>右側邊欄寬度 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>sidebar:N</code></label>
                    <input type="number" min="0" max="100" step="1"
                      value={lm.draftLayoutSidebar}
                      onChange={(e) => this.updateModalField('draftLayoutSidebar', e.target.value)}
                      placeholder="例：50"
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>迷宮容器 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>maze:名稱</code></label>
                    <input type="text"
                      value={lm.draftLayoutMaze}
                      onChange={(e) => this.updateModalField('draftLayoutMaze', e.target.value)}
                      placeholder="例：maze"
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>展開面板 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>open:id1,id2</code></label>
                    <input type="text"
                      value={lm.draftLayoutOpen}
                      onChange={(e) => this.updateModalField('draftLayoutOpen', e.target.value)}
                      placeholder="例：container,locals"
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666', marginBottom: '4px' }}>收合面板 <code style={{background:'#f0f0f0',padding:'1px 3px',borderRadius:'2px'}}>close:id1,id2</code></label>
                    <input type="text"
                      value={lm.draftLayoutClose}
                      onChange={(e) => this.updateModalField('draftLayoutClose', e.target.value)}
                      placeholder="例：memory,registers"
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>
                </div>
                <div style={{ background: '#f7f7f7', borderRadius: '4px', padding: '6px 10px', fontSize: '12px', color: '#666' }}>
                  <strong>預覽：</strong> <code style={{ wordBreak: 'break-all' }}>{this._buildLayout(lm.draftLayoutSidebar, lm.draftLayoutOpen, lm.draftLayoutClose, lm.draftLayoutMaze) || '（空）'}</code>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid #e0e0e0', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: '#f9f9f9' }}>
            <button onClick={() => this.setState({ lineEditorModal: null })} style={{ padding: '6px 16px', border: '1px solid #ccc', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}>取消</button>
            <button onClick={this.saveLineEditor} style={{ padding: '6px 16px', border: 'none', borderRadius: '4px', background: '#4a9eff', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>儲存</button>
          </div>
        </div>
      </div>
    ) : null;
    // ─────────────────────────────────────────────────────────────────────────

    // Monaco always renders — code_body table view is eliminated.
    const obj = FileOps.get_source_file_obj_from_cache(this.state.fullname_to_render);

    const ftrForMonaco = this.state.fullname_to_render || "";

    // Keep initialFullname in sync so future checks remain stable
    this.initialFullname = ftrForMonaco;

    let value = "";
    if (this.editorInstance && this.lastLoadedFilename !== null) {
      // Monaco is already mounted — always prefer the live editor content
      try { value = this.editorInstance.getValue(); } catch (e) { value = ""; }
      if (!value || value.trim() === "") {
        // Editor returned empty (rare edge case), fall back to storage/cache
        value = this.get_monaco_value(obj?.source_code_obj ?? null, obj?.num_lines_in_file ?? 0);
      } else if (this.lastLoadedFilename !== ftrForMonaco && this.lastLoadedFilename !== "" && ftrForMonaco !== "") {
        // Filename changed while Monaco was mounted — persist code under new key
        // so that a future remount (e.g. after assembly view) still finds it
        // Guard: skip when transitioning from NONE_AVAILABLE ("") to real file
        localStorage.setItem("gdbgui_editor_code_" + ftrForMonaco, value);
        localStorage.setItem("gdbgui_editor_filename_" + ftrForMonaco, ftrForMonaco);
      }
    } else {
      // Monaco is (re)mounting — load from localStorage or server cache
      value = this.get_monaco_value(obj?.source_code_obj ?? null, obj?.num_lines_in_file ?? 0);
    }
    this.lastLoadedFilename = ftrForMonaco;

      const theme = this.state.current_theme === 'dark' ? 'vs-dark' : 'light';
      const LINE_HEIGHT = 19;
      // Use dynamic line count if available, otherwise fallback to static
      const numLines = this.state.lineCount > 0 ? this.state.lineCount : (obj?.num_lines_in_file ?? 0);

      // Generate Guide/TTS inputs (edit_mode panel)
      const inputColStyle = (borderLeft?: boolean): React.CSSProperties => ({
        height: "100%",
        border: "none",
        borderLeft: borderLeft ? "1px solid #ccc" : undefined,
        background: "transparent",
        fontFamily: "monospace",
        fontSize: "inherit",
        paddingLeft: "4px",
      });
      const guideTtsInputs: React.ReactNode[] = [];
      // Generate Layout inputs (always-visible right panel)
      const layoutInputs: React.ReactNode[] = [];
      const dragLines   = this.state.dragLines as number[];
      const dragOver    = this.state.dragOverLine;
      const selectedLines = this.state.selectedLines as number[];
      const selectedSet = new Set(selectedLines);
      const dragSet     = new Set(dragLines);
      const dragHandles: React.ReactNode[] = [];

      // drop 共用邏輯
      const handleDrop = (e: React.DragEvent, targetLine: number) => {
        e.preventDefault();
        const lines = this.state.dragLines as number[];
        this.setState({ dragLines: [], dragOverLine: null });
        if (lines.length === 0) return;
        const minSrc = Math.min(...lines);
        if (targetLine < minSrc) {
          // 插入到 targetLine 之後
          this.moveMultipleLines(lines, targetLine);
        } else {
          // 插入到 targetLine 之後
          this.moveMultipleLines(lines, targetLine);
        }
      };

      for (let i = 1; i <= numLines; i++) {
        const isSource   = dragSet.has(i);
        const isSelected = selectedSet.has(i);
        // 指示線顯示在目標行的「底部」，代表插入到該行之後
        const isTarget   = dragOver === i && dragLines.length > 0 && !dragSet.has(i);

        guideTtsInputs.push(
          <div
            key={i}
            style={{
              height: `${LINE_HEIGHT}px`,
              borderBottom: isTarget ? "2px solid #4a9eff" : "1px solid #eee",
              boxSizing: "border-box",
              display: "flex",
              opacity: isSource ? 0.4 : 1,
              background: isSelected ? "rgba(74,158,255,0.12)" : undefined,
            }}
            onDragOver={(e) => { e.preventDefault(); if (this.state.dragOverLine !== i) this.setState({ dragOverLine: i }); }}
            onDrop={(e) => handleDrop(e, i)}
          >
            <input
              className="panel-input"
              style={{ flex: 1, minWidth: 0, ...inputColStyle() }}
              data-line={i}
              value={this.state.inputValues[i] || ''}
              placeholder={`Guide L${i}`}
              onChange={(e) => { this.handleInputChange(i, e.target.value); }}
              title="Guide"
            />
            <input
              className="panel-input"
              style={{ flex: 1, minWidth: 0, ...inputColStyle(true) }}
              data-line={i}
              value={this.state.ttsValues[i] || ''}
              placeholder={`TTS L${i}`}
              onChange={(e) => { this.handleTtsChange(i, e.target.value); }}
              title="TTS Script"
            />
            {/* 展開編輯按鈕 */}
            <button
              title="展開行編輯器"
              onClick={(e) => { e.stopPropagation(); this.openLineEditor(i); }}
              style={{
                flexShrink: 0, width: '18px', height: '100%',
                border: 'none', background: 'transparent',
                cursor: 'pointer', color: '#888', fontSize: '11px', padding: 0,
                borderLeft: '1px solid #eee',
              }}
            >✎</button>
          </div>
        );
        // 拖曳 handle overlay（對齊 Monaco glyph margin）
        dragHandles.push(
          <div
            key={i}
            draggable
            onClick={(e) => {
              // Ctrl+Click：toggle 此行選取
              // Shift+Click：從上次點擊行到此行都選取
              if (e.shiftKey && this.state.lastClickedLine !== null) {
                const anchor = this.state.lastClickedLine as number;
                const min = Math.min(anchor, i), max = Math.max(anchor, i);
                const range: number[] = [];
                for (let r = min; r <= max; r++) range.push(r);
                this.setState({ selectedLines: range });
              } else if (e.ctrlKey || e.metaKey) {
                const sel = this.state.selectedLines as number[];
                const next = sel.includes(i) ? sel.filter(l => l !== i) : [...sel, i];
                this.setState({ selectedLines: next, lastClickedLine: i });
              } else {
                // 單擊：只選此行（或取消選取）
                const sel = this.state.selectedLines as number[];
                this.setState({
                  selectedLines: sel.length === 1 && sel[0] === i ? [] : [i],
                  lastClickedLine: i,
                });
              }
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              // 若此行在 selectedLines 中，拖整組；否則只拖此行
              const sel = this.state.selectedLines as number[];
              const lines = sel.includes(i) ? [...sel].sort((a,b)=>a-b) : [i];
              this.setState({ dragLines: lines, dragOverLine: null });
            }}
            onDragEnd={() => this.setState({ dragLines: [], dragOverLine: null })}
            onDragOver={(e) => { e.preventDefault(); if (this.state.dragOverLine !== i) this.setState({ dragOverLine: i }); }}
            onDrop={(e) => handleDrop(e, i)}
            style={{
              height: `${LINE_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'grab',
              color: isSource ? '#4a9eff' : isSelected ? '#4a9eff' : '#aaa',
              userSelect: 'none',
              fontSize: '13px',
              boxSizing: 'border-box',
              borderBottom: isTarget ? "2px solid #4a9eff" : "1px solid transparent",
              background: isSelected ? "rgba(74,158,255,0.15)" : undefined,
            }}
            title="點擊選取 / Ctrl+點擊多選 / Shift+點擊範圍選 / 拖曳移動"
          >⠿</div>
        );
        layoutInputs.push(
          <div key={i} style={{ height: `${LINE_HEIGHT}px`, borderBottom: "1px solid #eee", boxSizing: "border-box", display: 'flex' }}>
            <input
              className="panel-input"
              style={{ flex: 1, minWidth: 0, height: "100%", border: "none", background: "transparent", fontFamily: "monospace", fontSize: "inherit", paddingLeft: "4px", boxSizing: "border-box" }}
              data-line={i}
              value={this.state.layoutValues[i] || ''}
              placeholder={`sidebar:50 open:container`}
              onChange={(e) => { this.handleLayoutChange(i, e.target.value); }}
              title="Layout (e.g. sidebar:50 open:container close:locals)"
            />
            <button
              title="展開行編輯器 (Layout)"
              onClick={(e) => { e.stopPropagation(); this.openLineEditor(i, 'layout'); }}
              style={{
                flexShrink: 0, width: '18px', height: '100%',
                border: 'none', background: 'transparent',
                cursor: 'pointer', color: '#888', fontSize: '11px', padding: 0,
                borderLeft: '1px solid #eee',
              }}
            >✎</button>
          </div>
        );
      }

      // Calculate Styles
      const splitPos = this.state.splitPos;
      const leftStyle: React.CSSProperties = splitPos !== -1
        ? { width: `${splitPos}px`, height: "100%", flexShrink: 0 }
        : { flex: "0 0 50%", height: "100%" }; // Default 50% until mounted

      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
          <div style={{ padding: "4px 8px", backgroundColor: "#f5f5f5", borderBottom: "1px solid #ddd", fontSize: "14px", fontFamily: "monospace", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{(this.state.fullname_to_render || "").split(/[\\/]/).pop() || this.state.fullname_to_render}</strong>
            <div>
              <button
                onClick={this.triggerImport}
                className="btn btn-default btn-sm"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", marginRight: "4px" }}>
                Import JSON
              </button>
              <input
                type="file"
                accept=".json"
                style={{ display: "none" }}
                ref={this.fileInputRef}
                onChange={this.handleImport}
              />
              <button
                onClick={this.exportProject}
                className="btn btn-default btn-sm"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", marginRight: "4px" }}>
                Export JSON
              </button>
              <button
                onClick={this.clearAllBreakpoints}
                className="btn btn-default btn-sm"
                title="Clear all breakpoints"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", color: "#c00" }}>
                ✕ Breakpoints
              </button>
            </div>
          </div>
          <div ref={this.containerRef} className={this.state.current_theme} style={{ flex: 1, width: "100%", display: "flex", overflow: 'hidden' }}>
            <div style={{ ...(this.state.edit_mode ? leftStyle : { flex: 1, height: "100%" }), position: 'relative' }}>
              {/* 拖曳 handle overlay：貼合 Monaco glyph margin，僅在 edit mode 顯示 */}
              {this.state.edit_mode && (
                <div
                  ref={this.dragHandleContainerRef}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: '26px',           // 跳過 glyph margin（斷點區），貼在行號上
                    width: '22px',
                    height: '100%',
                    overflow: 'hidden',
                    zIndex: 5,
                    pointerEvents: 'none',  // 預設不攔截，handle 自己開啟
                  }}
                >
                  <div style={{ pointerEvents: 'all' }}>
                    {dragHandles}
                  </div>
                </div>
              )}
              <MonacoEditor
                height="100%"
                language="cpp"
                theme={theme}
                value={value}
                editorDidMount={(getValue: any, editor: any) => {
                  this.handleEditorDidMount(getValue, editor);
                }}
                options={{
                  readOnly: !this.state.edit_mode,
                  extraEditorClassName: this.state.edit_mode ? '' : 'gdbgui-readonly-editor',
                  glyphMargin: true,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  fontFamily: "monospace",
                  lineHeight: LINE_HEIGHT
                }}
              />
            </div>

            {/* Drag Handle — 僅在編輯模式顯示 */}
            {this.state.edit_mode && (
              <div
                onMouseDown={this.startDrag}
                style={{
                  width: "5px",
                  height: "100%",
                  cursor: "col-resize",
                  backgroundColor: "#e0e0e0",
                  zIndex: 10,
                  flexShrink: 0
                }}
                title="Drag to resize"
              />
            )}

            {/* Guide / TTS 輸入欄 — 僅在編輯模式顯示 */}
            {this.state.edit_mode && (
              <div style={{ flex: "1", height: "100%", borderLeft: "1px solid #ccc", backgroundColor: "#fdfdfd", minWidth: 0 }}>
                <div
                  ref={this.inputContainerRef}
                  style={{ height: "100%", overflow: "hidden", fontFamily: "monospace", fontSize: "14px" }}
                  onDragLeave={(e) => {
                    // 只在真正離開整個面板時清除（不是移到子元素）
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      this.setState({ dragOverLine: null });
                    }
                  }}
                >
                  {guideTtsInputs}
                </div>
              </div>
            )}

            {/* Layout 輸入欄 — 僅在編輯模式顯示 */}
            {this.state.edit_mode && (
              <div style={{ width: "220px", flexShrink: 0, borderLeft: "1px solid #ccc", backgroundColor: "#fdfdfd" }}>
                <div
                  ref={this.layoutContainerRef}
                  style={{ height: "100%", overflow: "hidden", fontFamily: "monospace", fontSize: "14px" }}
                >
                  {layoutInputs}
                </div>
              </div>
            )}
          </div>
          {/* TTS 字幕已移至底部大字幕區顯示 */}
          {lineEditorModal}
        </div>
      );
  }

  componentDidUpdate(prevProps: any, prevState: any) {
    this.updateDecorations();

    // Autosave whenever breakpoints, guide, TTS, or layout change
    if (
      prevState.breakpoints !== this.state.breakpoints ||
      prevState.inputValues !== this.state.inputValues ||
      prevState.ttsValues !== this.state.ttsValues ||
      prevState.layoutValues !== this.state.layoutValues
    ) {
      this._debouncedSaveAutosave();
    }

    // Sync Monaco readOnly / cursor class when edit_mode changes
    if (prevState.edit_mode !== this.state.edit_mode && this.editorInstance) {
      this.editorInstance.updateOptions({
        readOnly: !this.state.edit_mode,
        extraEditorClassName: this.state.edit_mode ? '' : 'gdbgui-readonly-editor',
      });
    }

    // 當 FILE_MISSING 時，嘗試從 localStorage 恢復程式碼（例如 Docker container 重啟後舊 temp 檔消失）
    if (this.state.source_code_state === constants.source_code_states.FILE_MISSING && this.state.fullname_to_render) {
      const fn = this.state.fullname_to_render;
      // 先找精確 key，再找任何 gdbgui_editor_code_* key
      let savedCode = localStorage.getItem("gdbgui_editor_code_" + fn);
      if (!savedCode || !savedCode.trim()) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("gdbgui_editor_code_")) {
            const val = localStorage.getItem(key);
            if (val && val.trim()) { savedCode = val; break; }
          }
        }
      }
      if (savedCode && savedCode.trim()) {
        const lines = savedCode.split("\n");
        const source_code_obj: any = {};
        lines.forEach((line: string, idx: number) => { source_code_obj[idx + 1] = escapeHtml(line); });
        FileOps.add_source_file_to_cache(fn, source_code_obj, Date.now() / 1000, lines.length);
        const missing = store.get("missing_files").filter((f: string) => f !== fn);
        store.set("missing_files", missing);
        store.set("source_code_state", constants.source_code_states.SOURCE_CACHED);
        (window as any).last_compiled_code = null; // 強制重新編譯，避免 stale binary
      }
    }

    // Check if filename changed to load appropriate project state for the new file
    if (prevState.fullname_to_render !== this.state.fullname_to_render && this.state.fullname_to_render) {
      const fn = this.state.fullname_to_render;
      let newInputs: any = null;
      let newTts: any = null;
      try {
        const storedInputs = localStorage.getItem("gdbgui_guide_inputs_" + fn);
        if (storedInputs) newInputs = JSON.parse(storedInputs);
        const storedTts = localStorage.getItem("gdbgui_tts_inputs_" + fn);
        if (storedTts) newTts = JSON.parse(storedTts);
      } catch (e) {
        console.error("Failed to load project state", e);
      }
      // 若新 filename 在 localStorage 沒有資料，保留記憶體中現有的 guide 資料
      // （常見情境：import JSON → 按 Run → fullname 變成實際編譯路徑，但 guide 應繼續存在）
      if (newInputs === null) {
        newInputs = this.state.inputValues || {};
        localStorage.setItem("gdbgui_guide_inputs_" + fn, JSON.stringify(newInputs));
      }
      if (newTts === null) {
        newTts = this.state.ttsValues || {};
        localStorage.setItem("gdbgui_tts_inputs_" + fn, JSON.stringify(newTts));
      }
      // 恢復 layout 資料；若新 filename 無資料則保留記憶體中的
      let newLayout: any = null;
      try {
        const storedLayout = localStorage.getItem("gdbgui_layout_inputs_" + fn);
        if (storedLayout) newLayout = JSON.parse(storedLayout);
      } catch (e) { /* ignore */ }
      if (newLayout === null) {
        newLayout = (global_variable as any).__layout || {};
        localStorage.setItem("gdbgui_layout_inputs_" + fn, JSON.stringify(newLayout));
      }
      (global_variable as any).__layout = { ...newLayout };

      this.setState({ inputValues: newInputs, ttsValues: newTts, layoutValues: newLayout });
      (global_variable as any).__line = { ...newInputs };
      (global_variable as any).__tts = { ...newTts };
      store.set("call_graph_updated", Math.random());
    }

    // 當 GDB 暫停行號改變時，套用對應的 layout
    const prevLine = prevState.paused_on_frame ? prevState.paused_on_frame.line : null;
    const curLine  = this.state.paused_on_frame  ? this.state.paused_on_frame.line  : null;
    if (curLine && curLine !== prevLine) {
      this.applyLayout(curLine);
    }

    // 檢查是否有新的 TTS 語音發送過來
    if (this.state.tts_subtitle) {
      const isNew = !prevState.tts_subtitle || prevState.tts_subtitle.timestamp !== this.state.tts_subtitle.timestamp;
      if (isNew) {
        console.log("[SourceCode] New tts_subtitle detected:", this.state.tts_subtitle);
        this.showTtsBubble();
      }
    }

    let source_is_displayed =
      this.state.source_code_state === constants.source_code_states.SOURCE_CACHED ||
      this.state.source_code_state ===
      constants.source_code_states.ASSM_AND_SOURCE_CACHED;

    if (source_is_displayed) {
      // 將源代碼存儲到global_variable以供Visualizer使用
      let obj = FileOps.get_source_file_obj_from_cache(this.state.fullname_to_render);

      // If the rendered file is the main program (rendered in Monaco editor instead of static code_body)
      let isMainEditorFile = (this.initialFullname === null) || (this.state.fullname_to_render === this.initialFullname) || (this.state.fullname_to_render.includes("uploaded_scripts") || this.state.fullname_to_render.includes("uploads/"));

      if (obj && obj.source_code_obj && isMainEditorFile) {
        // Dynamically update the known main file to support re-compilation
        this.initialFullname = obj.fullname;

        if (this.editorInstance) {
          const lines = this.editorInstance.getValue().split(/\r?\n/);
          const source_obj: any = {};
          for (let i = 0; i < lines.length; i++) {
            source_obj[i + 1] = lines[i] + "\n";
          }
          (global_variable as any).__source_code = source_obj;
        } else {
          (global_variable as any).__source_code = obj.source_code_obj;
        }
        (global_variable as any).__source_code_fullname = obj.fullname;
      }

      if (this.state.make_current_line_visible) {
        // console.log(`還沒捲動過`);
        // console.trace();
        let success = SourceCode.make_current_line_visible();
        if (success) {
          store.set("make_current_line_visible", false);
        }
      }
    }

    // 清空 inputValues 當 gdb_pid 改變時 (例如 run 時)
    if (prevState && prevState.gdb_pid !== this.state.gdb_pid) {
      // 不清空以保留指導與 TTS: this.setState({ inputValues: {} });
    }
  }

  get_body() {
    const states = constants.source_code_states;
    switch (this.state.source_code_state) {
      case states.ASSM_AND_SOURCE_CACHED: // fallthrough
      case states.SOURCE_CACHED: {
        let obj = FileOps.get_source_file_obj_from_cache(this.state.fullname_to_render);
        if (!obj) {
          console.error("expected to find source file");
          return this.get_body_empty();
        }
        let paused_addr = this.state.paused_on_frame
          ? this.state.paused_on_frame.addr
          : null,
          start_linenum = store.get("source_linenum_to_display_start"),
          end_linenum = store.get("source_linenum_to_display_end");
        return this.get_body_source_and_assm(
          obj.fullname,
          obj.source_code_obj,
          obj.assembly,
          paused_addr,
          start_linenum,
          end_linenum,
          obj.num_lines_in_file
        );
      }
      case states.FETCHING_SOURCE: {
        return (
          <tr>
            <td>fetching source, please wait</td>
          </tr>
        );
      }
      case states.ASSM_CACHED: {
        let paused_addr = this.state.paused_on_frame
          ? this.state.paused_on_frame.addr
          : null,
          assm_array = this.state.disassembly_for_missing_file;
        return this.get_body_assembly_only(assm_array, paused_addr);
      }
      case states.FETCHING_ASSM: {
        return (
          <tr>
            <td>fetching assembly, please wait</td>
          </tr>
        );
      }
      case states.ASSM_UNAVAILABLE: {
        let paused_addr = this.state.paused_on_frame
          ? this.state.paused_on_frame.addr
          : null;
        return (
          <tr>
            <td>cannot access address {paused_addr}</td>
          </tr>
        );
      }
      case states.FILE_MISSING: {
        return (
          <tr>
            <td>file not found: {this.state.fullname_to_render}</td>
          </tr>
        );
      }
      case states.NONE_AVAILABLE: {
        return this.get_body_empty();
      }
      default: {
        console.error("developer error: unhandled state");
        return this.get_body_empty();
      }
    }
  }
  click_gutter(line_num: any) {
    Breakpoints.add_or_remove_breakpoint(this.state.fullname_to_render || "", line_num);
  }

  _get_source_line(
    source: any,
    line_should_flash: any,
    is_gdb_paused_on_this_line: any,
    line_num_being_rendered: any,
    has_bkpt: any,
    has_disabled_bkpt: any,
    has_conditional_bkpt: any,
    assembly_for_line: any,
    paused_addr: any
  ) {
    let row_class = ["srccode"];

    if (is_gdb_paused_on_this_line) {
      row_class.push("paused_on_line");
    } else if (line_should_flash) {
      row_class.push("flash");
    }

    // Compile error/warning highlighting for code_body rows
    // Only show when currently displaying the user's own source file (not a library header)
    const _userSrcFn: string = (this.state as any).user_source_fullname || "";
    const _ftrNow: string = this.state.fullname_to_render || "";
    const _onUserFile = _userSrcFn !== "" && _ftrNow === _userSrcFn;
    const compileErrors: any[] = _onUserFile ? ((this.state as any).compile_errors || []) : [];
    const lineErrors = compileErrors.filter((e: any) => e.line === line_num_being_rendered);
    const hasError   = lineErrors.some((e: any) => e.severity === "error");
    const hasWarning = lineErrors.some((e: any) => e.severity === "warning");
    if (hasError)        row_class.push("compile-error-tr");
    else if (hasWarning) row_class.push("compile-warning-tr");

    let id = "";
    if (
      this.state.source_code_selection_state ===
      constants.source_code_selection_states.PAUSED_FRAME
    ) {
      if (is_gdb_paused_on_this_line) {
        id = "scroll_to_line";
      }
    } else if (
      this.state.source_code_selection_state ===
      constants.source_code_selection_states.USER_SELECTION
    ) {
      if (line_should_flash) {
        id = "scroll_to_line";
      }
    }

    let gutter_cls = "";
    if (has_disabled_bkpt) {
      gutter_cls = "disabled_breakpoint";
    } else if (has_conditional_bkpt) {
      gutter_cls = "conditional_breakpoint";
    } else if (has_bkpt) {
      gutter_cls = "breakpoint";
    }

    let assembly_content = [];
    if (assembly_for_line) {
      let i = 0;
      for (let assm of assembly_for_line) {
        assembly_content.push(SourceCode._get_assm_content(i, assm, paused_addr));
        assembly_content.push(<br key={"br" + i} />);
        i++;
      }
    }

    // Build inline error/warning badges for this line
    const errorBadges = lineErrors.map((e: any, i: number) => {
      const isErr = e.severity === "error";
      return (
        <span
          key={i}
          className="compile-error-badge"
          style={{
            marginLeft: "10px",
            fontSize: "0.82em",
            color: isErr ? "#b71c1c" : "#e65100",
            background: isErr ? "rgba(211,47,47,0.10)" : "rgba(245,124,0,0.10)",
            borderRadius: "3px",
            padding: "0 5px",
            fontFamily: "sans-serif",
            fontStyle: "italic",
            whiteSpace: "nowrap",
          }}
        >
          {isErr ? "✖" : "⚠"} {e.message}
        </span>
      );
    });

    return (
      <tr id={id} key={line_num_being_rendered} className={`${row_class.join(" ")}`}>
        {this.get_linenum_td(line_num_being_rendered, gutter_cls)}

        <td style={{ verticalAlign: "top" }} className="loc">
          <span className="wsp" dangerouslySetInnerHTML={{ __html: source }} />
          {errorBadges}
        </td>

        <td className="assembly">{assembly_content}</td>
      </tr>
    );
  }
  get_linenum_td(linenum: any, gutter_cls = "") {
    let dotColor = "";
    if (gutter_cls === "breakpoint") dotColor = "#E53935";
    else if (gutter_cls === "disabled_breakpoint") dotColor = "#EF9A9A";
    else if (gutter_cls === "conditional_breakpoint") dotColor = "#FB8C00";

    return (
      <td
        style={{ verticalAlign: "top", width: "55px", minWidth: "55px", userSelect: "none", cursor: "pointer", padding: 0 }}
        className="line_num"
        onClick={() => this.click_gutter(linenum)}
      >
        <div style={{ display: "flex", alignItems: "center", height: "19px" }}>
          {/* glyph margin — 與 Monaco glyphMargin 對齊 */}
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "19px", flexShrink: 0 }}>
            {dotColor && (
              <span style={{ display: "inline-block", width: "12px", height: "12px", borderRadius: "50%", backgroundColor: dotColor, flexShrink: 0 }} />
            )}
          </span>
          {/* line number */}
          <span style={{ color: "#ababab", fontSize: "0.9em", paddingRight: "6px" }}>{linenum}</span>
        </div>
      </td>
    );
  }

  /**
   * example return value: mov $0x400684,%edi(00) main+8 0x0000000000400585
   */
  static _get_assm_content(key: any, assm: any, paused_addr: any) {
    let opcodes = assm.opcodes ? (
      <span className="instrContent">{`(${assm.opcodes})`}</span>
    ) : (
        ""
      ),
      instruction = Memory.make_addrs_into_links_react(assm.inst),
      func_name = assm["func-name"],
      offset = assm.offset,
      addr = assm.address,
      on_current_instruction = paused_addr === assm.address,
      cls = on_current_instruction ? "current_assembly_command" : "",
      asterisk = on_current_instruction ? (
        <span
          className="glyphicon glyphicon-chevron-right"
          style={{ width: "10px", display: "inline-block" }}
        />
      ) : (
          <span style={{ width: "10px", display: "inline-block" }}> </span>
        );
    return (
      <span key={key} style={{ whiteSpace: "nowrap" }} className={cls}>
        {/* @ts-expect-error ts-migrate(2769) FIXME: Property 'fontFamily' is missing in type '{ paddin... Remove this comment to see the full error message */}
        {asterisk} <MemoryLink addr={addr} style={{ paddingRight: "5px" }} />
        {opcodes /* i.e. mov */}
        <span className="instrContent">{instruction}</span>
        {func_name ? (
          <span>
            {func_name}+{offset}
          </span>
        ) : (
            ""
          )}
      </span>
    );
  }

  _get_assm_row(key: any, assm: any, paused_addr: any) {
    return (
      <tr key={key} className="srccode">
        <td className="assembly loc">
          {SourceCode._get_assm_content(key, assm, paused_addr)}
        </td>
      </tr>
    );
  }

  is_gdb_paused_on_this_line(line_num_being_rendered: any, line_gdb_is_paused_on: any) {
    if (this.state.paused_on_frame) {
      return (
        line_num_being_rendered === line_gdb_is_paused_on &&
        this.state.paused_on_frame.fullname === this.state.fullname_to_render
      );
    } else {
      return false;
    }
  }


  get_view_more_tr(fullname: any, linenum: any, node_key: any) {
    return (
      // @ts-expect-error ts-migrate(7053) FIXME: Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
      <tr key={linenum} className="srccode" ref={el => (SourceCode[node_key] = el)}>
        <td />
        <td
          onClick={() => {
            Actions.view_file(fullname, linenum);
          }}
          style={{ fontStyle: "italic", paddingLeft: "10px" }}
          className="pointer"
        >
          view more
        </td>
      </tr>
    );
  }
  get_end_of_file_tr(linenum: any) {
    return (
      <tr key={linenum}>
        <td />
        <td style={{ fontStyle: "italic", paddingLeft: "10px", fontSize: "0.8em" }}>
          (end of file)
        </td>
      </tr>
    );
  }
  get_line_nums_to_render(
    source_code_obj: any,
    start_linenum: any,
    line_to_flash: any,
    end_linenum: any
  ) {
    let start_linenum_to_render = start_linenum;
    let end_linenum_to_render = end_linenum;
    let linenum = start_linenum;

    // go backwards from center until missing element is found
    // linenum >= start_linenum &&
    while (linenum < end_linenum) {
      if (source_code_obj.hasOwnProperty(linenum)) {
        start_linenum_to_render = linenum;
        break;
      } else {
        linenum++;
      }
    }

    linenum = end_linenum;
    while (linenum > start_linenum) {
      if (source_code_obj.hasOwnProperty(linenum)) {
        end_linenum_to_render = linenum;
        break;
      } else {
        linenum--;
      }
    }
    return { start_linenum_to_render, end_linenum_to_render };
  }
  get_body_source_and_assm(
    fullname: any,
    source_code_obj: any,
    assembly: any,
    paused_addr: any,
    start_linenum: any,
    end_linenum: any,
    num_lines_in_file: any
  ) {
    let body = [];

    let bkpt_lines = Breakpoints.get_breakpoint_lines_for_file(
      this.state.fullname_to_render
    ),
      disabled_breakpoint_lines = Breakpoints.get_disabled_breakpoint_lines_for_file(
        this.state.fullname_to_render
      ),
      conditional_breakpoint_lines = Breakpoints.get_conditional_breakpoint_lines_for_file(
        this.state.fullname_to_render
      ),
      line_gdb_is_paused_on = this.state.paused_on_frame
        ? parseInt(this.state.paused_on_frame.line)
        : 0;

    const line_of_source_to_flash = this.state.line_of_source_to_flash;
    const {
      start_linenum_to_render,
      end_linenum_to_render
    } = this.get_line_nums_to_render(
      source_code_obj,
      start_linenum,
      line_of_source_to_flash,
      end_linenum
    );

    let line_num_being_rendered = start_linenum_to_render;
    while (line_num_being_rendered <= end_linenum_to_render) {
      let cur_line_of_code = source_code_obj[line_num_being_rendered];
      let has_bkpt = bkpt_lines.indexOf(line_num_being_rendered) !== -1,
        has_disabled_bkpt =
          disabled_breakpoint_lines.indexOf(line_num_being_rendered) !== -1,
        has_conditional_bkpt =
          conditional_breakpoint_lines.indexOf(line_num_being_rendered) !== -1,
        is_gdb_paused_on_this_line = this.is_gdb_paused_on_this_line(
          line_num_being_rendered,
          line_gdb_is_paused_on
        ),
        assembly_for_line = assembly[line_num_being_rendered];

      body.push(
        this._get_source_line(
          cur_line_of_code,
          line_of_source_to_flash === line_num_being_rendered,
          is_gdb_paused_on_this_line,
          line_num_being_rendered,
          has_bkpt,
          has_disabled_bkpt,
          has_conditional_bkpt,
          assembly_for_line,
          paused_addr
        )
      );
      line_num_being_rendered++;
    }

    SourceCode.view_more_top_node = null;
    SourceCode.view_more_bottom_node = null;

    // add "view more" buttons if necessary
    if (start_linenum_to_render > start_linenum) {
      body.unshift(
        this.get_view_more_tr(fullname, start_linenum_to_render - 1, "view_more_top_node")
      );
    } else if (start_linenum !== 1) {
      body.unshift(
        this.get_view_more_tr(fullname, start_linenum - 1, "view_more_top_node")
      );
    }

    if (end_linenum_to_render < end_linenum) {
      body.push(
        this.get_view_more_tr(
          fullname,
          end_linenum_to_render + 1,
          "view_more_bottom_node"
        )
      );
    } else if (end_linenum < num_lines_in_file) {
      body.push(
        this.get_view_more_tr(fullname, line_num_being_rendered, "view_more_bottom_node")
      );
    }

    if (end_linenum_to_render === num_lines_in_file) {
      body.push(this.get_end_of_file_tr(num_lines_in_file + 1));
    }
    return body;
  }

  get_body_assembly_only(assm_array: any, paused_addr: any) {
    let body = [],
      i = 0;
    for (let assm of assm_array) {
      body.push(this._get_assm_row(i, assm, paused_addr));
      i++;
    }
    return body;
  }

  get_body_empty() {
    return (
      <tr>
        <td>no source code or assembly to display</td>
      </tr>
    );
  }

  get_input_source_rows(
    fullname: any,
    source_code_obj: any,
    start_linenum: any,
    end_linenum: any,
    num_lines_in_file: any
  ) {
    let body = [];

    const {
      start_linenum_to_render,
      end_linenum_to_render
    } = this.get_line_nums_to_render(
      source_code_obj,
      start_linenum,
      this.state.line_of_source_to_flash,
      end_linenum
    );

    let line_num_being_rendered;
    for (line_num_being_rendered = start_linenum_to_render; line_num_being_rendered <= end_linenum_to_render; line_num_being_rendered++) {
      // console.log(`Rendering input for line ${line_num_being_rendered}`);
      body.push(
        <tr key={line_num_being_rendered} className="srccode">
          <td style={{ display: "flex" }}>
            <input
              style={{ flex: "0 0 38%", fontFamily: "monospace", fontSize: "inherit" }}
              data-line={line_num_being_rendered}
              defaultValue={this.state.inputValues[line_num_being_rendered] || ''}
              placeholder={`Guide L${line_num_being_rendered}`}
              onChange={(e) => {
                const idx = parseInt((e.target as HTMLInputElement).dataset.line!);
                this.handleInputChange(idx, e.target.value);
              }}
              title="Guide"
            />
            <input
              style={{ flex: "0 0 38%", fontFamily: "monospace", fontSize: "inherit", borderLeft: "1px solid #ccc" }}
              data-line={line_num_being_rendered}
              defaultValue={this.state.ttsValues[line_num_being_rendered] || ''}
              placeholder={`TTS L${line_num_being_rendered}`}
              onChange={(e) => {
                const idx = parseInt((e.target as HTMLInputElement).dataset.line!);
                this.handleTtsChange(idx, e.target.value);
              }}
              title="TTS Script"
            />
            <input
              style={{ flex: "0 0 24%", fontFamily: "monospace", fontSize: "inherit", borderLeft: "1px solid #ccc" }}
              data-line={line_num_being_rendered}
              defaultValue={this.state.layoutValues[line_num_being_rendered] || ''}
              placeholder="sidebar:50 open:container"
              onChange={(e) => {
                const idx = parseInt((e.target as HTMLInputElement).dataset.line!);
                this.handleLayoutChange(idx, e.target.value);
              }}
              title="Layout (e.g. sidebar:50 open:container close:locals)"
            />
          </td>
        </tr>
      );
    }

    // add "view more" buttons if necessary, but for inputs, make empty
    if (start_linenum_to_render > start_linenum) {
      body.unshift(
        <tr key={start_linenum_to_render - 1} className="srccode">
          <td />
        </tr>
      );
    } else if (start_linenum !== 1) {
      body.unshift(
        <tr key={start_linenum - 1} className="srccode">
          <td />
        </tr>
      );
    }

    if (end_linenum_to_render < end_linenum) {
      body.push(
        <tr key={end_linenum_to_render + 1} className="srccode">
          <td />
        </tr>
      );
    } else if (end_linenum < num_lines_in_file) {
      body.push(
        <tr key={line_num_being_rendered} className="srccode">
          <td />
        </tr>
      );
    }

    if (end_linenum_to_render === num_lines_in_file) {
      body.push(
        <tr key={num_lines_in_file + 1}>
          <td />
        </tr>
      );
    }
    return body;
  }

  get_input_empty() {
    return (
      <tr>
        <td></td>
      </tr>
    );
  }

  get_input_rows() {
    const states = constants.source_code_states;
    switch (this.state.source_code_state) {
      case states.ASSM_AND_SOURCE_CACHED: // fallthrough
      case states.SOURCE_CACHED: {
        let obj = FileOps.get_source_file_obj_from_cache(this.state.fullname_to_render);
        if (!obj) {
          return this.get_input_empty();
        }
        let start_linenum = store.get("source_linenum_to_display_start"),
          end_linenum = store.get("source_linenum_to_display_end");
        return this.get_input_source_rows(
          obj.fullname,
          obj.source_code_obj,
          start_linenum,
          end_linenum,
          obj.num_lines_in_file
        );
      }
      default: {
        return this.get_input_empty();
      }
    }
  }
  static make_current_line_visible() {
    return SourceCode._make_jq_selector_visible($("#scroll_to_line"));
  }
  static is_source_line_visible(jq_selector: any) {
    if (jq_selector.length !== 1) {
      throw "Unexpected jquery selector";
    }

    let scroll_container = jq_selector.closest("div");
    let container_top = scroll_container.offset() ? scroll_container.offset().top : 0;
    let container_height = scroll_container.height() || 100;
    let container_bottom = container_top + container_height;

    let line_top = jq_selector.offset() ? jq_selector.offset().top : 0;
    let line_height = jq_selector.height() || 20;
    let line_bottom = line_top + line_height;

    let is_visible = line_top >= container_top && line_bottom <= container_bottom;

    return { is_visible, line_top, container_top, height_of_container: container_height, scroll_container };
  }

  /**
   * Scroll to a jQuery selection in the source code table
   * Used to jump around to various lines
   * returns true on success
   */
  static _make_jq_selector_visible(jq_selector: any) {
    if (jq_selector.length === 1) {
      // make sure something is selected before trying to scroll to it
      const {
        is_visible,
        line_top,
        container_top,
        height_of_container,
        scroll_container
      } = SourceCode.is_source_line_visible(jq_selector);

      if (!is_visible) {
        // line is out of view, scroll so it's in the middle of the table
        const time_to_scroll = 0;
        let scroll_adjustment = line_top - container_top - (height_of_container / 2);
        let new_scroll_top = scroll_container.scrollTop() + scroll_adjustment;

        scroll_container.animate({ scrollTop: new_scroll_top }, time_to_scroll);
      }
      return true;
    } else {
      return false;
    }
  }
}

export default SourceCode;
