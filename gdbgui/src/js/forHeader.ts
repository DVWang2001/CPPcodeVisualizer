// ── for 迴圈 A/B/C 三段式單步的純邏輯 ──────────────────────────
// 這個檔案沒有任何外部相依（不碰 store、不碰 React、不碰 GDB），
// 兩個匯出都是純函式，方便單元測試：
//   parseForHeader()    把 `for (A; B; C)` 切成三段字元範圍
//   decideForSegment()  用 frame.addr 判定目前停在初始化段(A)還是遞增段(C)
//
// 設計上最重要的一點：parseForHeader 回傳 null 代表「完全照現有行為走」
// ——不設虛步狀態、不加高亮、不攔截 next。最壞的失敗只會是「沒有三段高亮」，
// 絕不會變成「單步壞掉」。

export interface ForSegments {
  /** 初始化段 `int i = 0` 的 [start, end) 字元位移（0-indexed） */
  a: [number, number];
  /** 條件段 `i < 3` */
  b: [number, number];
  /** 遞增段 `i++` */
  c: [number, number];
}

export type ForSeg = "A" | "B" | "C";

// ── 小工具 ──────────────────────────────────────────────────

function is_word_char(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * text[i] 是 `"` 或 `'`，回傳「跳過整個常值之後」的索引。
 * 未收尾的常值直接吃到行尾（該行本來就不會是合法的 for 標頭）。
 */
function skip_quoted(text: string, i: number): number {
  const quote = text[i];
  let k = i + 1;
  while (k < text.length) {
    if (text[k] === "\\") {
      k += 2;
      continue;
    }
    if (text[k] === quote) return k + 1;
    k++;
  }
  return text.length;
}

/** 掃過整行，回傳第一個「不在字串/字元常值/註解裡」的 `for` 關鍵字位置。 */
function find_for_keyword(text: string): number | null {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skip_quoted(text, i);
      continue;
    }
    // 行註解（含本專案的 //@ 標註）之後不可能再有程式碼
    if (ch === "/" && text[i + 1] === "/") return null;
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (is_word_char(ch)) {
      let j = i;
      while (j < text.length && is_word_char(text[j])) j++;
      if (text.slice(i, j) === "for") return i;
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

/** 去掉頭尾空白後的 [start, end)。 */
function trim_range(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

// ── ① 解析器 ────────────────────────────────────────────────

/**
 * 解析一行原始碼裡的 `for (A; B; C)` 標頭。
 * 回傳三段的字元位移（0-indexed、半開區間；Monaco column 是 1-indexed，呼叫端 +1）。
 *
 * 以下一律回 null（＝走現有行為）：
 *   - range-for `for (auto x : v)`：沒有頂層分號
 *   - `while` / `do-while` / 其他關鍵字：找不到 for
 *   - 多行 for 標頭：該行找不到配對的右括號
 *   - 頂層分號數不等於 2
 *
 * `for (;;)` 會解析成功，三段皆為空範圍（不產生高亮，但虛步照常運作）。
 */
export function parseForHeader(lineText: string): ForSegments | null {
  if (typeof lineText !== "string" || !lineText) return null;

  const for_idx = find_for_keyword(lineText);
  if (for_idx === null) return null;

  let i = for_idx + 3;
  while (i < lineText.length && /\s/.test(lineText[i])) i++;
  if (lineText[i] !== "(") return null;
  const open = i;

  // 從左括號開始配對，同時記錄「深度 1」（即 for 標頭最外層）的分號位置。
  // 字串與字元常值整段跳過，所以 "a;b" 裡的分號不會被誤切。
  let depth = 0;
  let close = -1;
  const semis: number[] = [];
  for (let k = open; k < lineText.length; k++) {
    const ch = lineText[k];
    if (ch === '"' || ch === "'") {
      k = skip_quoted(lineText, k) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0 && ch === ")") {
        close = k;
        break;
      }
      if (depth < 0) return null;
      continue;
    }
    if (ch === ";" && depth === 1) semis.push(k);
  }

  if (close === -1) return null; // 多行 for 標頭
  if (semis.length !== 2) return null; // range-for 或其他非三段形式

  return {
    a: trim_range(lineText, open + 1, semis[0]),
    b: trim_range(lineText, semis[0] + 1, semis[1]),
    c: trim_range(lineText, semis[1] + 1, close),
  };
}

/** 取出某一段的字元範圍。 */
export function segRange(segs: ForSegments, seg: ForSeg): [number, number] {
  return seg === "A" ? segs.a : seg === "B" ? segs.b : segs.c;
}

// ── ② A / C 判定：用位址，不用計數 ────────────────────────────

/** frame.addr 是十六進位字串（如 "0x0000555555555158"），一律轉 BigInt 再比較。 */
function parse_addr(addr: unknown): bigint | null {
  if (typeof addr !== "string" || !addr.trim()) return null;
  try {
    return BigInt(addr.trim());
  } catch (_) {
    return null;
  }
}

/** 沒有位址可用時的佔位值：任何真實位址都不會比它小，所以之後一律判 C。 */
const NO_ADDR_SENTINEL = BigInt(0);

/**
 * 判定「這次停在 for 行」屬於初始化段(A)還是遞增段(C)。
 *
 * min_addrs 會被就地更新——**先更新最小值再判定**，這個順序讓規則能自我修正：
 * 若使用者把中斷點設在迴圈中間、第一次停到的是遞增區塊，該次會誤報 A；
 * 但迴圈重新進入時初始化區塊的較低位址會把 min 拉下來，之後判定即恢復正確。
 *
 * 已知假設：-O0 下初始化區塊的位址低於遞增區塊（編譯器按原始碼順序配置）。
 * frame.addr 缺失則退回「該行第一次停 → A」。
 */
export function decideForSegment(
  min_addrs: { [line: number]: bigint },
  line: number,
  addr: unknown
): "A" | "C" {
  const parsed = parse_addr(addr);
  if (parsed === null) {
    if (!(line in min_addrs)) {
      min_addrs[line] = NO_ADDR_SENTINEL;
      return "A";
    }
    return "C";
  }
  const prev = min_addrs[line];
  const min = prev === undefined || parsed < prev ? parsed : prev;
  min_addrs[line] = min;
  return parsed === min ? "A" : "C";
}
