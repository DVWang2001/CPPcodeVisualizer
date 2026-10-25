/**
 * `//@` 教學頁（/tutorial）的章節目錄。浮在 IDE 左側，不動既有版面。
 * 章節資料：static/tutorial/chapters.json（features[] → projects[]），
 * 每個 project 是一份 static/tutorial/<file> 的 v2 教案 bundle，
 * 用 SourceCode 掛上的 window.gdbgui_apply_bundle 套進編輯器。
 */
import React from "react";

type Project = { id: string; title: string; goal: string; file: string; hint: string };
type Feature = { id: string; title: string; projects: Project[] };

const DONE_KEY = "gdbgui_tutorial_done";

const readDone = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) || "{}");
  } catch (_) {
    return {};
  }
};

export default function TutorialShell() {
  const [features, setFeatures] = React.useState<Feature[]>([]);
  const [current, setCurrent] = React.useState<Project | null>(null);
  const [done, setDone] = React.useState<Record<string, boolean>>(readDone);
  const [open, setOpen] = React.useState(true);
  const [error, setError] = React.useState("");
  const [visit, setVisit] = React.useState<{ line: number; k: number; n: number | null } | null>(null);

  // SourceCode 在連按 Enter 步進時送來「第 k / n 次進入」。
  React.useEffect(() => {
    const on = (e: Event) => setVisit((e as CustomEvent).detail || null);
    window.addEventListener("tutorial-visit", on);
    return () => window.removeEventListener("tutorial-visit", on);
  }, []);

  React.useEffect(() => {
    fetch("/static/tutorial/chapters.json")
      .then(r => r.json())
      .then(d => setFeatures(d.features || []))
      .catch(() => setError("無法載入章節目錄"));
  }, []);

  const load = (p: Project) => {
    fetch("/static/tutorial/" + p.file)
      .then(r => r.json())
      .then(bundle => {
        (window as any).gdbgui_apply_bundle?.(bundle);
        setCurrent(p);
        setOpen(false); // 目錄收起來，只留目標與提示，少擋住程式碼
        setError("");
        const next = { ...done, [p.id]: true };
        setDone(next);
        try {
          localStorage.setItem(DONE_KEY, JSON.stringify(next));
        } catch (_) {}
      })
      .catch(() => setError("無法載入教案：" + p.title));
  };

  return (
    <div
      id="tutorial_shell"
      style={{
        position: "fixed", top: 40, left: 8, zIndex: 1000, width: open ? 280 : "auto",
        maxHeight: "calc(100vh - 60px)", overflowY: "auto", background: "#fffdf7",
        color: "#222", border: "1px solid #bbb", borderRadius: 6, padding: 8, fontSize: 13,
        boxShadow: "0 2px 8px rgba(0,0,0,.2)",
      }}
    >
      <button id="tutorial_toggle" onClick={() => setOpen(!open)} style={{ marginBottom: 4 }}>
        {open ? "收合教學目錄 ◀" : "教學目錄 ▶"}
      </button>
      {open && (
        <div>
          <div style={{ color: "#666", marginBottom: 6 }}>
            改任何一行後按 Enter，直接執行到那一行並停住；同一行再按 Enter 進到下一次（Shift+Enter 插入新行）。按上方重新整理鍵 Restart，從頭自動播到尾。
          </div>
          {error && <div style={{ color: "#b00" }}>{error}</div>}
          {features.map(f => (
            <details key={f.id} open>
              <summary style={{ fontWeight: 600 }}>{f.title}</summary>
              <ul style={{ listStyle: "none", paddingLeft: 8, margin: "4px 0" }}>
                {f.projects.map(p => (
                  <li key={p.id}>
                    <a
                      href="#"
                      data-project={p.id}
                      onClick={e => { e.preventDefault(); load(p); }}
                      style={{ fontWeight: current?.id === p.id ? 700 : 400 }}
                    >
                      {done[p.id] ? "✓ " : "○ "}{p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      {visit && visit.n && visit.n > 1 && (
        <div
          id="tutorial_visit"
          style={{ marginTop: 6, padding: "4px 10px", borderRadius: 999, background: "#2c5fd8", color: "#fff", fontWeight: 700, width: "max-content" }}
        >
          第 {visit.k} / {visit.n} 次進入第 {visit.line} 行
        </div>
      )}
      {current && (
        <div id="tutorial_current" style={{ borderTop: open ? "1px solid #ddd" : "none", marginTop: 6, paddingTop: 6, maxWidth: 280 }}>
          <div><b>{current.title}</b>｜{current.goal}</div>
          <div style={{ marginTop: 4 }}><b>試著改：</b>{current.hint}</div>
        </div>
      )}
    </div>
  );
}
