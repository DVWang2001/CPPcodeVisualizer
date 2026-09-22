// ── 高亮格「放大再縮小」動畫的純邏輯 ───────────────────────────────────────
// CSS 只有 transition（平滑過渡到目標值、停在那裡），沒辦法表達「放大一下
// 又縮回去」這種去而復返的效果——那是 @keyframes 的事。要在 React 裡讓同一顆
// 格子重播一次 keyframes，最簡單的作法是換掉它的 key：key 變了，React 就會
// 把舊節點拆掉、掛一個新節點，瀏覽器對「剛掛上去」的節點套用 animation 屬性
// 自然就會播一次。
//
// key 的尾巴接上「世代號」（見 SourceCode.tsx 的 applyLayout「pop」分支）：
// GDB 每次真的停在一個新行，且那一行的 @layout 有 pop:容器名，該容器的世代
// 號就 +1。key 只看世代號變了沒，不看高亮的顏色變了沒——一開始拿顏色字串當
// key 尾巴，結果走方格教案連續三行都把同一格標成 lightblue（先亮起、算上面
// 算左邊、最後才寫值，顏色全程沒變），pop: 只加在最後一行，但顏色早在前兩行
// 就「亮」過了，比不出差異，動畫從來沒播過。世代號只在真的停在 pop: 那一行
// 時才會動，其餘（同一停駐點內的重繪、沒寫 pop: 的行）世代號不變，key 也就
// 不變，不會多跳。

export function popCellKey(
  baseKey: string,
  popGeneration: number | undefined,
  hl: { bg: string } | null | undefined
): { key: string; className: string | undefined } {
  if (popGeneration && hl) {
    return { key: `${baseKey}-pop-${popGeneration}`, className: "cell-pop" };
  }
  return { key: baseKey, className: undefined };
}
