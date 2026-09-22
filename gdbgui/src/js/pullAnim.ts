// ── 「兩個來源格飛進目標格、合併成結果」動畫的純邏輯 ──────────────────────
// 語法解析（parsePullToken）+ 位置換算（computePullOffsets）都不碰 GDB/React，
// 方便單元測試。真正觸發動畫在 ContainerVisualizer.tsx 的 gdbgui_trigger_pull，
// 語法解析呼叫端在 SourceCode.tsx 的 applyLayout。
//
// 跟 pop:/swap 用同一套「相對位移用 % 不用像素」的道理：2D 格狀視圖的欄寬是吃
// 內容算出來的，列高是吃字型算出來的，JS 這邊都量不到絕對像素，但用格子自己的
// 100% 當基準乘上差幾列差幾欄，CSS 自己會算對。

export interface PullToken {
  containerName: string;
  colorA: string;
  colorB: string;
  targetColor: string;
}

/**
 * 解析 @layout 的 `pull:容器名:來源色1,來源色2->目標色`。
 * 認不出來（沒有 `->`、沒有 `:`、顏色不是剛好兩個）回 null——呼叫端就當這個
 * @layout token 沒有作用，不會有任何動畫，不是報錯。
 */
export function parsePullToken(val: string): PullToken | null {
  const arrowIdx = val.indexOf("->");
  if (arrowIdx < 0) return null;
  const targetColor = val.slice(arrowIdx + 2).trim();
  const before = val.slice(0, arrowIdx);
  const colonIdx = before.indexOf(":");
  if (colonIdx < 0) return null;
  const containerName = before.slice(0, colonIdx).trim();
  const colors = before.slice(colonIdx + 1).split(",").map(s => s.trim()).filter(Boolean);
  if (!containerName || !targetColor || colors.length !== 2) return null;
  return { containerName, colorA: colors[0], colorB: colors[1], targetColor };
}

export interface HighlightEntry {
  index: number;
  color: string;
}

export interface PullOffsets {
  aKey: string;
  bKey: string;
  targetKey: string;
  deltaA: { dRow: number; dCol: number };
  deltaB: { dRow: number; dCol: number };
}

/**
 * 從目前的高亮陣列找出來源色 A、B 跟目標色各自的格子位置，算出 A、B 要往目標
 * 飄幾列幾欄。cols 是這個 2D 容器一列有幾格，拿來把攤平的 index 換算成 (列,欄)。
 * 三個顏色只要有一個沒亮著就回 null——不強求，畫面上該亮什麼是 @guide 的事，
 * 這裡只負責「如果三個都亮著，該怎麼飄」。
 */
export function computePullOffsets(
  highlights: HighlightEntry[] | undefined,
  cols: number,
  colorA: string,
  colorB: string,
  targetColor: string
): PullOffsets | null {
  if (!highlights || cols <= 0) return null;
  const indexOf = (color: string) => highlights.find(h => h.color === color)?.index;
  const idxA = indexOf(colorA);
  const idxB = indexOf(colorB);
  const idxT = indexOf(targetColor);
  if (idxA === undefined || idxB === undefined || idxT === undefined) return null;

  const pos = (i: number) => ({ row: Math.floor(i / cols), col: i % cols });
  const a = pos(idxA);
  const b = pos(idxB);
  const t = pos(idxT);

  return {
    aKey: `${a.row},${a.col}`,
    bKey: `${b.row},${b.col}`,
    targetKey: `${t.row},${t.col}`,
    deltaA: { dRow: t.row - a.row, dCol: t.col - a.col },
    deltaB: { dRow: t.row - b.row, dCol: t.col - b.col },
  };
}

/**
 * 目標格在真正的值被 GDB 寫入之前（停在賦值那一行時，變數通常還沒被指派），
 * 先算一個「暫時的計算結果」浮在目標格上——目前只做「兩個來源值相加」，
 * 這是走格子 DP 這類教案最常見的組合方式。
 *
 * ponytail: 只支援加法；之後如果有教案要秀非加法的暫時值（例如 min/gcd），
 * 才需要真的接 GDB 運算式求值（@layout 目前只有 @guide/@tts 那層有 {expr}
 * 插值，@layout 本身沒有），不要現在為了假想需求先做。
 */
export function formatPullPreview(valueA: string, valueB: string): string | null {
  if (valueA.trim() === "" || valueB.trim() === "") return null;
  const a = Number(valueA);
  const b = Number(valueB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return String(a + b);
}
