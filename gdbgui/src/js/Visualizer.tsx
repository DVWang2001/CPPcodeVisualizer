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
  scrollContainerRef = React.createRef<HTMLDivElement>();

  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, [
      "current_theme",
      "expressions",
      "inferior_program",
      "monaco_font_size",
      "monaco_line_height",
      "monaco_content_height",
    ]);
  }

  resolveGuideText(raw: string): string {
    if (!raw || !raw.includes("{")) return raw;
    const expressions: any[] = store.get("expressions") || [];
    return raw.replace(/\{([^{}]+)\}/g, (_match, varName) => {
      const name = varName.trim();
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
      return <div style={{ padding: "8px", color: "var(--ink-soft)", fontSize: "12px" }}>尚未載入源碼，請先在編輯器開啟並編譯。</div>;
    }

    const lines = sourceText.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const guideArrays = guide ? Array.from(guide.values()) : [];
    const maxSteps = guideArrays.length > 0 ? Math.max(...guideArrays.map(a => a.length)) : 0;
    const stepColCount = Math.max(maxSteps, 1);

    const linesWithGuide = new Set<number>();
    lines.forEach((_, idx) => {
      const n = idx + 1;
      if ((lineGuide[n] || lineGuide[String(n)] || "").trim().length > 0) linesWithGuide.add(n);
    });

    const fs = (store.get("monaco_font_size") as number) || 14;
    const lineHeight = (store.get("monaco_line_height") as number) || Math.round(fs * 1.5);
    const contentHeight = (store.get("monaco_content_height") as number) || 400;
    const h = `${lineHeight}px`;

    // CSS Grid with max-content code column: the browser uses its own rendering
    // engine to size the column to the widest line, so no JS font measurement is
    // needed and the separator is guaranteed to start at the same x for every row.
    const gridTemplateColumns = `32px max-content ${Array(stepColCount).fill("minmax(60px, 200px)").join(" ")}`;

    const cells: React.ReactNode[] = [];

    lines.forEach((code, idx) => {
      const lineNum = idx + 1;
      const hasGuideInput = linesWithGuide.has(lineNum);
      const stepValues: any[] = hasGuideInput
        ? ((guide && (guide.get(String(lineNum)) || guide.get(lineNum as any))) || [])
        : [];
      const hasData = stepValues.length > 0;
      const bg = hasData ? "var(--accent-soft)" : undefined;

      const cellBase: React.CSSProperties = {
        height: h, overflow: "hidden", background: bg,
        display: "flex", alignItems: "center",
      };

      cells.push(
        <span key={`n${lineNum}`} style={{
          ...cellBase, justifyContent: "flex-end",
          paddingRight: "6px", color: "var(--ink-faint)", userSelect: "none" as const,
          fontSize: `${Math.round(fs * 0.92)}px`, fontFamily: "var(--font-mono)",
        }}>
          {lineNum}
        </span>
      );

      cells.push(
        <span key={`c${lineNum}`} style={{
          ...cellBase,
          overflow: "visible",
          padding: "0 8px", fontFamily: "var(--font-mono)",
          fontSize: `${fs}px`, color: "var(--ink)", whiteSpace: "pre",
        }}>
          {code}
        </span>
      );

      for (let step = 0; step < stepColCount; step++) {
        if (!hasGuideInput) {
          // Placeholder keeps the grid column count consistent across all rows.
          cells.push(<span key={`s${lineNum}-${step}`} style={{ height: h }} />);
          continue;
        }
        const raw = step < stepValues.length ? stepValues[step] : undefined;
        const isEmpty = raw === undefined || raw === null || String(raw).trim() === "" || raw === " ";
        cells.push(
          <span key={`s${lineNum}-${step}`} style={{
            ...cellBase, justifyContent: "center",
            padding: "0 8px", fontSize: `${fs}px`,
            fontFamily: "var(--font-mono)",
            color: isEmpty ? "var(--ink-faint)" : "var(--accent)",
            fontWeight: isEmpty ? 400 : 600,
            borderLeft: step === 0 ? "2px solid var(--accent)" : "1px solid var(--line)",
            whiteSpace: "nowrap", textOverflow: "ellipsis",
          }}>
            {isEmpty ? "·" : String(raw)}
          </span>
        );
      }
    });

    return (
      <div
        ref={this.scrollContainerRef}
        style={{ overflow: "auto", height: `${contentHeight}px` }}
      >
        <div style={{ display: "grid", gridTemplateColumns, width: "max-content" }}>
          {cells}
        </div>
      </div>
    );
  }

  render() {
    const prog = (this.state as any).inferior_program;
    const isActive =
      prog === constants.inferior_states.running ||
      prog === constants.inferior_states.paused;

    return (
      <div className={this.state.current_theme} style={{ height: "100%" }}>
        {isActive
          ? this.renderSourceCode()
          : <div style={{ padding: "10px 12px", color: "var(--ink-soft)", fontStyle: "italic", fontSize: "0.88em" }}>
              執行程式後顯示追蹤表格。
            </div>
        }
      </div>
    );
  }

  componentDidMount() {
    this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
    (window as any).gdbgui_set_visualizer_scroll = (scrollTop: number) => {
      if (this.scrollContainerRef.current) {
        this.scrollContainerRef.current.scrollTop = scrollTop;
      }
    };
  }

  componentWillUnmount() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    delete (window as any).gdbgui_set_visualizer_scroll;
  }
}

export default Visualizer;
