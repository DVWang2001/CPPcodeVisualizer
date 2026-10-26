import React from "react";
import ReactDOM from "react-dom";
import { isTutorial } from "./ToolIcon";

/**
 * SourceCode 裡「編輯器上方那排」按鈕（新草稿、AI 生成教案、Import/Export、課堂題目、存到帳號…）
 * 的容器。正式 IDE 把它們搬進頂欄（#top_file_slot）：第一組收進「檔案 ▾」選單，
 * 其餘兩組直接排在頂欄上。按鈕本身與它們的 handler / data-testid 仍留在 SourceCode，
 * 這裡只決定「畫在哪裡」（portal）。教學頁沒有 #top_file_slot，維持原本那排（CSS 會把它藏起來）。
 */
export default function ToolbarHost({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!isTutorial()) setSlot(document.getElementById("top_file_slot"));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!slot) return <div className="toolbar-row">{children}</div>;

  const kids = React.Children.toArray(children);
  return ReactDOM.createPortal(
    <>
      <span className="file-menu-wrap" ref={wrapRef}>
        <button
          type="button"
          id="file_menu_button"
          aria-haspopup="true"
          aria-expanded={open}
          className="btn btn-default btn-sm toolbar-btn tut-pill"
          title="新草稿、AI 生成教案、匯入／匯出"
          onClick={() => setOpen(!open)}
        >
          檔案 ▾
        </button>
        {/* 選單內容永遠在 DOM 裡（隱藏檔案選擇器要用），只用 class 控制顯示 */}
        <div className={"file-menu-pop" + (open ? " open" : "")} onClick={() => setOpen(false)}>
          {kids[0]}
        </div>
      </span>
      {kids.slice(1)}
    </>,
    slot
  );
}
