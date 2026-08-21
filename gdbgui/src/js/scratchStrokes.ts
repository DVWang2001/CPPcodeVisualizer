/**
 * 學生手機上的草稿畫布 —— 白紙的數位版。
 *
 * 座標一律**正規化到 0..1**，不是像素。手機轉向、鍵盤彈出、瀏覽器重整都會改變畫布
 * 尺寸；存像素的話重畫會被拉伸變形，存比例就能照新尺寸還原。
 *
 * 只留在這支手機上，不會送出。所以送出答案之後、甚至老師收卷之後，學生手上仍然留著
 * 自己的推導過程可以對照正解——這是實體白紙做不到的（白紙會被收走或翻頁）。
 *
 * 讀取一律「壞了就當作沒有」：草稿是加分項，不能因為存的東西壞掉就讓整個作答頁掛掉。
 */
export type ScratchPoint = { x: number; y: number };
export type ScratchStroke = ScratchPoint[];

const PREFIX = "gdbgui_scratch:";

const validPoint = (p: any): p is ScratchPoint =>
  p !== null &&
  typeof p === "object" &&
  typeof p.x === "number" &&
  typeof p.y === "number" &&
  p.x >= 0 && p.x <= 1 &&
  p.y >= 0 && p.y <= 1;

export function loadStrokes(questionKey: string): ScratchStroke[] {
  try {
    const raw = localStorage.getItem(PREFIX + questionKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    for (const stroke of parsed) {
      if (!Array.isArray(stroke) || !stroke.every(validPoint)) return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

export function saveStrokes(questionKey: string, strokes: ScratchStroke[]): void {
  try {
    // 手指點一下沒有移動會產生零長度的筆畫，存下來只是噪音。
    const kept = strokes.filter(stroke => stroke.length > 0);
    localStorage.setItem(PREFIX + questionKey, JSON.stringify(kept));
  } catch {
    // 配額滿或隱私模式——草稿是加分項，存不了也不能打斷作答
  }
}

export function clearStrokes(questionKey: string): void {
  try {
    localStorage.removeItem(PREFIX + questionKey);
  } catch {
    // 同上
  }
}
