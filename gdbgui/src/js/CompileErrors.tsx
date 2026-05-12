import React from "react";
import { store } from "statorgfc";

export interface CompileError {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
}

export function parseCompileErrors(stderr: string): CompileError[] {
  const errors: CompileError[] = [];
  if (!stderr) return errors;
  const re = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/;
  for (const line of stderr.split("\n")) {
    const m = line.match(re);
    if (m) {
      errors.push({
        file: m[1],
        line: parseInt(m[2]),
        col: parseInt(m[3]),
        severity: m[4] as CompileError["severity"],
        message: m[5].trim(),
      });
    }
  }
  return errors;
}

type CompileErrorsState = {
  compile_errors: CompileError[];
  ai_explanation: string;
  ai_loading: boolean;
  ai_error: string;
};

class CompileErrors extends React.Component<{}, CompileErrorsState> {
  constructor() {
    // @ts-expect-error ts-migrate(2554)
    super();
    this.state = {
      compile_errors: [],
      ai_explanation: "",
      ai_loading: false,
      ai_error: "",
    };
    // @ts-expect-error ts-migrate(2339)
    store.connectComponentState(this, ["compile_errors"]);
  }

  async fetchExplanation() {
    const errors: CompileError[] = (this.state as any).compile_errors || [];
    if (errors.length === 0) return;

    const source: string = (window as any).gdbgui_get_editor_value?.() || "";

    this.setState({ ai_loading: true, ai_explanation: "", ai_error: "" });
    try {
      const resp = await fetch("/api/explain_error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errors, source, language: "C++" }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      this.setState({ ai_explanation: data.explanation });
    } catch (e: any) {
      this.setState({ ai_error: e.message || "未知錯誤" });
    } finally {
      this.setState({ ai_loading: false });
    }
  }

  render() {
    const errors: CompileError[] = (this.state as any).compile_errors || [];
    const { ai_explanation, ai_loading, ai_error } = this.state;

    const errorCount = errors.filter(e => e.severity === "error").length;
    const warnCount  = errors.filter(e => e.severity === "warning").length;

    const summaryParts: string[] = [];
    if (errorCount > 0) summaryParts.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
    if (warnCount  > 0) summaryParts.push(`${warnCount} warning${warnCount  > 1 ? "s" : ""}`);

    const severityColor = (s: string) => s === "error" ? "#d32f2f" : s === "warning" ? "#f57c00" : "#1565c0";
    const severityBg    = (s: string) => s === "error" ? "rgba(211,47,47,0.06)" : s === "warning" ? "rgba(245,124,0,0.06)" : "rgba(21,101,192,0.06)";
    const severityIcon  = (s: string) => s === "error" ? "✖" : s === "warning" ? "⚠" : "ℹ";

    if (errors.length === 0) {
      return (
        <div style={{ padding: "10px 12px", color: "#888", fontStyle: "italic", fontSize: "0.88em" }}>
          No compile errors.
        </div>
      );
    }

    return (
      <div style={{ fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: "0.84em" }}>

        {/* Summary bar */}
        <div style={{
          padding: "4px 10px",
          background: errorCount > 0 ? "rgba(211,47,47,0.12)" : "rgba(245,124,0,0.10)",
          borderBottom: "1px solid #e0e0e0",
          color: errorCount > 0 ? "#b71c1c" : "#e65100",
          fontWeight: "bold",
          fontSize: "0.9em",
        }}>
          {summaryParts.join(", ")} — 點擊跳至錯誤行
        </div>

        {/* Error rows */}
        {errors.map((err, i) => (
          <div
            key={i}
            className="compile-error-row"
            style={{
              display: "flex", alignItems: "flex-start",
              padding: "5px 10px", borderBottom: "1px solid #f0f0f0",
              cursor: "pointer", background: severityBg(err.severity), gap: "6px",
            }}
            onClick={() => { const nav = (window as any).gdbgui_navigate_to_error; if (nav) nav(err.line, err.col); }}
            title={`${err.file}:${err.line}:${err.col}`}
          >
            <span style={{ color: severityColor(err.severity), flexShrink: 0, marginTop: "1px" }}>
              {severityIcon(err.severity)}
            </span>
            <span style={{ color: "#777", flexShrink: 0, minWidth: "48px", fontSize: "0.9em" }}>
              L{err.line}:{err.col}
            </span>
            <span style={{ color: "#333", wordBreak: "break-word", lineHeight: "1.4" }}>
              {err.message}
            </span>
          </div>
        ))}

        {/* AI 解釋按鈕 */}
        <div style={{ padding: "8px 10px", borderTop: "1px solid #f0f0f0" }}>
          <button
            onClick={() => this.fetchExplanation()}
            disabled={ai_loading}
            style={{
              padding: "4px 12px", fontSize: "12px", cursor: ai_loading ? "not-allowed" : "pointer",
              background: ai_loading ? "#e0e0e0" : "#1565c0", color: ai_loading ? "#999" : "#fff",
              border: "none", borderRadius: "4px", fontFamily: "sans-serif",
            }}
          >
            {ai_loading ? "AI 分析中…" : "🤖 AI 解釋錯誤"}
          </button>
        </div>

        {/* AI 錯誤訊息 */}
        {ai_error && (
          <div style={{
            margin: "0 10px 8px", padding: "6px 10px",
            background: "rgba(211,47,47,0.08)", borderLeft: "3px solid #d32f2f",
            color: "#b71c1c", fontSize: "12px", fontFamily: "sans-serif",
          }}>
            ⚠ {ai_error}
          </div>
        )}

        {/* AI 解釋結果 */}
        {ai_explanation && (
          <div style={{
            margin: "0 10px 10px", padding: "10px 12px",
            background: "#f0f7ff", borderLeft: "3px solid #1565c0",
            color: "#1a237e", fontSize: "12px", fontFamily: "sans-serif",
            whiteSpace: "pre-wrap", lineHeight: "1.7",
          }}>
            {ai_explanation}
          </div>
        )}
      </div>
    );
  }
}

export default CompileErrors;
