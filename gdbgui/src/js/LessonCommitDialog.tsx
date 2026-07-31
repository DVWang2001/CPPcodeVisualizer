import * as React from "react";
import { DiffEditor } from "@monaco-editor/react";
import { LessonBundle, LessonSnapshot, nonSourceBundleJson } from "./lessonVersion";

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
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    const first =
      dialogRef.current &&
      dialogRef.current.querySelector<HTMLElement>("button:not([disabled])");
    if (first) first.focus();
    return () => {
      if (previousFocus.current && document.contains(previousFocus.current))
        previousFocus.current.focus();
    };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const controls = Array.prototype.slice.call(
      dialogRef.current.querySelectorAll(
        "button:not([disabled]), [role='button'][tabindex]"
      )
    ) as HTMLElement[];
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (
      (!event.shiftKey && index === controls.length - 1) ||
      (event.shiftKey && index <= 0)
    ) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lesson-commit-title"
      data-testid="lesson-commit-dialog"
      style={overlay}
      ref={dialogRef}
      onKeyDown={onKeyDown}
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
        <p>
          <strong>其他教案設定：</strong>
        </p>
        <DiffEditor
          height="220px"
          language="json"
          original={nonSourceBundleJson(baseline.bundle)}
          modified={nonSourceBundleJson(candidate.bundle)}
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
