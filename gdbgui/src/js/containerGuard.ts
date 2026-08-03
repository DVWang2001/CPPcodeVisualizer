/**
 * 擋住「展開尚未建構完成的容器」。
 *
 * 停在容器的宣告行時（自動下在 main 的斷點常常正好落在那裡），物件還沒建構，
 * `_M_start` / `_M_finish` 是垃圾值。libstdc++ 的 pretty-printer 照著算出荒謬的
 * 元素數，而 `-var-list-children` 會據此逐一讀取元素——對未映射記憶體無止境地
 * `pread64`（每次回 EIO、位址每次 +4），GDB 主執行緒 100% CPU 空轉、再也不回
 * 任何 MI 回應，整個除錯階段報廢。
 *
 * GDB 端沒有設定救得了（實測 `set print elements`、`set max-value-size`、
 * 停用 pretty-printer 都無效）。但 `-var-create` **不會**卡死，而且它回傳的
 * value 已經把壞狀態寫在臉上：
 *
 *     value="std::vector of length -1177, capacity 1953396601734698187"
 *
 * 所以在展開子節點前先看這個字串就能安全地擋下來。
 */

/** 超過這個數量就當作垃圾值。真實教學用的容器不會接近它。 */
export const MAX_SANE_ELEMENTS = 1_000_000;

const NUMBER_PATTERNS = [/of length (-?\d+)/, /capacity (-?\d+)/, /with (-?\d+) elements?/];

/**
 * pretty-printer 回報的長度／容量是否荒謬到不能展開。
 *
 * 只看 `-var-create` 已經拿到的 value 字串，不對 GDB 發任何命令——重點就是
 * 「在不觸發那個無限迴圈的前提下判斷」。
 */
export function looksUnconstructed(value: unknown): boolean {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  for (const pattern of NUMBER_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) {
      continue;
    }
    const n = Number(match[1]);
    if (!Number.isFinite(n)) {
      continue;
    }
    if (n < 0 || n > MAX_SANE_ELEMENTS) {
      return true;
    }
  }
  return false;
}
