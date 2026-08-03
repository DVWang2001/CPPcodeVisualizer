/**
 * 步進看門狗。
 *
 * 已知故障：GDB 在展開容器 varobj 時可能從一個尚未建構的容器讀到垃圾基底位址，
 * 接著對被除錯程式的未映射記憶體無止境地 `pread64`（每次回 EIO、位址 +4），
 * 主執行緒 100% CPU 空轉，再也不回任何 MI 回應。
 *
 * 前端因此永遠停在 `running`：自動播放不動、next/step/continue 全部沒反應，
 * 而畫面上不會出現任何訊息——使用者只看到整個介面靜默變磚。
 *
 * 這支**不修**那個迴圈，只負責讓它不再靜默：送出步進命令後若超時仍未停下來，
 * 就關掉自動播放（否則它會繼續排指令）並把狀況講清楚。
 *
 * 刻意不自動殺掉除錯階段：那是破壞性動作，而且誤判時會直接丟掉使用者的現場。
 * 這裡只做偵測與告知，要不要重啟由使用者決定。
 */

/**
 * 30 秒。單一步進在教案播放情境下遠遠用不到這麼久，但仍足以容忍
 * `next` 跨過一個慢函式。continue 不掛看門狗——程式本來就可能跑很久。
 */
export const STEP_WATCHDOG_MS = 30_000;

export type WatchdogDeps = {
  /** 逾時當下是否仍在執行中。回 false 代表已經正常停下來了，不算卡死。 */
  isStillRunning: () => boolean;
  /** 判定卡死時呼叫。 */
  onWedged: (command: string, seconds: number) => void;
};

let timer: ReturnType<typeof setTimeout> | null = null;

/** 送出步進命令後呼叫。重複呼叫會取代前一個計時器。 */
export function armStepWatchdog(
  command: string,
  deps: WatchdogDeps,
  timeoutMs: number = STEP_WATCHDOG_MS
): void {
  clearStepWatchdog();
  timer = setTimeout(() => {
    timer = null;
    // 已經停下來就什麼都不做：計時器比停駐事件晚一步觸發是常態，
    // 不先確認狀態的話每次正常步進都會誤報。
    if (!deps.isStillRunning()) {
      return;
    }
    deps.onWedged(command, Math.round(timeoutMs / 1000));
  }, timeoutMs);
}

/** 停駐或程式結束時呼叫。 */
export function clearStepWatchdog(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 測試用：目前有沒有掛著的看門狗。 */
export function stepWatchdogPending(): boolean {
  return timer !== null;
}
