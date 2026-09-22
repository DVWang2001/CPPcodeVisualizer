import React from "react";

/**
 * 沒有從網址指定要開哪篇教案（沒有 ?lesson=<id>）時，如果瀏覽器本機還留著
 * 一份自動存檔，以前的作法是默默把它套進編輯器——跟教案庫載入的畫面長得
 * 一模一樣，使用者沒有任何辦法分辨現在看到的到底是本機草稿還是教案庫的
 * 哪一篇、第幾版（這正是「教案明明更新了，重新整理卻還是看到舊的」那類
 * 回報的根源：Ctrl+Shift+R 只清 HTTP cache，不會清這份 localStorage）。
 *
 * 不能乾脆拿掉自動存檔——那是防止「教案寫到一半、瀏覽器當掉或不小心關掉
 * 分頁」時作品整個消失的安全網，拿掉的風險比這次的困惑更大。改成把「要不
 * 要用它」變成一個看得到、自己選的動作：安全網還在，但不再悄悄套用。
 */

const colors = {
  ink: "#17233b",
  muted: "#667085",
  line: "#d8dee9",
};

type Props = {
  /** 存檔當下的時間戳（毫秒）；舊版存檔沒有這個欄位時傳 null。 */
  savedAt: number | null;
  /** 存檔當下的檔名，幫助辨認這是哪一份草稿；沒有就不顯示。 */
  filename: string | null;
  onContinue: () => void;
  onDiscard: () => void;
};

export default function AutosavePromptDialog({ savedAt, filename, onContinue, onDiscard }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="autosave-prompt-title"
      data-testid="autosave-prompt-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDiscard();
        } else if (event.key === "Enter") {
          event.preventDefault();
          onContinue();
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
          width: "min(480px, 92vw)",
          background: "#fff",
          border: `1px solid ${colors.line}`,
          boxShadow: "0 18px 48px rgba(16,24,40,.24)",
        }}
      >
        <header style={{ padding: "18px 22px", borderBottom: `1px solid ${colors.line}` }}>
          <h2 id="autosave-prompt-title" style={{ margin: 0, fontSize: "18px", color: colors.ink }}>
            找到一份本機草稿
          </h2>
        </header>

        <div style={{ padding: "20px 22px", fontSize: "14px", color: colors.ink, lineHeight: 1.6 }}>
          <p style={{ margin: 0 }}>
            這份草稿不是教案庫裡的任何一篇，是瀏覽器自動幫你存下的內容。
          </p>
          <p data-testid="autosave-prompt-meta" style={{ margin: "10px 0 0", fontSize: "13px", color: colors.muted }}>
            {filename ? `檔名：${filename}` : "沒有檔名紀錄"}
            {savedAt !== null && (
              <>
                {filename ? "　·　" : ""}
                上次自動存檔：{new Date(savedAt).toLocaleString("zh-TW", { hour12: false })}
              </>
            )}
          </p>
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
          <button type="button" className="btn btn-default" data-testid="autosave-prompt-discard" onClick={onDiscard}>
            捨棄，用空白範本
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="autosave-prompt-continue"
            onClick={onContinue}
            autoFocus>
            繼續編輯這份草稿
          </button>
        </footer>
      </section>
    </div>
  );
}
