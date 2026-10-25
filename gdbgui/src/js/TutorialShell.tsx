/**
 * `//@` 教學頁（/tutorial）左邊的「文件」欄：像講義一樣往下讀——麵包屑、標題、說明、
 * 編號步驟、小提示，以及「從頭自動播放」。右邊是練習區（編輯器＋面板）。
 * 章節資料：static/tutorial/chapters.json（features[] → projects[]），
 * 每個 project 是一份 static/tutorial/<file> 的 v2 教案 bundle，
 * 用 SourceCode 掛上的 window.gdbgui_apply_bundle 套進編輯器。
 */
import React from "react";
import GdbApi from "./GdbApi";
import "../../static/css/tutorial.css";

type Project = { id: string; title: string; goal: string; file: string; steps?: string[]; tip?: string };
type Feature = { id: string; title: string; projects: Project[] };

const DONE_KEY = "gdbgui_tutorial_done";

const readDone = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) || "{}");
  } catch (_) {
    return {};
  }
};

/** `code` 與 **粗體** 的極簡標記，其餘一律當純文字（不經 innerHTML）。 */
export function renderInline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export default function TutorialShell() {
  const [features, setFeatures] = React.useState<Feature[]>([]);
  const [current, setCurrent] = React.useState<Project | null>(null);
  const [done, setDone] = React.useState<Record<string, boolean>>(readDone);
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

  const flat = React.useMemo(() => features.flatMap(f => f.projects.map(p => ({ p, f }))), [features]);
  const idx = current ? flat.findIndex(x => x.p.id === current.id) : -1;
  const feature = idx >= 0 ? flat[idx].f : null;

  const load = (p: Project) => {
    fetch("/static/tutorial/" + p.file)
      .then(r => r.json())
      .then(bundle => {
        (window as any).gdbgui_apply_bundle?.(bundle);
        setCurrent(p);
        setError("");
        const next = { ...done, [p.id]: true };
        setDone(next);
        try {
          localStorage.setItem(DONE_KEY, JSON.stringify(next));
        } catch (_) {}
      })
      .catch(() => setError("無法載入教案：" + p.title));
  };

  const go = (delta: number) => {
    const t = flat[idx + delta];
    if (t) load(t.p);
  };

  return (
    <div id="tutorial_doc">
      <div className="tut-crumbs">
        <span>教學</span>
        {feature && (
          <>
            <span>/</span>
            <span>{feature.title}</span>
          </>
        )}
        <span className="tut-sp" />
        <button className="tut-link" id="tutorial_prev" disabled={idx <= 0} onClick={() => go(-1)}>
          ← 上一課
        </button>
        <button className="tut-link" id="tutorial_next" disabled={idx < 0 || idx >= flat.length - 1} onClick={() => go(1)}>
          下一課 →
        </button>
      </div>

      {error && <div style={{ color: "#b00" }}>{error}</div>}

      {current ? (
        <>
          <h1 id="tutorial_title">{current.title}</h1>
          <p>{renderInline(current.goal)}</p>
          {visit && visit.n && visit.n > 1 && (
            <div id="tutorial_visit" className="tut-visit">
              第 {visit.k} / {visit.n} 次進入第 {visit.line} 行
            </div>
          )}
          {current.steps && (
            <ol id="tutorial_steps">
              {current.steps.map((s, i) => (
                <li key={i} className="tut-step">
                  <span className="tut-num">{i + 1}</span>
                  <span>{renderInline(s)}</span>
                </li>
              ))}
            </ol>
          )}
          {current.tip && <div className="tut-tip">{renderInline(current.tip)}</div>}
          <button
            className="tut-restart"
            id="tutorial_restart"
            onClick={() => GdbApi.click_run_button()}
            title="從頭自動播放到結束"
          >
            ↻ 從頭自動播放
          </button>
        </>
      ) : (
        <>
          <h1>//@ 註解教學</h1>
          <p>在程式裡改一行、按 Enter，直接看到那一行的效果。從下面選一課開始。</p>
        </>
      )}

      <details open={!current} id="tutorial_list">
        <summary>全部課程</summary>
        <div className="tut-list">
          {features.map(f => (
            <div key={f.id}>
              <div className="tut-feature">{f.title}</div>
              {f.projects.map(p => (
                <a
                  key={p.id}
                  href="#"
                  data-project={p.id}
                  className={current?.id === p.id ? "tut-now" : ""}
                  onClick={e => {
                    e.preventDefault();
                    load(p);
                  }}
                >
                  <span>{done[p.id] ? "✓" : "○"}</span>
                  {p.title}
                </a>
              ))}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
