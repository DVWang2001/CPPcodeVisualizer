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
import { parseAnnotations, parseLineAnnotation, upsertLineAnnotation } from "./sourceAnnotations";
import { normalizeBundle } from "./bundleAdapter";
import ReactDOM from "react-dom";
import LineAnnotationPanel, { LinePanelDraft } from "./LineAnnotationPanel";
import { lineIdentifiers } from "./lineIdentifiers";
import { parseForHeader, segRange } from "./forHeader";
import LessonGenPanel from "./LessonGenPanel";

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

    this.state = {
      lineCount: 0,
      hoverLine: null as number | null, // gutter breakpoint-hover highlight (not panel-related)
      linePanel: null as null | {
        lineNum: number;
        mode: "simple" | "advanced";
        draft: LinePanelDraft;
        candidates: string[];
      },
      showLessonGen: false,
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
      "monaco_font_size",
      "for_sub_step",
    ]);

    // bind methods
    this.get_body_assembly_only = this.get_body_assembly_only.bind(this);
    this._get_source_line = this._get_source_line.bind(this);
    this._get_assm_row = this._get_assm_row.bind(this);
    this.click_gutter = this.click_gutter.bind(this);
    this.is_gdb_paused_on_this_line = this.is_gdb_paused_on_this_line.bind(this);
  }

  refreshAnnotationGlobals = () => {
    const code = this.editorInstance?.getValue?.() || "";
    const { guide, tts, layout } = parseAnnotations(code);
    (global_variable as any).__line = guide;
    (global_variable as any).__tts = tts;
    (global_variable as any).__layout = layout;
  };

  componentDidMount() {
    // /?lesson=<id>：從教案庫或個人檔案頁點進來的。伺服器上的那一篇優先於
    // localStorage 的 autosave——使用者剛剛才明確選了要開哪一篇教案。
    const requestedLesson = this.lessonIdFromUrl();
    if (requestedLesson !== null) {
      window.addEventListener("beforeunload", this.saveAutosave);
      this.loadLessonFromServer(requestedLesson);
      return;
    }

    // 優先從 autosave JSON 還原（最可靠，格式同 Export JSON）
    try {
      const raw = JSON.parse(localStorage.getItem("gdbgui_autosave") || "null");
      if (raw && (raw.source_code || raw.line_data)) {
        const v2 = normalizeBundle(raw);
        // if we upgraded a v1 bundle, persist the v2 form back
        if (raw.line_data) localStorage.setItem("gdbgui_autosave", JSON.stringify(v2));
        if (v2.fullname_to_render) this.setState({ fullname_to_render: v2.fullname_to_render } as any);
        (global_variable as any).__pending_source_code = v2.source_code;
        if (v2.breakpoints) store.set("breakpoints", v2.breakpoints);
        if (v2.program_input) store.set("program_input", v2.program_input);
        window.addEventListener("beforeunload", this.saveAutosave);
        return;
      }
    } catch (_) {}

    // No autosave found: guide/tts/layout now live inside the source text itself
    // (as trailing //@ comments), so there is nothing separate to restore here.
    // refreshAnnotationGlobals() (called on editor mount) will parse whatever
    // source text loads and populate the globals from it.
    window.addEventListener("beforeunload", this.saveAutosave);
  }

  editorInstance: any = null;
  monaco: any = null;
  decorations: any[] = [];
  directiveDecorations: string[] = [];
  _autosaveTimer: any = null;
  panelZoneId: string | null = null;
  panelDomNode: HTMLDivElement | null = null;
  annotWidget: any = null;
  annotWidgetLine: number | null = null;

  // Column the ✎ widget anchors to on a line: at the `//@` start if present,
  // else just past the end of the code (where a new //@ would be added).
  _annotWidgetColumn = (line: number): number => {
    const model = this.editorInstance?.getModel();
    if (!model) return 1;
    const text = model.getLineContent(line);
    const idx = text.indexOf("//@");
    if (idx !== -1) return idx + 1;
    return text.replace(/\s+$/, "").length + 2;
  };

  refreshDirectiveDecorations = () => {
    if (!this.editorInstance || !this.monaco) return;
    const model = this.editorInstance.getModel();
    if (!model) return;
    const decos: any[] = [];
    const total = model.getLineCount();
    for (let ln = 1; ln <= total; ln++) {
      const text = model.getLineContent(ln);
      const idx = text.indexOf("//@");
      if (idx === -1) continue;
      decos.push({
        range: new this.monaco.Range(ln, idx + 1, ln, text.length + 1),
        options: { inlineClassName: "gdbgui-directive-comment" },
      });
    }
    this.directiveDecorations = this.editorInstance.deltaDecorations(this.directiveDecorations, decos);
  };

  componentWillUnmount() {
    window.removeEventListener("beforeunload", this.saveAutosave);
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this.closeLinePanel();
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

      localStorage.setItem("gdbgui_autosave", JSON.stringify({
        version: "2.0",
        fullname_to_render: this.state.fullname_to_render || "",
        source_code,
        breakpoints: store.get("breakpoints") || [],
        program_input: store.get("program_input") || "",
      }));
    } catch (_) {}
  };

  _debouncedSaveAutosave = () => {
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(this.saveAutosave, 800);
  };
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
    const pending = (global_variable as any).__pending_source_code;
    if (typeof pending === "string") {
      editor.setValue(pending);
      (global_variable as any).__pending_source_code = undefined;
    }
    this.refreshAnnotationGlobals();
    this.monaco = (window as any).monaco;
    this.refreshDirectiveDecorations();
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

    // Read Monaco's actual computed line height and content height so Visualizer
    // can use the exact same values for row sizing and scroll-area height.
    const _syncMonacoMetrics = () => {
      if (!this.editorInstance || !this.monaco) return;
      const actualLH: number = this.editorInstance.getOption(
        this.monaco.editor.EditorOption.lineHeight
      );
      if (actualLH > 0) store.set("monaco_line_height", actualLH);
      const h: number = this.editorInstance.getLayoutInfo().height;
      if (h > 0) store.set("monaco_content_height", h);
    };
    setTimeout(_syncMonacoMetrics, 100);
    // Keep height in sync when the pane is resized (e.g., Split.js drag)
    editor.onDidLayoutChange(() => _syncMonacoMetrics());

    // Sync scroll
    editor.onDidScrollChange((e: any) => {
      // Sync right-sidebar Visualizer scroll so line numbers align with Monaco
      if (typeof (window as any).gdbgui_set_visualizer_scroll === "function") {
        (window as any).gdbgui_set_visualizer_scroll(e.scrollTop);
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

    // 當程式碼行數增減時，shift 既有斷點的行號（guide/tts/layout 已內嵌於原始碼中，
    // 會隨程式碼本身一起移動，不需要額外對齊機制）
    const shiftBreakpointsOnLineChange = (changes: any[]) => {
      // Monaco changes 是由上到下排列，需倒序處理避免偏移累積
      const sortedChanges = [...changes].sort(
        (a, b) => b.range.startLineNumber - a.range.startLineNumber
      );
      const anyChange = sortedChanges.some((change) => {
        const removedLines = change.range.endLineNumber - change.range.startLineNumber;
        const addedLines = (change.text.match(/\n/g) || []).length;
        return addedLines - removedLines !== 0;
      });
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
    };

    // Listen for changes
    let saveTimeout: any;
    editor.onDidChangeModelContent((e: any) => {
      shiftBreakpointsOnLineChange(e.changes);
      updateLineCount();
      this.refreshAnnotationGlobals();
      this.refreshDirectiveDecorations();
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

    // The ✎ annotation-edit affordance is a content widget (created below) that
    // follows the hovered line; it handles its own click, so onMouseDown only
    // needs the breakpoint gutter behaviour.
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
      const pos = e.target && e.target.position;
      // ✎ widget: reveal on ANY part of a line the mouse is over (content or gutter).
      // When the mouse is over the widget itself, target.position is null, so the
      // widget stays put on its line (and remains clickable).
      if (pos && this.annotWidget && this.annotWidgetLine !== pos.lineNumber) {
        this.annotWidgetLine = pos.lineNumber;
        this.editorInstance.layoutContentWidget(this.annotWidget);
      }
      // breakpoint hover glyph: gutter only (unchanged)
      if (this.monaco && pos) {
        const t = e.target.type;
        const M = this.monaco.editor.MouseTargetType;
        if (t === M.GUTTER_GLYPH_MARGIN || t === M.GUTTER_LINE_NUMBERS || t === M.GUTTER_LINE_DECORATIONS) {
          if (this.state.hoverLine !== pos.lineNumber) this.setState({ hoverLine: pos.lineNumber });
          return;
        }
      }
      if (this.state.hoverLine !== null) this.setState({ hoverLine: null });
    });

    editor.onMouseLeave(() => {
      if (this.annotWidgetLine !== null && this.annotWidget) {
        this.annotWidgetLine = null;
        this.editorInstance.layoutContentWidget(this.annotWidget);
      }
      if (this.state.hoverLine !== null) this.setState({ hoverLine: null });
    });

    // ✎ content widget — sits at the //@ start (or just past end of code) of the
    // hovered line; clicking it opens that line's annotation panel.
    {
      const dom = document.createElement("span");
      dom.className = "gdbgui-annot-edit-glyph";
      dom.title = "編輯此行註釋 (guide / TTS / layout)";
      dom.style.pointerEvents = "auto";
      dom.style.zIndex = "40";
      dom.onmousedown = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (this.annotWidgetLine) this.openLinePanel(this.annotWidgetLine);
      };
      this.annotWidget = {
        getId: () => "gdbgui.annot.edit.widget",
        getDomNode: () => dom,
        getPosition: () => (this.annotWidgetLine == null || !this.monaco) ? null : {
          position: { lineNumber: this.annotWidgetLine, column: this._annotWidgetColumn(this.annotWidgetLine) },
          preference: [this.monaco.editor.ContentWidgetPositionPreference.EXACT],
        },
      };
      editor.addContentWidget(this.annotWidget);
    }
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
      // for 迴圈三段式單步：在整行 paused_on_line 之上「多疊一層」字元範圍高亮，
      // 標出目前停在 A / B / C 哪一段。整行高亮本身完全不動。
      // for_sub_step 為 null（非 for 行、或該行解析不出三段）時什麼都不加。
      const sub = this.state.for_sub_step;
      if (sub && sub.line === line) {
        const model = this.editorInstance.getModel();
        // getLineContent 會對超出範圍的行號丟例外（整行裝飾的 Range 則會被 Monaco
        // 容忍），所以停在別的檔案或程式已結束時必須先擋掉，否則 render 會炸。
        const lineInModel = !!model && line >= 1 && line <= model.getLineCount();
        const segs = lineInModel ? parseForHeader(model.getLineContent(line)) : null;
        if (segs) {
          const [seg_start, seg_end] = segRange(segs, sub.seg);
          if (seg_end > seg_start) {
            newDecorations.push({
              range: new this.monaco.Range(line, seg_start + 1, line, seg_end + 1),
              options: { inlineClassName: "for_seg_active" },
            });
          }
        }
      }
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

  // ── Line annotation (guide/tts/layout) parse/build helpers, shared by openLinePanel/saveLinePanel ──

  /** 將 TTS 字串拆解為 speed / continue / 本文 三個欄位 */
  _parseTts(tts: string) {
    let text = tts || '';
    let speed = '';
    let hasContinue = false;
    const speedM = /\[speed:([\d.]+)\]/.exec(text);
    if (speedM) { speed = speedM[1]; text = text.replace(speedM[0], ''); }
    if (text.includes('[continue]')) { hasContinue = true; text = text.replace('[continue]', ''); }
    return { speed, hasContinue, text: text.replace(/^\s+/, "") };
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
    const fields: any = { sidebar: '', open: '', close: '', maze: '', bst: '' };
    (layout || '').trim().split(/\s+/).forEach(token => {
      const c = token.indexOf(':');
      if (c < 0) return;
      const k = token.slice(0, c), v = token.slice(c + 1);
      if (k in fields) fields[k] = v;
    });
    return fields;
  }

  /** 將結構化欄位重新組合成 Layout 字串 */
  _buildLayout(sidebar: string, open: string, close: string, maze: string, bst: string = '') {
    const parts: string[] = [];
    if (sidebar.trim()) parts.push(`sidebar:${sidebar.trim()}`);
    if (open.trim())    parts.push(`open:${open.trim()}`);
    if (close.trim())   parts.push(`close:${close.trim()}`);
    if (maze.trim())    parts.push(`maze:${maze.trim()}`);
    if (bst.trim())     parts.push(`bst:${bst.trim()}`);
    return parts.join(' ');
  }

  /** Candidate variable names offered as insertable chips in the panel's advanced mode:
   *  real frame locals when paused, else identifiers parsed off the line being edited. */
  candidatesFor = (lineNum: number): string[] => {
    const locals = (store.get("locals") as any[]) || [];
    const names = locals.map(l => l && l.name).filter(Boolean);
    if (names.length > 0) return names;                 // paused: real frame vars
    const model = this.editorInstance?.getModel();
    return model ? lineIdentifiers(model.getLineContent(lineNum)) : []; // editing: parse the line
  };

  /** Open the inline view-zone panel for a line, pre-filled from that line's //@ annotation. */
  openLinePanel = (lineNum: number) => {
    if (!this.editorInstance || !this.monaco) return;
    this.closeLinePanel();
    const model = this.editorInstance.getModel();
    const a = parseLineAnnotation(model.getLineContent(lineNum));
    const t = this._parseTts(a.tts);
    const l = this._parseLayout(a.layout);
    const draft: LinePanelDraft = {
      guide: a.guide, ttsSpeed: t.speed, ttsContinue: t.hasContinue, ttsText: t.text,
      layoutSidebar: l.sidebar, layoutOpen: l.open, layoutClose: l.close, layoutMaze: l.maze, layoutBst: l.bst,
    };
    const mode = (store.get("annot_panel_mode") === "advanced" ? "advanced" : "simple") as "simple" | "advanced";
    const dom = document.createElement("div");
    this.panelDomNode = dom;
    this.editorInstance.changeViewZones((acc: any) => {
      this.panelZoneId = acc.addZone({ afterLineNumber: lineNum, heightInPx: 120, domNode: dom });
    });
    this.setState({ linePanel: { lineNum, mode, draft, candidates: this.candidatesFor(lineNum) } });
  };

  closeLinePanel = () => {
    if (this.panelZoneId && this.editorInstance) {
      const id = this.panelZoneId;
      this.editorInstance.changeViewZones((acc: any) => acc.removeZone(id));
    }
    this.panelZoneId = null; this.panelDomNode = null;
    if (this.state.linePanel) this.setState({ linePanel: null });
  };

  setPanelHeight = (px: number) => {
    if (!this.panelZoneId || !this.editorInstance) return;
    const id = this.panelZoneId, dom = this.panelDomNode, ln = this.state.linePanel?.lineNum;
    this.editorInstance.changeViewZones((acc: any) => { acc.removeZone(id); if (dom && ln) this.panelZoneId = acc.addZone({ afterLineNumber: ln, heightInPx: px + 8, domNode: dom }); });
  };

  /** Save the panel's draft by upserting the line's //@ comment directly in Monaco.
   *  onDidChangeModelContent then refreshes globals + autosave automatically. */
  saveLinePanel = () => {
    const p = this.state.linePanel; if (!p || !this.editorInstance || !this.monaco) return;
    const d = p.draft;
    const annotation = {
      guide: d.guide || "",
      tts: this._buildTts(d.ttsSpeed, d.ttsContinue, d.ttsText),
      layout: this._buildLayout(d.layoutSidebar, d.layoutOpen, d.layoutClose, d.layoutMaze, d.layoutBst),
    };
    const model = this.editorInstance.getModel();
    const oldLine = model.getLineContent(p.lineNum);
    const newLine = upsertLineAnnotation(oldLine, annotation);
    // Use a model-level edit (not editor.executeEdits, which is a no-op when the
    // editor is readOnly) so save works in play mode too, where the editor is
    // mounted with readOnly: !edit_mode.
    model.pushEditOperations([], [{ range: new this.monaco.Range(p.lineNum, 1, p.lineNum, oldLine.length + 1), text: newLine }], () => null);
    this.closeLinePanel();
  };

  // ─────────────────────────────────────────────────────────────────────────

  applyLayout = (lineNum: string | number) => {
    const layoutMap = (global_variable as any).__layout || {};
    if (!layoutMap) return;
    const layoutStr: string = layoutMap[String(lineNum)];
    if (!layoutStr) return;

    console.log("[applyLayout] line:", lineNum, "layout:", layoutStr);

    const registry = (window as any).gdbgui_collapser_registry || {};
    console.log("[applyLayout] registry keys:", Object.keys(registry));

    // 面板別名：UI 提示與教案常用 "memory"/"pointer"，但實際 Collapser id 是 "memory_watch"。
    // 不解析別名的話 open:memory 既開不到面板，又會被「關閉其他面板」邏輯把真正的
    // 記憶體與指標追蹤面板關掉。
    const PANEL_ALIASES: Record<string, string> = { memory: "memory_watch", pointer: "memory_watch" };
    const resolveId = (id: string) => PANEL_ALIASES[id] || id;

    // 先收集所有 open: 指定的 id，再關閉其他所有面板，達到「只顯示指定面板」的效果
    const tokens = layoutStr.trim().split(/\s+/);
    const idsToOpen = new Set<string>();
    for (const token of tokens) {
      const colonIdx = token.indexOf(":");
      if (colonIdx < 0) continue;
      if (token.slice(0, colonIdx) === "open") {
        token.slice(colonIdx + 1).split(",").forEach((id: string) => idsToOpen.add(resolveId(id.trim())));
      }
    }
    if (idsToOpen.size > 0) {
      Object.keys(registry).forEach((id: string) => {
        if (!idsToOpen.has(id) && registry[id]) registry[id].close();
      });
    }

    for (const token of tokens) {
      const colonIdx = token.indexOf(":");
      if (colonIdx < 0) continue;
      const key = token.slice(0, colonIdx);
      const val = token.slice(colonIdx + 1);

      if (key === "sidebar") {
        const pct = parseFloat(val);
        if (!isNaN(pct)) {
          try {
            const splitObj = store.get("middle_panes_split_obj");
            console.log("[applyLayout] splitObj:", splitObj, "hasSizes:", typeof splitObj?.setSizes);
            if (splitObj && typeof splitObj.setSizes === "function") {
              const showFs = store.get("show_filesystem");
              if (showFs) {
                const fsPct = 30;
                splitObj.setSizes([fsPct, Math.max(0, 69 - pct), pct]);
              } else {
                splitObj.setSizes([0, Math.max(0, 99 - pct), pct]);
              }
            }
          } catch (e) {
            console.warn("[applyLayout] sidebar setSizes failed:", e);
          }
        }
      } else if (key === "open") {
        val.split(",").forEach((raw: string) => {
          const id = resolveId(raw.trim());
          console.log("[applyLayout] opening:", raw, "→", id, "exists:", !!registry[id]);
          if (registry[id]) registry[id].open();
        });
      } else if (key === "close") {
        val.split(",").forEach((raw: string) => {
          const id = resolveId(raw.trim());
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
      } else if (key === "bst") {
        // bst:containerName1,containerName2 → 自動勾選 BST 模式
        const setBstMode = (window as any).gdbgui_set_bst_mode;
        if (setBstMode) {
          val.split(",").forEach((containerName: string) => {
            setBstMode(containerName.trim(), true);
          });
        }
      } else if (key === "font") {
        // font:1.5 → 設定 Container Visualizer 字體大小（em）
        const size = parseFloat(val);
        if (!isNaN(size) && size > 0) {
          store.set("container_font_size", size);
          localStorage.setItem("container_font_size", String(size));
        }
      }
    }
  };

  clearAllBreakpoints = () => {
    store.set("breakpoints", []);
    localStorage.setItem("breakpoints", JSON.stringify([]));
    GdbApi.run_gdb_command(["-interpreter-exec console \"delete\"", GdbApi.get_break_list_cmd()]);
  };

  // 目前編輯中的內容做成一份 bundle。Export JSON（下載成檔案）與
  // 「存到我的帳號」（存進伺服器）送出去的是同一份東西。
  buildProjectBundle = () => {
    // Mirror saveAutosave's v2 bundle shape exactly: source_code already carries
    // the //@ comments inline, so there is no separate line_data to emit. Emitting
    // line_data here would make normalizeBundle() re-append every directive on
    // import, corrupting the source and compounding on each export/import cycle.
    const source_code = this.editorInstance ? this.editorInstance.getValue() : "";
    const programInput = localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "";
    const breakpoints = store.get("breakpoints") || [];

    return {
      version: "2.0",
      fullname_to_render: this.state.fullname_to_render || "",
      source_code: source_code,
      breakpoints: breakpoints,
      program_input: programInput,
    };
  };

  exportProject = () => {
    const projectData = this.buildProjectBundle();

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

  applyGeneratedCode = (code: string) => {
    const model = this.editorInstance?.getModel?.();
    if (!model || !this.editorInstance) return;
    this.editorInstance.pushUndoStop();
    // Model-level edit (not editor.executeEdits, which is a no-op when the
    // editor is readOnly) so apply works in play mode too, like saveLinePanel.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
    this.editorInstance.pushUndoStop();
  };

  handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        this.applyProjectBundle(JSON.parse(content));
      } catch (err) {
        console.error("Error parsing project file", err);
        Actions.add_console_entries("Error parsing project file", constants.console_entry_type.STD_ERR);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // 把一份 bundle 套進編輯器。「Import JSON」（本機檔案）與「從教案庫開啟」
  // （伺服器上的教案）走同一條路徑：兩邊拿到的是同一種 bundle 物件，拆成兩份
  // 實作就會有一天只有其中一邊懂新的欄位。
  applyProjectBundle = (projectData: any) => {
        // 若 GDB inferior 正在執行或暫停中，先強制終止，再套用新的 bundle
        const infState = store.get("inferior_program");
        if (
          infState === constants.inferior_states.running ||
          infState === constants.inferior_states.paused
        ) {
          GdbApi.run_gdb_command("kill");
          Actions.inferior_program_exited();
        }

        // Legacy (v1) projects carry guide/tts/layout separately in line_data;
        // normalizeBundle merges that into //@ comments on the matching source lines
        // so the imported source text becomes the single source of truth. Projects
        // already exported in the new format (no line_data) pass through unchanged.
        const v2 = normalizeBundle(projectData);
        const mergedSource: string = v2.source_code || projectData.source_code || "";

        if (mergedSource) {
          if (this.editorInstance) {
            this.editorInstance.setValue(mergedSource);
            // 強制下次 Start 一定重新編譯（不論程式碼內容是否與上次相同）
            (window as any).last_compiled_code = null;
          } else {
            // Monaco 尚未掛載（FILE_MISSING / NONE_AVAILABLE 狀態）
            //
            // 交棒給 handleEditorDidMount。少了這一行，/?lesson= 在暖快取下會
            // 靜默失敗：bundle 已經收到、也寫進了下面的 cache 與 localStorage，
            // 但 Monaco 早一步用預設值建好 model，之後沒有任何東西再回頭去讀。
            // 冷載入時 Monaco 慢、教案先落地，所以看起來是間歇性的——實際上
            // 只取決於 fetch 與 Monaco 掛載誰先到。
            (global_variable as any).__pending_source_code = mergedSource;

            // 將 source_code 直接注入 FileOps cache，讓 Monaco 立刻顯示
            const lines = mergedSource.split("\n");
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
            localStorage.setItem("gdbgui_editor_code_" + syntheticFullname, mergedSource);
            // 清除 last_compiled_code，避免 Run 誤判「程式碼未變」而跳過重新 compile
            (window as any).last_compiled_code = null;
          }
          // 把 import 進來的程式碼存進 localStorage 的 fallback 鏈：
          // get_monaco_value 在 Monaco 重新 mount 時會先查 gdbgui_last_edited_filename，
          // 若不存此處，Monaco 重 mount 後會撈回舊檔案，導致 Run 時跑舊程式碼。
          const _importKey = "__imported__";
          localStorage.setItem("gdbgui_editor_code_" + _importKey, mergedSource);
          localStorage.setItem("gdbgui_editor_filename_" + _importKey, _importKey);
          localStorage.setItem("gdbgui_last_edited_filename", _importKey);
        }

        // refreshAnnotationGlobals() will also run via onDidChangeModelContent once
        // Monaco processes the setValue() above; call it directly too so
        // global_variable.__line/__tts/__layout are correct even if Monaco isn't
        // mounted yet (it re-parses on mount in that case).
        if (this.editorInstance) {
          this.refreshAnnotationGlobals();
        }

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
  };

  // ── 教案分享 ───────────────────────────────────────────────────────────────
  //
  // Import JSON / Export JSON（本機檔案）保留不動——備份與離線交換仍然有用。
  // 底下這兩顆是另一條路：存進自己的帳號、從教案庫開啟別人的。
  //
  // 擁有權完全由伺服器決定（session 裡的 user_id）。前端這裡送出的 lesson id
  // 只是「要更新哪一篇」，不是「這篇算誰的」——PUT 到別人的教案時伺服器會在
  // 呼叫者名下建立一份副本，所以下面不需要、也不應該自己判斷「這篇是不是我的」。

  //: 目前這份內容對應到伺服器上的哪一篇教案（沒有就是還沒存過）。
  currentLessonId: number | null = null;
  currentLessonTitle: string | null = null;

  lessonIdFromUrl = (): number | null => {
    try {
      const raw = new URLSearchParams(window.location.search).get("lesson");
      if (!raw) return null;
      const id = parseInt(raw, 10);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch (_) {
      return null;
    }
  };

  loadLessonFromServer = (lessonId: number) => {
    fetch(`/api/lessons/${lessonId}`, { credentials: "same-origin" })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("load failed"))
      )
      .then((payload) => {
        this.currentLessonId = payload.id;
        this.currentLessonTitle = payload.title;
        this.applyProjectBundle(payload.bundle || {});
        Actions.add_console_entries(
          `已載入教案「${payload.title}」（作者：${payload.author_display_name}）。` +
            (payload.is_mine ? "" : " 儲存時會存成你自己的一份副本。"),
          constants.console_entry_type.GDBGUI_OUTPUT
        );
      })
      .catch(() => {
        Actions.add_console_entries(
          "無法載入教案。",
          constants.console_entry_type.STD_ERR
        );
      });
  };

  saveLessonToAccount = () => {
    const suggested = this.currentLessonTitle || "我的教案";
    const title = window.prompt("教案標題", suggested);
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) {
      window.alert("標題不可為空。");
      return;
    }

    const isUpdate = this.currentLessonId !== null;
    fetch(isUpdate ? `/api/lessons/${this.currentLessonId}` : "/api/lessons", {
      method: isUpdate ? "PUT" : "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-csrftoken": (window as any).initial_data?.csrf_token || "",
      },
      body: JSON.stringify({ title: trimmed, bundle: this.buildProjectBundle() }),
    })
      .then((response) =>
        response
          .json()
          .catch(() => ({}))
          .then((payload: any) => {
            if (!response.ok) {
              throw new Error(payload.message || "儲存失敗。");
            }
            return payload;
          })
      )
      .then((payload: any) => {
        this.currentLessonId = payload.id;
        this.currentLessonTitle = trimmed;
        Actions.add_console_entries(
          payload.forked
            ? `這篇教案不是你的，已在你名下另存一份「${trimmed}」（原作者的版本沒有被更動）。`
            : `教案「${trimmed}」已儲存到你的帳號。`,
          constants.console_entry_type.GDBGUI_OUTPUT
        );
      })
      .catch((err: any) => {
        window.alert(err && err.message ? err.message : "儲存失敗。");
      });
  };

  openLessonLibrary = () => {
    window.location.href = "/lessons";
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
      const monacoFontSize: number = (this.state as any).monaco_font_size || 14;
      const LINE_HEIGHT = Math.round(monacoFontSize * 1.5);

      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", position: "relative" }}>
          <div style={{ padding: "4px 8px", backgroundColor: "#f5f5f5", borderBottom: "1px solid #ddd", fontSize: "14px", fontFamily: "monospace", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{(this.state.fullname_to_render || "").split(/[\\/]/).pop() || this.state.fullname_to_render}</strong>
            <div>
              <button
                onClick={() => this.setState({ showLessonGen: !(this.state as any).showLessonGen } as any)}
                className="btn btn-default btn-sm"
                title="用 AI 模型為目前程式碼生成 //@ 教案註解"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", marginRight: "4px" }}>
                🤖 AI 生成教案
              </button>
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
              {/* Import/Export JSON 讀寫本機檔案（備份與離線交換）；底下兩顆是
                  帳號那條路：存進伺服器、以及瀏覽別人的教案。 */}
              <button
                onClick={this.saveLessonToAccount}
                data-testid="save-lesson-to-account"
                className="btn btn-default btn-sm"
                title="把目前的程式碼與斷點存成你帳號底下的一篇教案"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", marginRight: "4px" }}>
                存到我的帳號
              </button>
              <button
                onClick={this.openLessonLibrary}
                data-testid="open-lesson-library"
                className="btn btn-default btn-sm"
                title="瀏覽所有人的教案"
                style={{ height: "24px", padding: "2px 8px", fontSize: "12px", marginRight: "4px" }}>
                從教案庫開啟
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
          {(this.state as any).showLessonGen && (
            <LessonGenPanel
              getSource={() => this.editorInstance?.getValue?.() || ""}
              onApply={(code) => {
                this.applyGeneratedCode(code);
                this.setState({ showLessonGen: false } as any);
              }}
              onClose={() => this.setState({ showLessonGen: false } as any)}
            />
          )}
          <div className={this.state.current_theme} style={{ flex: 1, width: "100%", display: "flex", overflow: 'hidden' }}>
            <div style={{ flex: 1, height: "100%", position: 'relative' }}>
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
                  fontSize: monacoFontSize,
                  lineHeight: LINE_HEIGHT
                }}
              />
            </div>
          </div>
          {/* TTS 字幕已移至底部大字幕區顯示 */}
          {this.state.linePanel && this.panelDomNode && ReactDOM.createPortal(
            <LineAnnotationPanel
              lineNum={this.state.linePanel.lineNum}
              mode={this.state.linePanel.mode}
              draft={this.state.linePanel.draft}
              candidates={this.state.linePanel.candidates}
              onDraftChange={(patch) => this.setState({ linePanel: { ...this.state.linePanel!, draft: { ...this.state.linePanel!.draft, ...patch } } })}
              onToggleMode={() => { const m = this.state.linePanel!.mode === "simple" ? "advanced" : "simple"; store.set("annot_panel_mode", m); this.setState({ linePanel: { ...this.state.linePanel!, mode: m } }); }}
              onSave={this.saveLinePanel}
              onClose={this.closeLinePanel}
              onHeight={this.setPanelHeight}
            />,
            this.panelDomNode
          )}
        </div>
      );
  }

  componentDidUpdate(prevProps: any, prevState: any) {
    this.updateDecorations();

    // Autosave whenever breakpoints change. (Guide/TTS/layout edits go through
    // Monaco model edits, not React state, and beforeunload/saveAutosave already
    // captures the live source text — including any //@ comments — separately.)
    if (prevState.breakpoints !== this.state.breakpoints) {
      this._debouncedSaveAutosave();
    }

    // Sync Monaco readOnly / cursor class when edit_mode changes
    if (prevState.edit_mode !== this.state.edit_mode && this.editorInstance) {
      this.editorInstance.updateOptions({
        readOnly: !this.state.edit_mode,
        extraEditorClassName: this.state.edit_mode ? '' : 'gdbgui-readonly-editor',
      });
    }

    // Sync Monaco font size when monaco_font_size changes
    if ((prevState as any).monaco_font_size !== (this.state as any).monaco_font_size && this.editorInstance) {
      const fs = (this.state as any).monaco_font_size || 14;
      this.editorInstance.updateOptions({
        fontSize: fs,
        lineHeight: Math.round(fs * 1.5),
      });
      // Read back Monaco's actual computed line height after options are applied
      if (this.monaco) {
        const actualLH: number = this.editorInstance.getOption(
          this.monaco.editor.EditorOption.lineHeight
        );
        if (actualLH > 0) store.set("monaco_line_height", actualLH);
      }
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

    // Note: guide/tts/layout no longer need a per-file restore step on filename
    // change — they live inside the source text itself and refreshAnnotationGlobals()
    // (triggered by onDidChangeModelContent whenever Monaco's content changes, which
    // it does when switching files) keeps global_variable.__line/__tts/__layout in sync.

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
