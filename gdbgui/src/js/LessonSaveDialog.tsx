import React from "react";

/**
 * 存教案時輸入標題的頁面內對話框。
 *
 * 取代 window.prompt。瀏覽器會在同一頁跳過幾次對話框後提供「防止此頁面產生
 * 其他對話方塊」的選項，一旦被勾選，window.prompt 就直接回 null——而存檔流程
 * 對 null 的處理是安靜地 return，於是使用者按下按鈕之後畫面毫無反應、也存不進去，
 * 完全查不出原因。實測就是這樣壞掉的。
 *
 * 擋存檔的理由（題目有錯、還是預設範例）也一併顯示在這裡，不再用 window.alert。
 */

const colors = {
  ink: "#17233b",
  muted: "#667085",
  line: "#d8dee9",
  danger: "#c0392b",
  amber: "#e9a319",
};

type Props = {
  initialTitle: string;
  /** 有值就不能存，並把理由顯示出來。 */
  blockedReason: string | null;
  /** 這是別人的教案，存下去會另存一份副本。 */
  isFork: boolean;
  onConfirm: (title: string) => void;
  onClose: () => void;
};

export default function LessonSaveDialog({
  initialTitle,
  blockedReason,
  isFork,
  onConfirm,
  onClose,
}: Props) {
  const [title, setTitle] = React.useState(initialTitle);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = title.trim();
  const emptyTitle = trimmed.length === 0;
  const canSave = !blockedReason && !emptyTitle;

  const confirm = () => {
    if (canSave) onConfirm(trimmed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lesson-save-title"
      data-testid="lesson-save-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Enter" && canSave) {
          event.preventDefault();
          confirm();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3000,
        background: "rgba(16,24,40,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <section
        style={{
          width: "min(520px, 92vw)",
          background: "#fff",
          border: `1px solid ${colors.line}`,
          boxShadow: "0 18px 48px rgba(16,24,40,.24)",
        }}
      >
        <header style={{ padding: "18px 22px", borderBottom: `1px solid ${colors.line}` }}>
          <h2 id="lesson-save-title" style={{ margin: 0, fontSize: "20px", color: colors.ink }}>
            存到我的帳號
          </h2>
          {isFork && (
            <div style={{ marginTop: "6px", fontSize: "13px", color: colors.muted }}>
              這篇教案不是你的，會在你名下另存一份副本；原作者的版本不會被更動。
            </div>
          )}
        </header>

        <div style={{ padding: "20px 22px" }}>
          {blockedReason && (
            <div
              data-testid="lesson-save-blocked"
              style={{
                marginBottom: "16px",
                padding: "10px 14px",
                border: `1px solid ${colors.line}`,
                borderLeft: `3px solid ${colors.amber}`,
                whiteSpace: "pre-wrap",
                fontSize: "13px",
                color: colors.ink,
              }}
            >
              {blockedReason}
            </div>
          )}
          <label htmlFor="lesson-save-title-input" style={{ fontSize: "13px", color: colors.muted }}>
            教案標題
          </label>
          <input
            id="lesson-save-title-input"
            data-testid="lesson-save-title-input"
            ref={inputRef}
            value={title}
            disabled={Boolean(blockedReason)}
            onChange={(event) => setTitle(event.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: "6px",
              padding: "8px 10px",
              fontSize: "14px",
              border: `1px solid ${colors.line}`,
            }}
          />
          {emptyTitle && !blockedReason && (
            <div style={{ marginTop: "6px", fontSize: "12px", color: colors.danger }}>
              標題不可為空。
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "14px 22px",
            borderTop: `1px solid ${colors.line}`,
          }}
        >
          <button type="button" className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="lesson-save-confirm"
            onClick={confirm}
            disabled={!canSave}
          >
            儲存
          </button>
        </footer>
      </section>
    </div>
  );
}
