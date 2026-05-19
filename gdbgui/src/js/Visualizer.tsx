/*
Animations.tsx就是用來給我弄視覺化的
*/

import React from "react";
import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import constants from "./constants";

type State = any;

class Visualizer extends React.Component<{}, State> {
  updateInterval: any;
  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, [
      "current_theme",
      "expressions",
      "inferior_program",
    ]);
  }

  resolveGuideText(raw: string): string {
    if (!raw || !raw.includes("{")) return raw;
    const expressions: any[] = store.get("expressions") || [];
    return raw.replace(/\{([^{}]+)\}/g, (_match, varName) => {
      const name = varName.trim();
      // Try exact match first, then suffix match (handles funcName::varName)
      const found = expressions.find(
        (obj: any) => obj.in_scope === "true" && obj.value !== undefined &&
          (obj.expression === name || obj.expression.endsWith("::" + name))
      );
      return found ? found.value : `{${name}}`;
    });
  }
  static clear() {
    if ("__guide" in global_variable) {
      (global_variable as any).__guide.clear();
    }
    if ("__containers_guide" in global_variable) {
      (global_variable as any).__containers_guide.clear();
    }
    if ("__latest_containers" in global_variable) {
      (global_variable as any).__latest_containers.clear();
    }
    if ("__latest_highlights" in global_variable) {
      (global_variable as any).__latest_highlights.clear();
    }
  }
  renderGuideTable() {
    const guide = (global_variable as any).__guide as Map<string, any[]>;
    if (!guide || guide.size === 0) {
      return <div>No guide data available</div>;
    }
    // 水平表格
    const maxValues = Math.max(...Array.from(guide.values()).map(v => v.length));
    const rows = Array.from(guide.entries()).map(([key, values]) => {
      const cells = [<td key="expr" style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{key}</td>];
      for (let i = 0; i < maxValues; i++) {
        cells.push(<td key={i} style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{values[i] || ''}</td>);
      }
      return <tr key={key}>{cells}</tr>;
    });
    return (
      <table style={{ width: '100%', border: '1px solid black', borderCollapse: 'collapse' }}>
        <tbody>{rows}</tbody>
      </table>
    );
  }


  renderSourceCode() {
    const sourceText: string = (global_variable as any).__source_text || "";
    const lineGuide: Record<string | number, string> = (global_variable as any).__line || {};
    const guide: Map<string, any[]> = (global_variable as any).__guide;

    if (!sourceText) {
      return <div style={{ padding: "8px", color: "#888", fontSize: "12px" }}>尚未載入源碼，請先在編輯器開啟並編譯。</div>;
    }

    const lines = sourceText.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    // Max step count across all tracked lines
    const guideArrays = guide ? Array.from(guide.values()) : [];
    const maxSteps = guideArrays.length > 0 ? Math.max(...guideArrays.map(a => a.length)) : 0;

    // Which lines have guide text written by the user
    const linesWithGuide = new Set<number>();
    lines.forEach((_, idx) => {
      const n = idx + 1;
      if ((lineGuide[n] || lineGuide[String(n)] || "").trim().length > 0) linesWithGuide.add(n);
    });

    const tdCode: React.CSSProperties = { padding: "1px 8px", whiteSpace: "pre", fontFamily: "monospace", fontSize: "12px", color: "#333" };
    const tdNum: React.CSSProperties  = { padding: "1px 6px", textAlign: "right", color: "#aaa", userSelect: "none", minWidth: "26px", fontSize: "11px" };

    const tableRows = lines.map((code, idx) => {
      const lineNum = idx + 1;
      const hasGuideInput = linesWithGuide.has(lineNum);

      if (!hasGuideInput) {
        // No guide — just show code, no step cells
        return (
          <tr key={lineNum}>
            <td style={tdNum}>{lineNum}</td>
            <td style={tdCode}>{code}</td>
          </tr>
        );
      }

      // This line has guide text — build step cells from __guide
      const stepValues: any[] = (guide && (guide.get(String(lineNum)) || guide.get(lineNum as any))) || [];

      const stepCells = Array.from({ length: maxSteps }, (_, step) => {
        const raw = stepValues[step];
        const isEmpty = raw === undefined || raw === null || String(raw).trim() === "" || raw === " ";
        return (
          <td key={step} style={{
            padding: "1px 8px",
            borderLeft: step === 0 ? "2px solid #90caf9" : "1px solid #e8e8e8",
            color: isEmpty ? "#ccc" : "#1565c0",
            whiteSpace: "pre-wrap",
            fontSize: "12px",
            minWidth: "60px",
            maxWidth: "200px",
            verticalAlign: "top",
            textAlign: "center",
          }}>
            {isEmpty ? "·" : String(raw)}
          </td>
        );
      });

      // Not yet visited at all — show a single placeholder column
      if (maxSteps === 0) {
        stepCells.push(
          <td key="placeholder" style={{ padding: "1px 8px", borderLeft: "2px solid #e0e0e0", color: "#ccc", fontSize: "12px", minWidth: "60px" }}>
            ·
          </td>
        );
      }

      return (
        <tr key={lineNum} style={{ background: stepValues.length > 0 ? "rgba(21,101,192,0.05)" : undefined }}>
          <td style={tdNum}>{lineNum}</td>
          <td style={tdCode}>{code}</td>
          {stepCells}
        </tr>
      );
    });

    return (
      <div style={{ maxHeight: "340px", overflowY: "auto", overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", tableLayout: "auto" }}>
          <tbody>{tableRows}</tbody>
        </table>
      </div>
    );
  }

  render() {
    const prog = (this.state as any).inferior_program;
    const isActive =
      prog === constants.inferior_states.running ||
      prog === constants.inferior_states.paused;

    return (
      <div className={this.state.current_theme}>
        {isActive
          ? this.renderSourceCode()
          : <div style={{ padding: "10px 12px", color: "#888", fontStyle: "italic", fontSize: "0.88em" }}>
              執行程式後顯示追蹤表格。
            </div>
        }
      </div>
    );
  }
  componentDidMount() {
    this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
  }
  componentWillUnmount() {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }
}
export default Visualizer;