import * as React from "react";
import "../css/liveQuiz.css";

type Props = {
  rows: number;
  cols: number;
  rowLabels: string[];
  colLabels: string[];
  stats: number[];
  answerCount: number;
  /** 給了才會讓答錯的格子變成按鈕（收卷後跳到寫入該格的那一步）。 */
  onCellClick?: (row: number, col: number) => void;
  /** 按鈕的無障礙名稱用，例如 dp。 */
  varName?: string;
};

export default function TableHeatmap({
  rows,
  cols,
  rowLabels,
  colLabels,
  stats,
  answerCount,
  onCellClick,
  varName
}: Props) {
  return (
    <div style={{ overflow: "auto", maxHeight: "46vh" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: cols }, (_, col) => <th key={col}>{colLabels[col]}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              <th scope="row">{rowLabels[row]}</th>
              {Array.from({ length: cols }, (_, col) => {
                const wrong = Number(stats[row * cols + col]) || 0;
                const ratio = answerCount ? Math.max(0, Math.min(1, wrong / answerCount)) : 0;
                return (
                  <td
                    key={col}
                    data-heatmap-cell
                    className="table-heatmap__cell"
                    aria-label={`${rowLabels[row]}，${colLabels[col]}：${answerCount} 人中有 ${wrong} 人答錯`}
                    style={{
                      position: "relative",
                      padding: "8px",
                      textAlign: "center",
                      border: "1px solid #d8dee9",
                      fontVariantNumeric: "tabular-nums"
                    }}
                  >
                    <span
                      data-heat
                      className="table-heatmap__heat"
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        inset: 0,
                        opacity: ratio
                      }}
                    />
                    {onCellClick && varName && wrong > 0 ? (
                      <button
                        type="button"
                        data-heatmap-jump
                        aria-label={`跳到 ${varName}[${row}][${col}] 最後被寫入的那一步`}
                        onClick={() => onCellClick(row, col)}
                        style={{
                          position: "relative", minWidth: "44px", minHeight: "44px", width: "100%",
                          background: "transparent", border: "none", font: "inherit", color: "inherit",
                          cursor: "pointer", textDecoration: "underline"
                        }}
                      >
                        {wrong}
                      </button>
                    ) : (
                      <span style={{ position: "relative" }}>{wrong}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
