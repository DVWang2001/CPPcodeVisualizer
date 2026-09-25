// GDB 的 `next`／`step` 只在「行號（或所在函式）改變」時才停：同一行有多個語句、或整個迴圈寫在同一行，只算一站。
// 連續同一行的探針事件合併成一個，保留第一個（＝這一行執行前的狀態）。
export function dedupeSameLine(steps) {
  const out = [];
  for (const s of steps) {
    const p = out[out.length - 1];
    if (!p || p.line !== s.line || p.fn !== s.fn) out.push(s);
  }
  return out;
}
