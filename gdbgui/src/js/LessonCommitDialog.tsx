import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import { LessonBundle, LessonSnapshot } from "./lessonVersion";

type Props = {
  baseline: LessonSnapshot;
  candidate: { title: string; bundle: LessonBundle };
  onConfirm: () => void;
  onCancel: () => void;
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

export default function LessonCommitDialog({
  baseline,
  candidate,
  onConfirm,
  onCancel
}: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lesson-commit-title"
      data-testid="lesson-commit-dialog"
      style={overlay}
    >
      <div style={panel}>
        <h3 id="lesson-commit-title" style={{ marginTop: 0 }}>
          確認這次教案修改
        </h3>
        <p>
          <strong>原標題：</strong>
          {baseline.title}
          <br />
          <strong>新標題：</strong>
          {candidate.title}
        </p>
        <DiffEditor
          height="360px"
          language="cpp"
          original={baseline.bundle.source_code || ""}
          modified={candidate.bundle.source_code || ""}
          options={{ readOnly: true, renderSideBySide: true, automaticLayout: true }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "16px"
          }}
        >
          <button
            type="button"
            className="btn btn-default"
            data-testid="lesson-commit-cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="lesson-commit-confirm"
            onClick={onConfirm}
          >
            確認儲存
          </button>
        </div>
      </div>
    </div>
  );
}
