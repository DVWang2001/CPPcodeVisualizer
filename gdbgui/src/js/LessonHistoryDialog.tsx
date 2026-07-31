import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  layoutVersionGraph,
  LessonSnapshot,
  VersionSummary
} from "./lessonVersion";

type Props = {
  versions: VersionSummary[];
  currentVersion: number;
  selected: LessonSnapshot | null;
  parent: LessonSnapshot | null;
  onSelect: (version: number) => void;
  onRestore: () => void;
  onClose: () => void;
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "rgba(0, 0, 0, 0.45)"
};

const panel: React.CSSProperties = {
  width: "min(1100px, 100%)",
  maxHeight: "calc(100vh - 48px)",
  overflow: "auto",
  padding: "20px",
  background: "#fff",
  boxShadow: "0 12px 36px rgba(0, 0, 0, 0.35)"
};

export default function LessonHistoryDialog({
  versions,
  currentVersion,
  selected,
  parent,
  onSelect,
  onRestore,
  onClose
}: Props) {
  const graph = layoutVersionGraph(versions, currentVersion);
  const rowHeight = 52;
  const laneWidth = 76;
  const top = 26;
  const width = Math.max(170, graph.laneCount * laneWidth + 70);
  const height = Math.max(70, graph.nodes.length * rowHeight + 20);
  const positions: { [version: number]: { x: number; y: number } } = {};
  graph.nodes.forEach((node, index) => {
    positions[node.version] = {
      x: 35 + node.lane * laneWidth,
      y: top + index * rowHeight
    };
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lesson-history-title"
      data-testid="lesson-history-dialog"
      style={overlay}
    >
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px" }}>
          <h3 id="lesson-history-title" style={{ marginTop: 0 }}>
            教案版本歷史
          </h3>
          <button
            type="button"
            className="btn btn-default"
            data-testid="lesson-history-close"
            onClick={onClose}
          >
            關閉
          </button>
        </div>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-label="教案版本樹"
          style={{ display: "block", marginBottom: "12px", overflow: "visible" }}
        >
          {Array.from({ length: graph.laneCount }).map((_, lane) => (
            <line
              key={`lane-${lane}`}
              x1={35 + lane * laneWidth}
              y1={top - 18}
              x2={35 + lane * laneWidth}
              y2={height - 14}
              stroke="#d8d8d8"
              strokeWidth="2"
            />
          ))}
          {graph.edges.map(edge => {
            const parentPosition = positions[edge.from];
            const childPosition = positions[edge.to];
            if (!parentPosition || !childPosition) return null;
            return (
              <polyline
                key={`${edge.from}-${edge.to}`}
                points={`${parentPosition.x},${parentPosition.y} ${childPosition.x},${parentPosition.y} ${childPosition.x},${childPosition.y}`}
                fill="none"
                stroke="#777"
                strokeWidth="2"
              />
            );
          })}
          {graph.nodes.map(node => {
            const position = positions[node.version];
            const select = () => onSelect(node.version);
            return (
              <g
                key={node.version}
                role="button"
                tabIndex={0}
                aria-label={`版本 ${node.version}`}
                data-testid={`lesson-version-node-${node.version}`}
                onClick={select}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle
                  cx={position.x}
                  cy={position.y}
                  r="13"
                  fill={node.isHead ? "#337ab7" : "#fff"}
                  stroke="#337ab7"
                  strokeWidth="3"
                />
                <text
                  x={position.x + 21}
                  y={position.y + 5}
                  fill="#222"
                  fontSize="14"
                >
                  v{node.version}
                </text>
                {node.isHead && (
                  <text
                    x={position.x + 21}
                    y={position.y - 11}
                    fill="#337ab7"
                    fontSize="11"
                    fontWeight="bold"
                  >
                    HEAD
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {selected ? (
          <div>
            <p>
              <strong>{selected.title}</strong>
              <br />
              版本 v{selected.version}・{selected.createdAt || "建立時間未知"}
              <br />
              {parent ? `與 v${parent.version} 比較` : "初始版本（與空白程式碼比較）"}
            </p>
            <DiffEditor
              height="300px"
              language="cpp"
              original={(parent && parent.bundle.source_code) || ""}
              modified={selected.bundle.source_code || ""}
              options={{ readOnly: true, renderSideBySide: true, automaticLayout: true }}
            />
          </div>
        ) : (
          <p>選擇一個版本以查看差異。</p>
        )}
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}
        >
          <button
            type="button"
            className="btn btn-primary"
            data-testid="lesson-version-restore"
            disabled={!selected}
            onClick={onRestore}
          >
            還原這個版本
          </button>
        </div>
      </div>
    </div>
  );
}
