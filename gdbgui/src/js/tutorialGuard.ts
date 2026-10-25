/**
 * 教學頁：程式碼不能改，只能改 `//@` 註解。
 * 「程式碼」＝每一行第一個 `//` 之前的部分（去掉行尾空白）；`//` 之後都算註解，可以自由編輯。
 * 純函式，方便測試；SourceCode.tsx 負責接到 Monaco 上。
 */

/** 一行的程式碼部分（第一個 `//` 之前，去掉行尾空白）。 */
export function codePart(line: string): string {
  const i = line.indexOf("//");
  return (i >= 0 ? line.slice(0, i) : line).replace(/\s+$/, "");
}

/** 整份程式的「骨架」：每一行的程式碼部分。 */
export function skeletonOf(text: string): string[] {
  return text.split("\n").map(codePart);
}

/**
 * 新的內容只動了註解嗎？行數要一樣，每一行的程式碼部分要跟基準一樣。
 * 例外：行尾正在輸入第一個 `/`（`//@` 還沒打完）也算，不然沒辦法一個字一個字打出 `//@`。
 */
export function isCommentOnlyEdit(base: string[], text: string): boolean {
  const lines = text.split("\n");
  if (lines.length !== base.length) return false;
  return lines.every((l, i) => {
    if (codePart(l) === base[i]) return true;
    // 行尾剛打的第一個 `/`（可以前面隔著空白）
    const t = l.replace(/\s+$/, "");
    return t.endsWith("/") && t.slice(0, -1).replace(/\s+$/, "") === base[i];
  });
}

/**
 * 光標（沒選取）如果停在程式碼裡，要移到哪一欄？移到這一行的行尾（註解的位置）；
 * 不在程式碼裡就維持原欄位。行還是同一行，所以「點一行再按 Enter 執行到那一行」不受影響。
 */
export function snapColumn(line: string, col: number): number {
  const codeLen = codePart(line).length;
  return codeLen > 0 && col <= codeLen ? line.length + 1 : col;
}

export type Sel = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/**
 * 這些選取範圍有沒有碰到程式碼的字元？有的話編輯器要暫時唯讀。
 * 游標在程式碼結尾之後（第 codeLen+1 欄起）是安全的：可以在那裡接上 `//@ …`。
 */
export function selectionTouchesCode(lines: string[], sels: Sel[]): boolean {
  return sels.some(s => {
    const isCaret = s.startLineNumber === s.endLineNumber && s.startColumn === s.endColumn;
    for (let ln = s.startLineNumber; ln <= s.endLineNumber; ln++) {
      const line = lines[ln - 1] ?? "";
      const codeLen = codePart(line).length;
      if (codeLen === 0) continue;
      // 這一行被選到的欄位區間 [a, b)（欄位從 1 起算，落在字元「之間」）。
      const a = ln === s.startLineNumber ? s.startColumn : 1;
      const b = ln === s.endLineNumber ? s.endColumn : line.length + 1;
      if (a === b) {
        // 游標（沒選取）：落在程式碼中間或剛好貼著第一個字元前面，打字會改到程式碼。
        if (isCaret && a <= codeLen) return true;
        continue;
      }
      // 有選取：只要選到的字元裡有程式碼的字元（起點落在程式碼內）就算。
      if (a <= codeLen) return true;
    }
    return false;
  });
}
