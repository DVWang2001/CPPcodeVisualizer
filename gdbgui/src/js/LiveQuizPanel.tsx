import * as React from "react";
import { store } from "statorgfc";
import {
  closeLiveQuestion,
  connectTeacherQuizSocket,
  createLiveSession,
  endLiveSession,
  getLiveSession,
  LiveQuizStats,
  triggerLiveQuestion
} from "./liveQuizClient";
import { lessonQuizRuntime, LiveQuizSession, RuntimeState } from "./lessonQuizRuntime";
import { global_variable } from "./global_variable";
import { CapturedTable, tableFromContainer } from "./tableFromContainer";
import TableHeatmap from "./TableHeatmap";

type Props = {
  lessonId: number;
  startError: () => string | null;
  prepareVersion: (version: number) => Promise<void>;
  onSessionEnded: () => Promise<void>;
  onClose: () => void;
};

const STORAGE_KEY = "gdbgui_live_quiz_session_id";
const ink = "#17233b";
const muted = "#667085";
const amber = "#e9a319";

export function closeQuizContainer(): boolean {
  (window as any).gdbgui_table_quiz_hides_container = true;
  const entry = ((window as any).gdbgui_collapser_registry || {}).container;
  if (!entry || !entry.isOpen || !entry.isOpen()) return false;
  entry.close();
  return true;
}

export function restoreQuizContainer(closedByQuiz: boolean) {
  (window as any).gdbgui_table_quiz_hides_container = false;
  if (!closedByQuiz) return;
  const entry = ((window as any).gdbgui_collapser_registry || {}).container;
  if (entry) entry.open();
}

