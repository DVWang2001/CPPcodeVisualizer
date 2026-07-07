// gdbgui/src/js/LineAnnotationPanel.tsx
import React from "react";
import { insertAtCursor, filterCandidates, replaceRange, activeTokenStart } from "./lineIdentifiers";

export type LinePanelDraft = {
  guide: string; ttsSpeed: string; ttsContinue: boolean; ttsText: string;
  layoutSidebar: string; layoutOpen: string; layoutClose: string; layoutMaze: string; layoutBst: string;
};
type Props = {
  lineNum: number; mode: "simple" | "advanced"; draft: LinePanelDraft; candidates: string[];
  onDraftChange: (patch: Partial<LinePanelDraft>) => void;
  onToggleMode: () => void; onSave: () => void; onClose: () => void; onHeight: (px: number) => void;
};

export default class LineAnnotationPanel extends React.Component<Props, { sugg: string[] }> {
  root = React.createRef<HTMLDivElement>();
  guideRef = React.createRef<HTMLTextAreaElement>();
  state = { sugg: [] as string[] };

  componentDidMount() { this.report(); this.guideRef.current?.focus(); }
  componentDidUpdate(prev: Props) { if (prev.mode !== this.props.mode) this.report(); }
  report = () => { const h = this.root.current?.offsetHeight || 0; if (h) this.props.onHeight(h); };

  insertVariable = (name: string) => {
    const ta = this.guideRef.current;
    const pos = ta ? ta.selectionEnd : this.props.draft.guide.length;
    const start = activeTokenStart(this.props.draft.guide.slice(0, pos));
    const token = `{${name}}`;
    const r = start !== null
      ? replaceRange(this.props.draft.guide, start, pos, token)
      : insertAtCursor(this.props.draft.guide, pos, token);
    this.props.onDraftChange({ guide: r.text });
    this.setState({ sugg: [] });
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = r.pos; } });
  };

  onGuideChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    this.props.onDraftChange({ guide: text });
    // `{`-triggered suggestions: find the token being typed after the last unmatched `{`
    const upto = text.slice(0, e.target.selectionStart);
    const m = upto.match(/\{([A-Za-z0-9_]*)$/);
    if (m && this.props.mode === "advanced") {
      this.setState({ sugg: filterCandidates(m[1], this.props.candidates).slice(0, 8) });
    } else {
      this.setState({ sugg: [] });
    }
  };

  render() {
    const { mode, draft, candidates } = this.props;
    const box: React.CSSProperties = { width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 13, border: "1px solid #ccc", borderRadius: 4, padding: "6px" };
    return (
      <div ref={this.root} data-testid="line-annot-panel" style={{ border: "1px solid #8b5cf6", borderRadius: 6, background: "var(--paper,#1e1e1e)", padding: 8, margin: "2px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <strong style={{ fontSize: 12, color: "#8b5cf6" }}>第 {this.props.lineNum} 行</strong>
          <div>
            <button data-testid="annot-mode-toggle" onClick={this.props.onToggleMode} style={{ marginRight: 8 }}>
              {mode === "simple" ? "進階 ▸" : "◂ 簡單"}
            </button>
            <button onClick={this.props.onClose}>✕</button>
          </div>
        </div>

        {mode === "advanced" && candidates.length > 0 && (
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "#8b5cf6" }}>插入變數：</span>
            {candidates.map(c => (
              <button key={c} data-testid={`annot-chip-${c}`} onClick={() => this.insertVariable(c)}
                style={{ margin: "0 3px", padding: "1px 8px", borderRadius: 999, border: "1px solid #8b5cf6", background: "transparent", color: "#8b5cf6", cursor: "pointer", fontSize: 12 }}>
                {c}
              </button>
            ))}
          </div>
        )}

        <div style={{ position: "relative" }}>
          <textarea ref={this.guideRef} data-testid="annot-guide" value={draft.guide} onChange={this.onGuideChange}
            rows={mode === "simple" ? 2 : 3} placeholder="指導文字（可用 {變數}）" style={box} />
          {this.state.sugg.length > 0 && (
            <div style={{ position: "absolute", zIndex: 5, background: "#222", border: "1px solid #8b5cf6", borderRadius: 4 }}>
              {this.state.sugg.map(s => (
                <div key={s} data-testid={`annot-sugg-${s}`} onMouseDown={(e) => { e.preventDefault(); this.insertVariable(s); }}
                  style={{ padding: "2px 10px", cursor: "pointer", color: "#cbd0d8", fontSize: 12 }}>{s}</div>
              ))}
            </div>
          )}
        </div>

        {mode === "advanced" && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#8b5cf6" }}>🔊</span>
              <input type="number" step="0.1" min="0.5" max="4" placeholder="1.0" value={draft.ttsSpeed}
                onChange={e => this.props.onDraftChange({ ttsSpeed: e.target.value })} style={{ width: 70 }} />
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={draft.ttsContinue} onChange={e => this.props.onDraftChange({ ttsContinue: e.target.checked })} /> [continue]
              </label>
            </div>
            <textarea data-testid="annot-tts" value={draft.ttsText} onChange={e => this.props.onDraftChange({ ttsText: e.target.value })} rows={2} placeholder="語音朗讀文字" style={box} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input placeholder="sidebar 寬" value={draft.layoutSidebar} onChange={e => this.props.onDraftChange({ layoutSidebar: e.target.value })} />
              <input placeholder="open:id1,id2" value={draft.layoutOpen} onChange={e => this.props.onDraftChange({ layoutOpen: e.target.value })} />
              <input placeholder="close:id1,id2" value={draft.layoutClose} onChange={e => this.props.onDraftChange({ layoutClose: e.target.value })} />
              <input placeholder="maze" value={draft.layoutMaze} onChange={e => this.props.onDraftChange({ layoutMaze: e.target.value })} />
              <input placeholder="bst" value={draft.layoutBst} onChange={e => this.props.onDraftChange({ layoutBst: e.target.value })} />
            </div>
          </div>
        )}

        <div style={{ marginTop: 8, textAlign: "right" }}>
          <button data-testid="annot-save" onClick={this.props.onSave} style={{ padding: "4px 16px", background: "#4a9eff", color: "#fff", border: "none", borderRadius: 4, fontWeight: 600 }}>儲存</button>
        </div>
      </div>
    );
  }
}
