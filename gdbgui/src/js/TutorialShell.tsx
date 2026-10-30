/**
 * `//@` 教學頁（/tutorial）左邊的欄：「專注步進」——一次只放大一個步驟，做完才往下。
 * 已完成的步驟收成一行打勾，下一步是灰色預覽；章節與全部課程收在頂端的下拉選單。
 * 右邊是練習區（編輯器＋面板）。
 * 章節資料：static/tutorial/chapters.json（features[] → projects[]），
 * 每個 project 是一份 static/tutorial/<file> 的 v2 教案 bundle，
 * 用 SourceCode 掛上的 window.gdbgui_apply_bundle 套進編輯器。
 */
import React from "react";
import ReactDOM from "react-dom";
import { store } from "statorgfc";
import { collapseSizes, isCollapsed } from "./tutorialPane";
import { stepState, nextStep, prevStep } from "./tutorialSteps";
import "../../static/css/tutorial.css";
import "../../static/css/ide-theme.css";

type Project = { id: string; title: string; goal: string; file: string; steps?: string[]; tip?: string };
type Feature = { id: string; title: string; projects: Project[] };

// v2：舊版（開啟一課就算完成）留下的紀錄不適用，新規則是「做完最後一步才算完成」。
const DONE_KEY = "gdbgui_tutorial_done_v2";

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

/** 頂欄的麵包屑：教學 / 章節 / 目前這一課。TutorialShell 載入一課時送 "tutorial-lesson" 事件。 */
export function TutorialCrumbs() {
  const [now, setNow] = React.useState<{ feature: string; title: string } | null>(null);
  React.useEffect(() => {
    const on = (e: Event) => setNow((e as CustomEvent).detail || null);
    window.addEventListener("tutorial-lesson", on);
    return () => window.removeEventListener("tutorial-lesson", on);
  }, []);
  return (
    <nav className="tut-crumbs" aria-label="麵包屑">
      <span>教學</span>
      {now && (
        <>
          <span className="tut-sep">/</span>
          <span>{now.feature}</span>
          <span className="tut-sep">/</span>
          <b>{now.title}</b>
        </>
      )}
    </nav>
  );
}

