import * as React from "react";
import { store } from "statorgfc";
import {
  closeLiveQuestion,
  connectTeacherQuizSocket,
  createLiveSession,
  endLiveSession,
  getLiveSession,
  liveQuizExportUrl,
  LiveQuizStats,
  triggerLiveQuestion,
  fetchQuestionResponses,
  StudentTableResponse
} from "./liveQuizClient";
import { lessonQuizRuntime, LiveQuizSession, RuntimeState } from "./lessonQuizRuntime";
import { global_variable } from "./global_variable";
import { CapturedTable, tableFromContainer } from "./tableFromContainer";
import TableHeatmap from "./TableHeatmap";
import TableAnswerReview from "./TableAnswerReview";
import GdbApi from "./GdbApi";

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

import { randomTestDataFor } from "./randomTestData";

export function TestInputPreview({ onRandomize }: { onRandomize?: () => void }) {
  const [inputVal, setInputVal] = React.useState(
    () => localStorage.getItem("gdbgui_program_input") || store.get("program_input") || ""
  );
  const [justRandomized, setJustRandomized] = React.useState(false);
  const generator = randomTestDataFor(store.get("fullname_to_render"));

  const handleRandomize = React.useCallback(() => {
    if (!generator) return;
    const newVal = generator();
    setInputVal(newVal);
    store.set("program_input", newVal);
    localStorage.setItem("gdbgui_program_input", newVal);
    setJustRandomized(true);
    if (onRandomize) onRandomize();
  }, [generator, onRandomize]);

  // 如果這題需要測資但目前是空的，自動幫老師產生一組，避免 C++ 讀到垃圾值而 bad_alloc
  React.useEffect(() => {
    if (generator && (!inputVal || !inputVal.trim())) {
      handleRandomize();
    }
  }, [generator, inputVal, handleRandomize]);

  const lines = (inputVal || "").trim().split("\n");

  return (
    <div style={{ marginTop: "6px", marginBottom: "8px", padding: "8px 10px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
        <strong style={{ fontSize: "12px", color: "#334155" }}>📋 題目測資 (Standard Input)</strong>
        {generator && (
          <button
            type="button"
            className="btn btn-default btn-xs text-blue-600"
            style={{ fontSize: "11px", padding: "1px 6px", color: "#0284c7" }}
            onClick={handleRandomize}
            title="換一組隨機測資"
          >
            🎲 隨機測資
          </button>
        )}
      </div>
      {justRandomized && (
        <div style={{ fontSize: "11px", color: "#0284c7", marginBottom: "4px", background: "#e0f2fe", padding: "3px 6px", borderRadius: "3px" }}>
          💡 已更新測資！請點擊上方 <strong>Run (↻)</strong> 重跑程式，停在題目行時點擊「確認出題」即可。
        </div>
      )}
      {lines.length === 0 || !lines[0] ? (
        <div style={{ color: "#94a3b8", fontSize: "12px" }}>(無設定測資)</div>
      ) : (
        <pre style={{ margin: 0, padding: "4px 8px", background: "#fff", border: "1px solid #e2e8f0", fontSize: "12px", fontFamily: "monospace", color: "#0f172a", borderRadius: "3px", overflow: "auto", maxHeight: "180px" }}>
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

export function TableTriggerConfirm({
  pending,
  busy,
  isRerunning,
  onConfirm
}: {
  pending: NonNullable<RuntimeState["pendingTable"]>;
  busy: boolean;
  isRerunning?: boolean;
  onConfirm: (captured: CapturedTable, varHint: string) => void;
}) {
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    const timer = setInterval(forceUpdate, 100);
    return () => clearInterval(timer);
  }, []);

  const containers = ((global_variable as any).__latest_containers as Map<string, any> | undefined) || new Map();
  const names = Array.from(containers.keys());
  const preferred = containers.has(pending.tableSpec.var_hint)
    ? pending.tableSpec.var_hint
    : (names[0] || pending.tableSpec.var_hint);
  const [selected, setSelected] = React.useState(preferred);

  React.useEffect(() => {
    if (preferred && (!selected || !containers.has(selected))) {
      setSelected(preferred);
    }
  }, [preferred, containers]);

  const activeKey = selected && containers.has(selected) ? selected : preferred;
  const selectedCaptured = containers.get(activeKey);
  // 一定要經過 tableFromContainer：它是唯一會把容器原始 payload 正規化成伺服器
  // 期待的 {rows, cols, row_labels, col_labels, values} 的地方（見 live_quiz.py 的
  // 嚴格 key-set 檢查）。直接把容器 payload 拼一拼送出去，缺 row_labels/col_labels
  // 又多了 name/type/isContainer 這些欄位，伺服器一定拒收——按下確認出題就會出錯。
  const capture = activeKey
    ? tableFromContainer(selectedCaptured, pending.tableSpec.max_cells)
    : null;
  const captureError = capture && capture.ok === false ? capture.reason : "";

  // 換了隨機測資、但還沒真的按 Run 重跑：__latest_containers 裡的還是上一次
  // 執行留下的舊資料，跟畫面上「題目測資」框顯示的新輸入對不上。沒有這層
  // 攔截的話「確認出題」會直接把舊資料拿去出題，老師看畫面上明明是新測資，
  // 出的題卻悄悄用了舊的——這是實測過的真實 bug，不是理論風險。
  const currentProgramInput = store.get("program_input") || "";
  const lastRunProgramInput = (global_variable as any).__last_run_program_input ?? currentProgramInput;
  const inputStale = currentProgramInput !== lastRunProgramInput;

  const disabled = busy || Boolean(isRerunning) || names.length === 0 || !capture || capture.ok !== true || inputStale;

  return (
    <div style={{ marginTop: "10px", padding: "12px", background: "#fff", border: "1px solid #3b82f6", borderRadius: "6px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
      <div style={{ color: "#1e40af", fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>
        🎯 即將觸發題目 (請確認測資)
      </div>

      {names.length === 0 ? (
        <div style={{ color: "#a61b1b", fontSize: "12px", marginBottom: "6px" }}>
          程式需先停在容器有值的位置
        </div>
      ) : (
        <div style={{ marginBottom: "8px" }}>
          <select
            className="form-control input-sm"
            value={activeKey}
            onChange={e => setSelected(e.target.value)}
          >
            {names.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
      )}

      {/* 一定要畫 capture.table.values（經過 tableFromContainer 驗證過的），不能
          直接畫 selectedCaptured.values 這個容器原始 payload：換測資重跑之後，
          容器輪詢是逐列更新的，中間某一瞬間可能有的列還是舊測資的欄數、有的列
          已經是新測資的欄數，直接畫原始資料就會出現鋸齒狀、格數對不齊的表格
          （這正是「超出格子」的根因）。tableFromContainer 已經檢查過每列欄數
          一致，不一致就會回 ok:false，畫面上交給下面的 captureError 訊息處理，
          不會把半新半舊的資料端出來給老師看。 */}
      {capture && capture.ok === true && (
        <table style={{ borderCollapse: "collapse", margin: "6px 0" }}>
          <tbody>
            {capture.table.values.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} style={{ border: "1px solid #ccc", padding: "2px 6px" }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {captureError ? (
        <div style={{ color: "#a61b1b", fontSize: "12px", marginBottom: "6px" }}>
          {captureError}
        </div>
      ) : null}

      {/* 測資區塊 (主要顯示與調整區) */}
      <TestInputPreview />

      {inputStale ? (
        <div style={{ fontSize: "12px", color: "#a61b1b", margin: "8px 0 10px", background: "#fef2f2", padding: "6px 8px", borderRadius: "4px" }}>
          ⚠️ 測資已更新，但程式還沒用新測資重跑過——上面畫出來的表格是<strong>上一次執行</strong>留下的舊資料。
          請先按上方<strong>「Run (↻)」</strong>重新執行，等程式停在題目行之後再按「確認出題」。
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#475569", margin: "8px 0 10px", background: "#eff6ff", padding: "6px 8px", borderRadius: "4px" }}>
          💡 這裡的表格是<strong>目前這次執行</strong>算出來的結果。換了測資要先按上方「Run (↻)」重跑，
          等程式停在題目行、表格更新後，再按下面的<strong>「確認出題」</strong>。
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-sm"
        style={{ width: "100%", fontWeight: 600 }}
        disabled={disabled}
        onClick={() => {
          if (!capture || capture.ok !== true) return;
          onConfirm(capture.table, activeKey || pending.tableSpec.var_hint);
        }}
      >
        {isRerunning ? "🔄 正在重跑程式並擷取 DP 表格..." : "確認出題"}
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
  /** 面板本體（連線狀態、題目內容那一大塊，不含全螢幕 QR）收合狀態。
   *  預設收合——這塊東西展開時可以很長（熱區圖、個別作答清單），沒事不用
   *  一直佔著側欄版面，跟資料結構視覺化搶學生的注意力。 */
  const [panelCollapsed, setPanelCollapsed] = React.useState(true);
  /** 出題當下捕獲的「題目資料」容器（正解以外的那些）。
   *
   * 圖論題需要老師的投影畫面上留著鄰接矩陣，學生才有依據作答；把它塞進手機題幹會
   * 吃掉半個螢幕。容器面板在出題時整個關掉——那是既有且有多條競態測試守著的行為，
   * 不動它，改成在這裡自己畫。
   *
   * 捕獲而不是即時讀 __latest_containers：出題後程式仍可能前進，讀即時值會讓畫面上的
   * 題目資料跟學生手上那題對不起來。
   */
  const [questionData, setQuestionData] = React.useState<Array<[string, string[][]]>>([]);
  /** 收卷後的個別作答（僅填表題）。伺服器只在 closed 之後才給。 */
  const [reviews, setReviews] = React.useState<StudentTableResponse[] | null>(null);
  const [openReview, setOpenReview] = React.useState<string | null>(null);
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
  const containerClosedRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const triggerGenerationRef = React.useRef(0);
  const reRunningForTriggerRef = React.useRef<{ questionId: string; varHint: string } | null>(null);
  const [isRerunningForTrigger, setIsRerunningForTrigger] = React.useState(false);

  const restoreHiddenContainer = () => {
    restoreQuizContainer(containerClosedRef.current);
    containerClosedRef.current = false;
  };

  // 當按下「確認出題」觸發 GDB 自動重跑後，停在題目行時自動擷取最新 DP 表格並出題
  React.useEffect(() => {
    const req = reRunningForTriggerRef.current;
    if (!req || !runtimeState.pendingTable || runtimeState.pendingTable.questionId !== req.questionId) {
      return;
    }
    let cancelled = false;
    const attemptCapture = () => {
      if (cancelled) return false;
      const containers = ((global_variable as any).__latest_containers as Map<string, any> | undefined) || new Map();
      const targetVar = req.varHint || runtimeState.pendingTable!.tableSpec.var_hint;
      const container = containers.get(targetVar);
      const capture = container ? tableFromContainer(container, runtimeState.pendingTable!.tableSpec.max_cells) : null;
      if (capture && capture.ok === true) {
        reRunningForTriggerRef.current = null;
        setIsRerunningForTrigger(false);
        setQuestionData(
          Array.from(containers.entries())
            .filter(([name, data]) =>
              name !== targetVar &&
              Array.isArray(data?.values) &&
              Array.isArray(data.values[0])
            )
            .map(([name, data]) => [
              name,
              (data.values as any[][]).map(row => row.map((cell: any) => String(cell)))
            ] as [string, string[][]])
        );
        containerClosedRef.current = closeQuizContainer();
        if (!lessonQuizRuntime.confirmTable(capture.table, targetVar)) {
          restoreHiddenContainer();
        }
        return true;
      }
      return false;
    };

    if (!attemptCapture()) {
      const timer = setInterval(() => {
        if (attemptCapture()) clearInterval(timer);
      }, 200);
      const timeout = setTimeout(() => {
        clearInterval(timer);
        if (reRunningForTriggerRef.current) {
          reRunningForTriggerRef.current = null;
          setIsRerunningForTrigger(false);
        }
      }, 4000);
      return () => {
        cancelled = true;
        clearInterval(timer);
        clearTimeout(timeout);
      };
    }
  }, [runtimeState.pendingTable]);

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
    // 換課時舊課堂的 ended 事件會晚一步從 socket 回來。照常收尾就會 deactivate 掉
    // 剛為**新**課堂啟用的 runtime——播放到綁定行時不再開題，而畫面上一切看起來正常。
    // 用「這個 ended 屬於哪一堂」判斷而不是靠旗標：事件早到或晚到都判得對。
    const current = sessionRef.current;
    if (current && ended.id !== current.id) return Promise.resolve();
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
        // 同步更新 ref，不等下一次 render：舊課堂的 ended 事件可能在這之間就到，
        // 而 finishEnded 要靠 ref 判斷「這個 ended 屬於哪一堂」。
        sessionRef.current = current;
        setSession(current);
        setError(null);
        lessonQuizRuntime.activate(current, {
          trigger: (sessionId, questionId, sourceFile, line, capture) => {
            const requestGeneration = triggerGenerationRef.current;
            const currentTestInput = localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "";
            return triggerLiveQuestion(sessionId, questionId, sourceFile, line, capture, currentTestInput).then(
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
          // 把指令寫回 autoplay_pending_command 是不夠的：那個槽只有「使用者按恢復」
          // 那條路徑會消費，沒有任何東西在輪詢它，所以收卷後畫面就是不動。
          // 走 gdbgui_execute_autoplay_command 才是真的讓它跑起來，而且沿用它既有的
          // 全部守衛：閘門是否已開、autoplay 是否仍啟用、目前是否暫停（暫停時它會
          // 自己把指令放回槽裡等恢復）、以及動畫 barrier。
          resumeAutoplay: command => (window as any).gdbgui_execute_autoplay_command?.(command),
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

  // 「重新執行」＝開一堂新的課堂。這是刻意選的行為：每按一次就換一個 session。
  //
  // 代價是已加入的學生會被踢出（他們的裝置憑證綁在舊 session 上），必須重掃 QR，
  // 所以開好之後直接把 QR 放大層彈出來——否則全班要去側欄裡找那個小 QR。
  //
  // 教案不符開課資格時靜靜地什麼都不做：重新執行是除錯的基本動作，不該因為
  // 「這份教案沒有題目」就跳錯誤打斷它。
  // 回傳值表示「這次有沒有真的跳出 QR」——gateRun 要知道這件事，才能決定
  // 遞延的 runNow 該死等 handleCloseQr，還是在這裡就直接兜底送出。
  const restartSession = React.useCallback((): Promise<boolean> => {
    if (startError()) return Promise.resolve(false);
    restartingRef.current = true;
    setBusy(true);
    setError(null);
    const previous = sessionRef.current;
    const ended = previous
      ? Promise.resolve(endLiveSession(previous.id)).then(() => undefined, () => undefined)
      : Promise.resolve();
    return ended
      .then(() => {
        rememberSession(null); // 不沿用舊 session，這裡要的就是一堂新的
        return createLiveSession(lessonId);
      })
      .then(connect)
      .then(() => {
        if ((window as any).gdbgui_rerunning_for_quiz) {
          return false;
        }
        setShowQr(true);
        // 暫停播放，把「學生掃碼」的空檔交給老師控制。不暫停的話播放會直接往前跑，
        // 到達綁定行時題目就開了——而學生此刻連 QR 都還沒掃到。
        // 沿用既有的 autoplay_paused：老師掃完按原本的播放鍵繼續，不必新學一個操作。
        store.set("autoplay_paused", true);
        return true;
      })
      .catch(reason => {
        setError(reason.message || "無法開始課堂。");
        return false;
      })
      .then(shown => {
        restartingRef.current = false;
        setBusy(false);
        return shown;
      });
  }, [lessonId]);

  React.useEffect(() => {
    (window as any).gdbgui_live_quiz_restart = restartSession;
    return () => {
      (window as any).gdbgui_live_quiz_restart = undefined;
    };
  }, [restartSession]);

  // 真正送出 -exec-run（連同 GdbVariable 佇列重置、UML 狀態清空等一整包
  // Actions.inferior_program_starting 的副作用）被 GdbApi.click_run_button
  // 卡住，改成呼叫這裡：程式在勾了即時課堂時不能「按 Run 就立刻正式開始
  // 跑、TTS 立刻念」，要等老師把全螢幕 QR 關掉才算數。
  //
  // pendingRunRef 記著那包被卡住的動作；沒跳出 QR（開課失敗、被判定為
  // 不用跳 QR 的悄悄重跑等）就沒有人會去關閉不存在的 QR，runNow 在這裡
  // 直接兜底送出，不能讓「按 Run」看起來完全沒反應。
  const pendingRunRef = React.useRef<(() => void) | null>(null);

  const gateRun = React.useCallback((runNow: () => void) => {
    pendingRunRef.current = runNow;
    restartSession().then(shown => {
      if (!shown && pendingRunRef.current === runNow) {
        pendingRunRef.current = null;
        runNow();
      }
    });
  }, [restartSession]);

  React.useEffect(() => {
    (window as any).gdbgui_live_quiz_gate_run = gateRun;
    return () => {
      (window as any).gdbgui_live_quiz_gate_run = undefined;
    };
  }, [gateRun]);

  // 註冊進跟 RightSidebar 那些 Collapser 共用的同一個登記簿，讓教案的
  // //@ @layout open:live_quiz / close:live_quiz 也能開關這個面板——
  // 跟 open:container、open:callgraph 是同一套機制，applyLayout 那邊
  // 不用另外認得這個面板，寫法完全一樣。
  React.useEffect(() => {
    const registry = (window as any).gdbgui_collapser_registry || {};
    (window as any).gdbgui_collapser_registry = registry;
    registry["live_quiz"] = {
      open: () => setPanelCollapsed(false),
      close: () => setPanelCollapsed(true),
      isOpen: () => !panelCollapsed,
    };
    return () => {
      delete (window as any).gdbgui_collapser_registry?.["live_quiz"];
    };
  }, [panelCollapsed]);

  const handleCloseQr = React.useCallback(() => {
    setShowQr(false);
    store.set("autoplay_paused", false);
    const pendingRun = pendingRunRef.current;
    if (pendingRun) {
      // 這次的 QR 是 gateRun 卡住的：程式現在才真的要開始跑，還沒有
      // 「上一步」可以續，不需要也不能補一個 autoplay 續播指令——
      // 第一次停下來會自然播 TTS，播放鏈接得下去（autoplay_paused
      // 剛剛已經解除）。
      pendingRunRef.current = null;
      pendingRun();
      return;
    }
    const pendingCmd = store.get("autoplay_pending_command") || "next";
    if (typeof (window as any).gdbgui_execute_autoplay_command === "function") {
      (window as any).gdbgui_execute_autoplay_command(pendingCmd);
    }
  }, []);

  // 收卷後抓個別作答。條件必須跟伺服器的三道守衛一致（table + closed + 擁有者），
  // 否則會在每次狀態更新時打出一連串必然 409 的請求。
  React.useEffect(() => {
    const current = session;
    const target = latestQuestion(current);
    if (!current || !target || target.kind !== "table" || target.state !== "closed") {
      setReviews(null);
      setOpenReview(null);
      return;
    }
    let cancelled = false;
    fetchQuestionResponses(current.id, target.id)
      .then(payload => { if (!cancelled) setReviews(payload.responses); })
      .catch(() => { if (!cancelled) setReviews([]); });
    return () => { cancelled = true; };
  }, [session]);

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

  // 還沒有 session：不再顯示「開始即時課堂」啟動卡片——按「重新執行」就會
  // 自動開課並跳出全螢幕 QR（見 restartSession），這張卡片本來就多餘。
  // 只有自動開課失敗時才需要露出錯誤，讓老師知道發生了什麼事。
  if (!session) {
    if (!error) return null;
    return (
      <section style={{ padding: "14px 18px", borderBottom: "1px solid #d8dee9", background: "#f7f9fc" }}>
        <div role="alert" style={{ color: "#a61b1b" }}>{error}</div>
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
          onClick={handleCloseQr}
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
              onClick={handleCloseQr}>關閉</button>
          </div>
        </div>
      )}
      {/* 面板本體收合與否不影響上面的全螢幕 QR——QR 是另一回事，該跳出來的
          時候一定要跳出來，不能因為這裡收合著就被連帶蓋掉。 */}
      <div
        className="pointer titlebar"
        onClick={() => setPanelCollapsed(!panelCollapsed)}
        style={{ margin: "-12px -14px 0", cursor: "pointer" }}
      >
        <span
          className={`glyphicon glyphicon-chevron-${panelCollapsed ? "right" : "down"}`}
          style={{ marginRight: "6px" }}
        />
        <span className="lighttext">即時課堂</span>
      </div>
      <div className={panelCollapsed ? "hidden" : ""}>
      {/* 側欄只有一欄寬，原本的三欄 grid 會把每欄擠成不可讀的細條。 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
        <div>
          {/* QR 圖與加入連結不再常駐在這裡——190px 見方的圖加上一整塊連結區，
              把側欄下面的教學引導內容全部往下擠。需要再給學生看 QR（例如有人
              遲到）就點這顆小按鈕重新跳全螢幕，不用整堂課佔位置。 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: connected ? "#237a3b" : "#a65f00" }}>
              {connected ? "● 即時連線中" : "● 重新連線中"}
            </span>
            <button type="button" className="btn btn-default btn-sm" style={{ fontSize: "11px", padding: "1px 8px" }}
              onClick={() => setShowQr(true)}>顯示 QR</button>
          </div>
          <div style={{ marginTop: "7px", fontSize: "26px", fontWeight: 700 }}>{session.joined_count || 0}</div>
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
              {(() => {
                const capturedContainers = question.captured_containers
                  ? Object.entries(question.captured_containers)
                  : Array.from((((global_variable as any).__latest_containers as Map<string, any> | undefined) || new Map()).entries());
                const items = capturedContainers.filter(([name, data]) => 
                  name !== (question.table_spec?.var_hint || "") &&
                  data && Array.isArray((data as any).values) && Array.isArray((data as any).values[0])
                );
                if (items.length === 0) return null;
                return (
                  <div style={{ marginBottom: "10px" }}>
                    <div style={{ color: muted, fontSize: "12px", marginBottom: "3px" }}>
                      題目資料（投影給學生看，正解不在其中）
                    </div>
                    {items.map(([name, data]: [string, any]) => {
                      const values: any[][] = data && data.values ? data.values : [];
                      return (
                        <div key={name} style={{ marginBottom: "6px" }}>
                          <code style={{ fontSize: "11px", color: ink }}>{name}</code>
                          <table style={{ borderCollapse: "collapse", marginTop: "2px" }}>
                            <tbody>
                              {values.map((row, r) => (
                                <tr key={r}>
                                  {row.map((cell, c) => (
                                    <td key={c} style={{
                                      border: "1px solid #d8dee9", padding: "2px 6px",
                                      font: "600 11px/1.2 ui-monospace, Menlo, Consolas, monospace",
                                      textAlign: "center", background: "#fff", color: ink
                                    }}>{cell}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <TestInputPreview />
              <strong>{question.prompt}</strong>
              <div style={{ display: "flex", gap: "18px", margin: "8px 0", color: muted }}>
                <span>已作答 {answerCount}</span>
                <span>答對 {correctCount}</span>
              </div>
              {question.kind === "table" ? (
                <React.Fragment>
                <TableHeatmap
                  rows={question.rows}
                  cols={question.cols}
                  rowLabels={question.row_labels || []}
                  colLabels={question.col_labels || []}
                  stats={cellStats}
                  answerCount={answerCount}
                />
                {question.state === "closed" && reviews !== null && (
                  <div style={{ marginTop: "12px" }}>
                    <div style={{ color: muted, fontSize: "12px", marginBottom: "4px" }}>
                      個別作答（{reviews.length}）· 答對最少的排最前
                    </div>
                    {reviews.length === 0 && (
                      <div style={{ fontSize: "12px", color: muted }}>沒有人送出作答。</div>
                    )}
                    {reviews.map(item => (
                      <div key={item.nickname} style={{ marginBottom: "6px" }}>
                        <button
                          type="button"
                          className="btn btn-default btn-sm"
                          data-testid="live-quiz-review-item"
                          style={{ width: "100%", textAlign: "left", fontSize: "12px" }}
                          onClick={() =>
                            setOpenReview(openReview === item.nickname ? null : item.nickname)
                          }
                        >
                          {item.nickname} · {item.correct_cells}/{item.total_cells}
                        </button>
                        {openReview === item.nickname && (
                          <TableAnswerReview
                            response={item}
                            correctValues={question.correct_values || []}
                            rowLabels={question.row_labels || []}
                            colLabels={question.col_labels || []}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                </React.Fragment>
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
              isRerunning={isRerunningForTrigger}
              onConfirm={(captured, varHint) => {
                if (!runtimeState.pendingTable) return;
                const questionId = runtimeState.pendingTable.questionId;

                // 1. 確保最新測資寫入 store & localStorage
                const currentInput = localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "";
                store.set("program_input", currentInput);

                if ((window as any).gdbgui_auto_rerun_on_confirm) {
                  // 2. 先重設出題記錄與鎖，清空舊的 pendingTable 狀態
                  lessonQuizRuntime.prepareReRunForQuestion(questionId);
                  reRunningForTriggerRef.current = { questionId, varHint };
                  setIsRerunningForTrigger(true);
                  (window as any).gdbgui_rerunning_for_quiz = true;
                  GdbApi.click_run_button();
                } else {
                  const cap = captured || (((global_variable as any).__latest_containers as Map<string, any> | undefined)?.get(varHint));
                  if (cap) {
                    containerClosedRef.current = closeQuizContainer() || containerClosedRef.current;
                    lessonQuizRuntime.confirmTable(cap, varHint);
                  }
                }
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
            {/* 結束課堂會刪光逐筆作答，所以匯出擺在它旁邊——要按錯之前先看到。 */}
            <a
              className="btn btn-default btn-sm"
              data-testid="live-quiz-export"
              href={liveQuizExportUrl(session.id)}
              title="下載逐筆作答。結束課堂後這些資料就會被清除。"
            >
              匯出作答
            </a>
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
      </div>
    </section>
  );
}
