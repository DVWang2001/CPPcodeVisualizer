// ── 從原始碼那一行的文字判斷「這是不是在交換同一個容器的兩個元素」──────────
// 純字串處理，不碰 GDB；真正把兩個索引表達式求值成數字是呼叫端
// （VisualizerHelper.detect_swap_call）的事，這裡只負責認出 swap(a[x], a[y])
// 這種形狀、抓出容器名跟兩個索引表達式的文字。
//
// 認得的形狀：swap(arr[i], arr[j])、std::swap(arr[i], arr[j])。
// 認不出的（回 null，交給 LinearPlugin.diffOps 既有的「值剛好對調」猜測兜底）：
//   - 手寫三段式 tmp=a;a=b;b=tmp;（沒有 swap 呼叫可以解析）
//   - iter_swap(it1, it2)（迭代器不是 name[idx] 形狀）
//   - 交換的是兩個不同容器的元素（swap(a[i], b[j])）——語意上也不該套「同容器換位置」動畫
//   - 索引不是方括號寫法，例如 swap(v.at(i), v.at(j))

export interface SwapCallMatch {
  containerName: string;
  indexExprA: string;
  indexExprB: string;
}

export function parseSwapCall(lineText: string): SwapCallMatch | null {
  const code = (lineText || "").split("//@")[0];
  const m = code.match(/\b(?:std::)?swap\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return null;
  const args = splitTopLevelComma(m[1]);
  if (args.length !== 2) return null;
  const a = parseIndexed(args[0]);
  const b = parseIndexed(args[1]);
  if (!a || !b || a.name !== b.name) return null;
  return { containerName: a.name, indexExprA: a.index, indexExprB: b.index };
}

function parseIndexed(expr: string): { name: string; index: string } | null {
  const t = expr.trim();
  const m = t.match(/^([A-Za-z_]\w*)\s*\[\s*(.+)\s*\]$/);
  if (!m) return null;
  return { name: m[1], index: m[2].trim() };
}

/** 在「深度 0」的逗號切開，方括號/圓括號裡的逗號不算（例如索引本身是個函式呼叫）。 */
function splitTopLevelComma(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}