export default function TutorialShell() {
  const [features, setFeatures] = React.useState<Feature[]>([]);
  const [current, setCurrent] = React.useState<Project | null>(null);
  const [done, setDone] = React.useState<Record<string, boolean>>(readDone);
  const [error, setError] = React.useState("");
  const [step, setStep] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(true); // 還沒選課時先打開選單
  const [openChap, setOpenChap] = React.useState<string>(""); // 手風琴：目前展開的章 id（空 = 全收合）

  const [docCollapsed, setDocCollapsed] = React.useState(false);
  const savedSizes = React.useRef<number[] | null>(null);

  // 收合／展開左欄：直接調 splitjs 的欄寬（和 applyLayout 的 sidebar:N 同一個把手）。
  const toggleDoc = () => {
    const split: any = store.get("middle_panes_split_obj");
    if (!split || typeof split.getSizes !== "function") return;
    const sizes: number[] = split.getSizes();
    if (isCollapsed(sizes)) {
      split.setSizes(savedSizes.current || [34, 36, 29]);
      setDocCollapsed(false);
    } else {
      savedSizes.current = sizes;
      split.setSizes(collapseSizes(sizes));
      setDocCollapsed(true);
    }
    document.body.classList.toggle("tut-doc-collapsed", !isCollapsed(sizes));
  };

  React.useEffect(() => {
    fetch("/static/tutorial/chapters.json")
      .then(r => r.json())
      .then(d => {
        setFeatures(d.features || []);
        setOpenChap((d.features || [])[0]?.id || "");
      })
      .catch(() => setError("無法載入章節目錄"));
  }, []);

  const flat = React.useMemo(() => features.flatMap(f => f.projects.map(p => ({ p, f }))), [features]);
  const idx = current ? flat.findIndex(x => x.p.id === current.id) : -1;
  const feature = idx >= 0 ? flat[idx].f : null;
  const chapterNo = feature ? features.findIndex(f => f.id === feature.id) + 1 : 0;
  const doneCount = flat.filter(x => done[x.p.id]).length;
  const steps = current?.steps || [];
  const finished = !!current && step >= steps.length;

  const markDone = (id: string) => {
    const next = { ...done, [id]: true };
    setDone(next);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(next));
    } catch (_) {}
  };

  const load = (p: Project) => {
    fetch("/static/tutorial/" + p.file)
      .then(r => r.json())
      .then(bundle => {
        (window as any).gdbgui_apply_bundle?.(bundle);
        const f = features.find(x => x.projects.some(q => q.id === p.id));
        window.dispatchEvent(new CustomEvent("tutorial-lesson", { detail: { feature: f ? f.title : "", title: p.title } }));
        setCurrent(p);
        if (f) setOpenChap(f.id);
        setStep(0);
        setMenuOpen(false);
        setError("");
      })
      .catch(() => setError("無法載入教案：" + p.title));
  };

  const go = (delta: number) => {
    const t = flat[idx + delta];
    if (t) load(t.p);
  };

  const advance = () => {
    const n = nextStep(step, steps.length);
    setStep(n);
    if (current && n >= steps.length) markDone(current.id);
  };

  return (
    <div id="tutorial_doc">
      {/* 頂端：章節下拉 + 課進度 */}
      <div className="tut-top">
        <button
          type="button"
          id="tutorial_menu_btn"
          className="tut-chip"
          aria-expanded={menuOpen}
          aria-controls="tutorial_list"
          onClick={() => {
            if (!menuOpen && feature) setOpenChap(feature.id);
            setMenuOpen(!menuOpen);
          }}
        >
          {feature ? `第 ${chapterNo} 章　${feature.title}` : "選一課開始"} <span aria-hidden="true">{menuOpen ? "▴" : "▾"}</span>
        </button>
        <span className="tut-count">{current ? `課 ${idx + 1} / ${flat.length}` : `${flat.length} 課`}</span>
        <button type="button" id="tutorial_doc_collapse" className="tut-chip" title="收合左側欄" aria-label="收合左側欄" onClick={toggleDoc}>
          ‹
        </button>
      </div>
      {docCollapsed &&
        ReactDOM.createPortal(
          <button type="button" id="tutorial_doc_expand" className="tut-doc-expand" title="展開左側欄" aria-label="展開左側欄" onClick={toggleDoc}>
            ›
          </button>,
          document.body
        )}

      {error && <div style={{ color: "#b00" }}>{error}</div>}

      {/* 全部課程（下拉） */}
      {menuOpen && (
        <div id="tutorial_list" className="tut-menu">
          <div className="tut-menu-head">
            全部課程　<span>{doneCount} / {flat.length} 已完成</span>
          </div>
          {features.map((f, fi) => {
            const isOpen = openChap === f.id;
            const nDone = f.projects.filter(p => done[p.id]).length;
            return (
              <div key={f.id} className={"tut-chap" + (isOpen ? " open" : openChap ? " dim" : "") + (nDone === f.projects.length ? " all-done" : "")}>
                <button
                  type="button"
                  className="tut-chap-head"
                  data-chapter={f.id}
                  aria-expanded={isOpen}
                  onClick={() => setOpenChap(isOpen ? "" : f.id)}
                >
                  <span className="tut-chap-num">{fi + 1}</span>
                  <span className="tut-chap-title">{f.title}</span>
                  <span className="tut-chap-prog">{nDone} / {f.projects.length}</span>
                  <span className="tut-chap-chev" aria-hidden="true">▾</span>
                </button>
                <div className="tut-chap-wrap">
                  <div className="tut-chap-inner">
                    {f.projects.map(p => (
                      <a
                        key={p.id}
                        href="#"
                        data-project={p.id}
                        tabIndex={isOpen ? 0 : -1}
                        className={current?.id === p.id ? "tut-now" : ""}
                        onClick={e => {
                          e.preventDefault();
                          load(p);
                        }}
                      >
                        <span>{done[p.id] ? "✓" : current?.id === p.id ? "●" : "○"}</span>
                        {p.title}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!menuOpen && current && (
        <>
          <div>
            <h1 id="tutorial_title">{current.title}</h1>
            <p className="tut-goal">{renderInline(current.goal)}</p>
          </div>

          {steps.length > 0 && (
            <div className="tut-dots" aria-label={`步驟 ${Math.min(step + 1, steps.length)} / ${steps.length}`}>
              {steps.map((_, i) => (
                <span key={i} className={"tut-dot" + (i <= step ? " on" : "")} />
              ))}
              <span className="tut-dots-text">{finished ? "全部完成" : `步驟 ${step + 1} / ${steps.length}`}</span>
            </div>
          )}

          <ol id="tutorial_steps">
            {steps.map((s, i) => {
              const st = stepState(i, step);
              if (st === "done")
                return (
                  <li key={i} className="tut-step done">
                    <span className="tut-check" aria-hidden="true">✓</span>
                    <span className="tut-step-text">{renderInline(s)}</span>
                  </li>
                );
              if (st === "now")
                return (
                  <li key={i} className="tut-step now" aria-current="step">
                    <div className="tut-now-head">
                      <span className="tut-num-lg">{i + 1}</span>
                      <span className="tut-now-label">現在做這一步</span>
                    </div>
                    <div className="tut-now-text">{renderInline(s)}</div>
                    <div className="tut-now-actions">
                      {step > 0 && (
                        <button type="button" id="tutorial_step_prev" className="tut-btn ghost" onClick={() => setStep(prevStep(step))}>
                          ← 上一步
                        </button>
                      )}
                      <button type="button" id="tutorial_step_next" className="tut-btn primary" onClick={advance}>
                        {i < steps.length - 1 ? "我做完了，下一步 →" : "我做完了，完成這一課"}
                      </button>
                    </div>
                  </li>
                );
              return (
                <li key={i} className="tut-step upcoming">
                  <span className="tut-num-sm" aria-hidden="true">{i + 1}</span>
                  <span className="tut-step-text">{renderInline(s)}</span>
                </li>
              );
            })}
          </ol>

          {finished && (
            <div className="tut-finish">
              <div className="tut-finish-title">這一課完成了</div>
              <div className="tut-now-actions">
                <button type="button" className="tut-btn ghost" onClick={() => setStep(prevStep(step))}>
                  ← 回到最後一步
                </button>
                <button type="button" id="tutorial_next_primary" className="tut-btn primary" disabled={idx >= flat.length - 1} onClick={() => go(1)}>
                  {idx >= flat.length - 1 ? "全部課程完成" : "下一課 →"}
                </button>
              </div>
            </div>
          )}

          {current.tip && <div className="tut-tip">{renderInline(current.tip)}</div>}

          <div className="tut-bottom">
            <button className="tut-link" id="tutorial_prev" disabled={idx <= 0} onClick={() => go(-1)}>
              ← 上一課{idx > 0 ? `　${flat[idx - 1].p.title}` : ""}
            </button>
            <button className="tut-link" id="tutorial_next" disabled={idx < 0 || idx >= flat.length - 1} onClick={() => go(1)}>
              下一課 →
            </button>
          </div>
        </>
      )}

      {!menuOpen && !current && (
        <div>
          <h1>//@ 註解教學</h1>
          <p className="tut-goal">在程式裡改一行、按 Enter，直接看到那一行的效果。從上面選一課開始。</p>
        </div>
      )}
    </div>
  );
}
