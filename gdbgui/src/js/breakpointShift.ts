/**
 * 編輯器內容變動時，斷點的行號要跟著程式碼走。
 *
 * 抽成純函式是因為這段曾經出過 bug：刪掉有斷點的那一行之後，斷點留在程式末尾、
 * 點不掉。原因有三個（SourceCode.tsx 舊的寫法）：
 *   1. 整段被 `if (fullname_to_render)` 擋住——匯入教案或直接輸入時它是空字串，
 *      編輯時斷點行號完全不動；
 *   2. 只會平移，從不刪除「那一行已經被刪掉」的斷點；
 *   3. 沒有行數上限——斷點行號比總行數大時，Monaco 把標記夾到最後一行顯示，而
 *      點擊比對的是「行號相等」，點最後一行只會再新增一個，舊的永遠點不到。
 */

export type ContentChange = {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
};

const countNewlines = (text: string) => (text.match(/\r\n|\r|\n/g) || []).length;

/**
 * 一個 Monaco 變動事件裡所有 change 的座標都是「變動前」的座標，彼此不重疊。
 * 回傳舊行號 `line` 變動後的行號；那一行已經不存在就回 null。
 */
export function mapLine(line: number, changes: ContentChange[]): number | null {
  // 該行落在哪個 change 的範圍內（[startLine, endLine]）
  const touching = changes.find(
    (c) => line >= c.range.startLineNumber && line <= c.range.endLineNumber
  );
  const shiftBefore = (limit: number) =>
    changes.reduce((sum, c) => {
      if (c.range.endLineNumber >= limit) return sum;
      return sum + countNewlines(c.text) - (c.range.endLineNumber - c.range.startLineNumber);
    }, 0);

  if (!touching) return line + shiftBefore(line);

  const { startLineNumber: S, startColumn: sc, endLineNumber: E, endColumn: ec } = touching.range;
  const added = countNewlines(touching.text);
  const base = shiftBefore(S);

  if (S === E) return line + base; // 單行內的編輯（含在行中按 Enter）：斷點留在原行
  if (line === S) {
    // 整行刪掉：從 S 行首刪到 E 行首（Ctrl+Shift+K、選取整行按 Delete）
    const wholeLinesGone = sc === 1 && ec === 1 && touching.text === "";
    return wholeLinesGone ? null : line + base;
  }
  if (line < E) return null; // 夾在中間的行被併掉了
  // line === E：第 E 行 ec 欄之後的內容會接到新的第 S+added 行。
  // ec === 1 且前面沒有東西接在它前面時，整行原封不動地活下來，斷點跟著走；
  // 否則它是被併進別行（例如在行首按 Backspace 把這行接到上一行），斷點隨之消失。
  const survivesIntact = ec === 1 && (added > 0 ? /(\r\n|\r|\n)$/.test(touching.text) : sc === 1 && touching.text === "");
  return survivesIntact ? S + added + base : null;
}

type Options = {
  /** 變動前的總行數（整份被取代時，用來判斷「這不是編輯，是換檔」）。 */
  prevLineCount: number;
  /** 變動後的總行數：斷點行號不得超過它。 */
  lineCount: number;
  /** Monaco 的 setValue（換整份內容）會帶 isFlush。 */
  isFlush?: boolean;
};

const isNormal = (b: any) => b && b.is_normal_breakpoint !== false && !b.is_child_breakpoint;

/** 回傳新的斷點陣列；沒有任何變動就回傳原本那個陣列（呼叫端可用 === 判斷）。 */
export function shiftBreakpoints(bkpts: any[], changes: ContentChange[], opts: Options): any[] {
  // 整份內容被換掉（開檔、套用教案、全選後貼上）不是「編輯」，行號沒有對應關係，
  // 不能拿來平移或刪除；只做行數上限的保護。
  const wholesale =
    !!opts.isFlush ||
    changes.some(
      (c) =>
        c.range.startLineNumber === 1 &&
        c.range.startColumn === 1 &&
        c.range.endLineNumber >= opts.prevLineCount &&
        c.range.endLineNumber > 1
    );

  const seen = new Set<number>();
  let changed = false;
  const out: any[] = [];
  for (const b of bkpts) {
    const line = parseInt(b && b.line, 10);
    if (!isNormal(b) || isNaN(line)) {
      out.push(b);
      continue;
    }
    const mapped = wholesale ? line : mapLine(line, changes);
    if (mapped === null || mapped < 1 || mapped > opts.lineCount || seen.has(mapped)) {
      changed = true; // 該行已不存在、超出程式末尾，或撞到同一行已有的斷點
      continue;
    }
    seen.add(mapped);
    if (mapped === line) {
      out.push(b);
    } else {
      changed = true;
      out.push({
        ...b,
        line: String(mapped),
        original_location: b.original_location?.replace(`:${line}`, `:${mapped}`),
      });
    }
  }
  return changed ? out : bkpts;
}

/** 目前程式只有 `lineCount` 行：把行號超出的斷點拿掉（以前遺留下來的殘影也用這個清）。 */
export function dropOutOfRange(bkpts: any[], lineCount: number): any[] {
  const kept = bkpts.filter((b) => {
    if (!isNormal(b)) return true;
    const line = parseInt(b.line, 10);
    return isNaN(line) || (line >= 1 && line <= lineCount);
  });
  return kept.length === bkpts.length ? bkpts : kept;
}