export function TableTriggerConfirm({
  pending,
  busy,
  onConfirm
}: {
  pending: NonNullable<RuntimeState["pendingTable"]>;
  busy: boolean;
  onConfirm: (table: CapturedTable, varHint: string) => void;
}) {
  const containers = ((global_variable as any).__latest_containers as Map<string, any> | undefined) || new Map();
  const names = Array.from(containers.keys());
  const preferred = containers.has(pending.tableSpec.var_hint)
    ? pending.tableSpec.var_hint
    : (names[0] || "");
  const [selected, setSelected] = React.useState(preferred);
  const [, setRefresh] = React.useState(0);
  React.useEffect(() => {
    const interval = window.setInterval(() => setRefresh(value => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, []);
  React.useEffect(() => {
    if (!containers.has(selected) && preferred) setSelected(preferred);
  }, [preferred, selected]);
  const capture = selected
    ? tableFromContainer(containers.get(selected), pending.tableSpec.max_cells)
    : null;
  const valid = capture !== null && capture.ok === true;

  return (
    <div style={{ marginTop: "10px", padding: "10px", background: "#fff", border: "1px solid #d8dee9" }}>
      {names.length === 0 ? (
        <div role="status">程式需先停在容器有值的位置</div>
      ) : (
        <React.Fragment>
          <label>
            正解容器
            <select
              className="form-control input-sm"
              value={selected}
              onChange={event => setSelected(event.target.value)}
            >
              {names.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          {capture && capture.ok === false && (
            <div role="alert" style={{ color: "#a61b1b", marginTop: "8px" }}>{capture.reason}</div>
          )}
          {capture && capture.ok === true && (
            <div style={{ overflow: "auto", marginTop: "8px" }}>
              <table style={{ borderCollapse: "collapse" }}>
                <tbody>
                  {capture.table.values.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((value, colIndex) => (
                        <td key={colIndex} style={{ border: "1px solid #d8dee9", padding: "4px 8px" }}>{value}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </React.Fragment>
      )}
      <button
        type="button"
        className="btn btn-primary btn-sm"
        style={{ marginTop: "8px" }}
        disabled={busy || !valid}
        onClick={() => {
          if (capture && capture.ok === true) onConfirm(capture.table, selected);
        }}
      >
        確認出題
      </button>
    </div>
  );
}

function storedSessionId(): number | null {
  try {
    const value = Number(sessionStorage.getItem(STORAGE_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

function rememberSession(id: number | null) {
  try {
    if (id === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, String(id));
  } catch (_) {}
}

function latestQuestion(session: LiveQuizSession | null): any {
  if (!session) return null;
  if (session.active_question) return session.active_question;
  const opened = session.questions.filter(question => question.opened_at);
  return opened.length ? opened[opened.length - 1] : null;
}

const endedSession = (session: LiveQuizSession): LiveQuizSession => ({
  ...session,
  state: "ended",
  active_question: null
});

export default function LiveQuizPanel({
  lessonId,
  startError,
  prepareVersion,
  onSessionEnded,
  onClose
}: Props) {
  const [session, setSession] = React.useState<LiveQuizSession | null>(null);
  // restartSession 由 window 橋接呼叫，不重新綁定，所以不能靠閉包讀 session——
  // 那會永遠讀到掛載當下的值。用 ref 拿「現在」的 session。
  const sessionRef = React.useRef<LiveQuizSession | null>(null);
  sessionRef.current = session;
  /** QR 放大層。開新課堂時自動打開，讓學生馬上重掃。 */
  const [showQr, setShowQr] = React.useState(false);
  const [stats, setStats] = React.useState<LiveQuizStats | null>(null);
  const [runtimeState, setRuntimeState] = React.useState<RuntimeState>(
    lessonQuizRuntime.state()
  );
  const [busy, setBusy] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const disconnectRef = React.useRef<(() => void) | null>(null);
  const endedRef = React.useRef(false);
  /** 正在把舊課堂換成新的：收課的收尾（載回最新教案）此時是有害的。 */
  const restartingRef = React.useRef(false);
  const restorationRef = React.useRef<Promise<void> | null>(null);
  const urlRef = React.useRef<HTMLInputElement | null>(null);
  const containerClosedRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const triggerGenerationRef = React.useRef(0);

  const restoreHiddenContainer = () => {
    restoreQuizContainer(containerClosedRef.current);
    containerClosedRef.current = false;
  };

  const restoreLatest = (): Promise<void> => {
    // 換課途中不要載回最新版本：那會換掉編輯器裡的原始碼，而程式正在跑——換掉原始碼
    // 等於換掉 binary，下一步就會得到 "The program is not being run."。
    // 新課堂緊接著會用 prepareVersion 鎖定同一個版本，這裡什麼都不必做。
    if (restartingRef.current) return Promise.resolve();
    setBusy(true);
    setError(null);
    return onSessionEnded()
      .catch(reason => {
        setError(reason.message || "無法載回最新教案版本，請重試。");
      })
      .then(() => setBusy(false));
  };

  const startRestore = (): Promise<void> => {
    const restoration = Promise.resolve().then(restoreLatest);
    restorationRef.current = restoration;
    return restoration;
  };

  const finishEnded = (ended: LiveQuizSession): Promise<void> => {
    if (restorationRef.current) return restorationRef.current;
    endedRef.current = true;
    triggerGenerationRef.current += 1;
    lessonQuizRuntime.deactivate();
    restoreHiddenContainer();
    if (disconnectRef.current) disconnectRef.current();
    disconnectRef.current = null;
    rememberSession(null);
    setConnected(false);
    setSession(ended);
    setStats(null);
    return startRestore();
  };

  const connect = (initial: LiveQuizSession): Promise<void> => {
    rememberSession(initial.id);
    if (initial.state === "ended") return finishEnded(initial);
    return prepareVersion(initial.lesson_version)
      .then(() =>
        getLiveSession(initial.id).catch(reason => {
          if (reason.status === 404) {
            return finishEnded(endedSession(initial)).then(() => null);
          }
          throw reason;
        })
      )
      .then(current => {
        if (current === null) return;
        if (current.state === "ended") return finishEnded(current);
        endedRef.current = false;
        restorationRef.current = null;
        setSession(current);
        setError(null);
        lessonQuizRuntime.activate(current, {
          trigger: (sessionId, questionId, sourceFile, line, capture) => {
            const requestGeneration = triggerGenerationRef.current;
            return triggerLiveQuestion(sessionId, questionId, sourceFile, line, capture).then(
              updated => updated,
              reason => {
                if (!capture || !mountedRef.current || endedRef.current) throw reason;
                if (triggerGenerationRef.current !== requestGeneration) {
                  const reconciled = lessonQuizRuntime.state().session;
                  if (reconciled) return reconciled;
                  throw reason;
                }
                if (reason.status === 400) {
                  restoreHiddenContainer();
                  throw reason;
                }
                return getLiveSession(sessionId).then(latest => {
                  if (
                    !mountedRef.current || endedRef.current ||
                    triggerGenerationRef.current !== requestGeneration
                  ) {
                    return lessonQuizRuntime.state().session || latest;
                  }
                  setSession(latest);
                  lessonQuizRuntime.syncSession(latest);
                  const question = latest.questions.find(value => value.id === questionId);
                  const tableOpen = latest.questions.some(
                    value => value.kind === "table" && value.state === "open"
                  );
                  if (question && question.state === "ready" && !tableOpen) {
                    throw reason;
                  }
                  return latest;
                }, () => { throw reason; });
              }
            );
          },
          setGate: value => store.set("quiz_playback_gate", value),
          resumeAutoplay: command => store.set("autoplay_pending_command", command),
          onChange: next => {
            setRuntimeState(next);
            if (next.session) setSession(next.session);
          }
        });
        if (disconnectRef.current) disconnectRef.current();
        disconnectRef.current = connectTeacherQuizSocket(current.id, {
          onState: next => {
            if (next.state === "ended") {
              finishEnded(next);
              return;
            }
            const runtime = lessonQuizRuntime.state();
            const protectedQuestionId = runtime.inFlightQuestionId ||
              (runtime.pendingTable && runtime.error ? runtime.pendingTable.questionId : null);
            const requestStillReady = protectedQuestionId !== null && next.questions.some(
              question => question.id === protectedQuestionId && question.state === "ready"
            );
            if (!requestStillReady) triggerGenerationRef.current += 1;
            setSession(next);
            lessonQuizRuntime.syncSession(next);
            if (
              !requestStillReady &&
              !next.active_question &&
              !next.questions.some(question => question.state === "open")
            ) {
              restoreHiddenContainer();
            }
          },
          onStats: setStats,
          onConnection: value => {
            setConnected(value);
            if (!value && !endedRef.current) {
              getLiveSession(current.id)
                .then(next => {
                  if (next.state === "ended") finishEnded(next);
                })
                .catch(reason => {
                  if (reason.status === 404) finishEnded(endedSession(current));
                });
            }
          }
        });
      });
  };

  React.useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const remembered = storedSessionId();
    if (remembered !== null) {
      setBusy(true);
      getLiveSession(remembered)
        .then(existing => {
          if (cancelled) return;
          if (existing.lesson_id !== lessonId) {
            rememberSession(null);
            return;
          }
          return connect(existing);
        })
        .catch(reason => {
          if (!cancelled) {
            if (reason.status === 404) rememberSession(null);
            setError(
              reason.status === 404
                ? "先前的課堂已結束，可開始新的課堂。"
                : reason.message || "無法恢復課堂。"
            );
          }
        })
        .then(() => {
          if (!cancelled) setBusy(false);
        });
    }
    return () => {
      cancelled = true;
      mountedRef.current = false;
      triggerGenerationRef.current += 1;
      if (disconnectRef.current) disconnectRef.current();
      lessonQuizRuntime.deactivate();
      restoreHiddenContainer();
    };
  }, [lessonId]);

  const start = () => {
    const blocked = startError();
    if (blocked) return setError(blocked);
    setBusy(true);
    setError(null);
    const remembered = storedSessionId();
    const sessionRequest = remembered === null
      ? createLiveSession(lessonId)
      : getLiveSession(remembered).then(existing => {
          if (existing.lesson_id === lessonId) return existing;
          rememberSession(null);
          return createLiveSession(lessonId);
        });
    sessionRequest
      .then(connect)
      .catch(reason => setError(reason.message || "無法開始課堂。"))
      .then(() => setBusy(false));
  };

  // 「重新執行」＝開一堂新的課堂。這是刻意選的行為：每按一次就換一個 session。
  //
  // 代價是已加入的學生會被踢出（他們的裝置憑證綁在舊 session 上），必須重掃 QR，
  // 所以開好之後直接把 QR 放大層彈出來——否則全班要去側欄裡找那個小 QR。
  //
  // 教案不符開課資格時靜靜地什麼都不做：重新執行是除錯的基本動作，不該因為
  // 「這份教案沒有題目」就跳錯誤打斷它。
  const restartSession = React.useCallback((): Promise<void> => {
    if (startError()) return Promise.resolve();
    restartingRef.current = true;
    setBusy(true);
    setError(null);
    const previous = sessionRef.current;
    const ended = previous
      ? endLiveSession(previous.id).then(() => undefined, () => undefined)
      : Promise.resolve();
    return ended
      .then(() => {
        rememberSession(null); // 不沿用舊 session，這裡要的就是一堂新的
        return createLiveSession(lessonId);
      })
      .then(connect)
      .then(() => setShowQr(true))
      .catch(reason => setError(reason.message || "無法開始課堂。"))
      .then(() => {
        restartingRef.current = false;
        setBusy(false);
      });
  }, [lessonId]);

  React.useEffect(() => {
    (window as any).gdbgui_live_quiz_restart = restartSession;
    return () => {
      (window as any).gdbgui_live_quiz_restart = undefined;
    };
  }, [restartSession]);

  const closeQuestion = () => {
    const question = session && session.active_question;
    if (!session || !question) return;
    setBusy(true);
    closeLiveQuestion(session.id, question.id)
      .then(updated => {
        setSession(updated);
        setStats(null);
        lessonQuizRuntime.questionClosed(updated);
        restoreHiddenContainer();
      })
      .catch(reason => setError(reason.message || "無法關閉題目。"))
      .then(() => setBusy(false));
  };

  const end = () => {
    if (!session) return;
    setBusy(true);
    endLiveSession(session.id)
      .then(finishEnded)
      .catch(reason => setError(reason.message || "無法結束課堂。"))
      .then(() => setBusy(false));
  };

  const copyUrl = () => {
    const url = session && session.join_url;
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).catch(() => undefined);
      return;
    }
    if (urlRef.current) {
      urlRef.current.select();
      document.execCommand("copy");
    }
  };

  if (!session) {
    const blocked = startError();
    return (
      <section style={{ padding: "14px 18px", borderBottom: "1px solid #d8dee9", background: "#f7f9fc" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "14px" }}>
          <div>
            <strong style={{ color: ink }}>即時課堂</strong>
            <div style={{ color: muted, fontSize: "12px" }}>開始後顯示 QR；播放停在綁定行時自動開題。</div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className="btn btn-default btn-sm" disabled={busy} onClick={onClose}>取消</button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || Boolean(blocked)}
              title={blocked || undefined}
              onClick={start}>
              {busy ? "正在開始…" : "開始即時課堂"}
            </button>
          </div>
        </div>
        {error && <div role="alert" style={{ color: "#a61b1b", marginTop: "8px" }}>{error}</div>}
      </section>
    );
  }

  if (session.state === "ended") {
    return (
      <section style={{ padding: "14px 18px", borderBottom: "1px solid #d8dee9", background: "#f7f9fc" }}>
        <strong style={{ color: ink }}>本次課堂已結束</strong>
        <span style={{ color: muted, marginLeft: "10px" }}>匿名題目統計已保留，學生資料已清除。</span>
        <span style={{ float: "right", display: "flex", gap: "8px" }}>
          {error && <span role="alert" style={{ color: "#a61b1b" }}>{error}</span>}
          {error && <button type="button" className="btn btn-default btn-sm" disabled={busy} onClick={startRestore}>重試載入</button>}
          <button type="button" className="btn btn-default btn-sm" disabled={busy || !!error} onClick={onClose}>關閉</button>
        </span>
      </section>
    );
  }

  const question = latestQuestion(session);
  const counts = (stats && stats.option_counts) || (question && question.option_counts) || {};
  const answerCount = (stats && stats.answer_count) || (question && question.answer_count) || 0;
  const correctCount = (stats && stats.correct_count) || (question && question.correct_count) || 0;
  const cellStats = (stats && stats.cell_stats) || (question && question.cell_stats) || [];
  let joinHost = "";
  try {
    joinHost = new URL(session.join_url || "").host;
  } catch (_) {}

  return (
    <section
      aria-label="即時課堂控制"
      style={{ padding: "12px 14px", background: "#f7f9fc", color: ink }}
    >
      {showQr && (
        <div
          role="dialog"
          aria-label="放大的加入 QR Code"
          data-testid="live-quiz-qr-overlay"
          onClick={() => setShowQr(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1050, background: "rgba(0,0,0,.55)",
            display: "flex", alignItems: "center", justifyContent: "center"
          }}
        >
          {/* 放大是暫時的：學生掃完就關掉，不像常駐橫幅那樣整堂課擋著程式碼。 */}
          <div
            onClick={event => event.stopPropagation()}
            style={{ background: "#fff", padding: "18px", borderRadius: "8px", textAlign: "center" }}
          >
            <img
              src={session.qr_url}
              alt="學生加入課堂的 QR Code"
              style={{ display: "block", width: "min(60vmin, 420px)", height: "min(60vmin, 420px)" }}
            />
            <div style={{ marginTop: "10px", fontSize: "13px", wordBreak: "break-all" }}>{session.join_url}</div>
            <button type="button" className="btn btn-default btn-sm" style={{ marginTop: "10px" }}
              onClick={() => setShowQr(false)}>關閉</button>
          </div>
        </div>
      )}
      {/* 側欄只有一欄寬，原本的三欄 grid 會把每欄擠成不可讀的細條。 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <img
            src={session.qr_url}
            alt="學生加入課堂的 QR Code"
            data-testid="live-quiz-qr"
            title="點一下放大"
            onClick={() => setShowQr(true)}
            style={{
              display: "block", width: "100%", maxWidth: "190px", aspectRatio: "1",
              margin: "0 auto", cursor: "zoom-in",
              background: "#fff", border: "1px solid #d8dee9"
            }}
          />
          <div style={{ marginTop: "7px", fontSize: "12px", color: connected ? "#237a3b" : "#a65f00" }}>
            {connected ? "● 即時連線中" : "● 重新連線中"}
          </div>
          <div style={{ marginTop: "7px", fontSize: "12px", color: muted }}>
            <div>連線主機：{joinHost}</div>
            <div>請用一支非教師手機測試</div>
          </div>
        </div>

        <div>
          <div style={{ color: muted, fontSize: "12px" }}>學生加入連結</div>
          <div style={{ display: "flex", gap: "6px", margin: "5px 0 14px" }}>
            <input ref={urlRef} className="form-control input-sm" readOnly value={session.join_url || ""} />
            <button type="button" className="btn btn-default btn-sm" onClick={copyUrl}>複製</button>
          </div>
          <div style={{ fontSize: "26px", fontWeight: 700 }}>{session.joined_count || 0}</div>
          <div style={{ color: muted, fontSize: "12px" }}>位學生已加入</div>
          {question && (
            <code style={{ display: "inline-block", marginTop: "14px", padding: "5px 8px", color: ink, background: "#fff7df", border: "1px solid #f2d38b" }}>
              {question.source_file} · L{question.line}
            </code>
          )}
        </div>

        <div style={{ borderLeft: `4px solid ${amber}`, paddingLeft: "16px" }}>
          {question ? (
            <React.Fragment>
              <strong>{question.prompt}</strong>
              <div style={{ display: "flex", gap: "18px", margin: "8px 0", color: muted }}>
                <span>已作答 {answerCount}</span>
                <span>答對 {correctCount}</span>
              </div>
              {question.kind === "table" ? (
                <TableHeatmap
                  rows={question.rows}
                  cols={question.cols}
                  rowLabels={question.row_labels || []}
                  colLabels={question.col_labels || []}
                  stats={cellStats}
                  answerCount={answerCount}
                />
              ) : (question.options || []).map((option: any) => {
                const value = Number(counts[option.id]) || 0;
                const width = answerCount ? Math.round((value / answerCount) * 100) : 0;
                return (
                  <div key={option.id} style={{ marginBottom: "7px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                      <span>{option.text}</span><span>{value}</span>
                    </div>
                    <div style={{ height: "6px", background: "#e6eaf0" }}>
                      <div style={{ width: `${width}%`, height: "100%", background: "#4676b8" }} />
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          ) : (
            <div style={{ color: muted, padding: "24px 0" }}>等待播放到下一個題目綁定行。</div>
          )}

          {runtimeState.pendingTable && runtimeState.inFlightQuestionId === null &&
            !(window as any).gdbgui_table_quiz_hides_container && (
            <TableTriggerConfirm
              key={runtimeState.pendingTable.questionId}
              pending={runtimeState.pendingTable}
              busy={busy}
              onConfirm={(table, varHint) => {
                containerClosedRef.current = closeQuizContainer();
                if (!lessonQuizRuntime.confirmTable(table, varHint)) restoreHiddenContainer();
              }}
            />
          )}

          {(runtimeState.error || error) && (
            <div role="alert" style={{ color: "#a61b1b", marginTop: "8px" }}>
              {runtimeState.error || error}
              {runtimeState.error && (
                <button
                  type="button"
                  className="btn btn-default btn-xs"
                  style={{ marginLeft: "8px" }}
                  onClick={() => {
                    if (runtimeState.pendingTable) {
                      containerClosedRef.current = closeQuizContainer() || containerClosedRef.current;
                      if (!lessonQuizRuntime.retryTrigger()) restoreHiddenContainer();
                    } else lessonQuizRuntime.retryTrigger();
                  }}
                >
                  重試
                </button>
              )}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
            <button type="button" className="btn btn-default btn-sm" disabled={busy} onClick={end}>結束課堂</button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !session.active_question}
              onClick={closeQuestion}
            >
              結束作答並繼續
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
