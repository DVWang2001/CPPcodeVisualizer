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

// ── 只讓「這個顏色」的格子跳，其他顏色不動 ─────────────────────────────────
// `pop:dp` 全容器共用一個世代號；`pop:dp:orange` 只點名 orange 這個顏色，
// 開在自己的 key 底下，跟 `pop:dp` 的世代號互不影響——這樣「講上面時只跳
// 上面那格、講左邊時只跳左邊那格」才做得到，不會每次都整個容器一起跳。
// 兩者可以並存：一格若同時符合「全容器」跟「這個顏色專屬」兩個世代號，取
// 較新（較大）的那個，一樣是「世代號變了才重播」的邏輯。

export function popGenKey(containerName: string, color?: string): string {
  return color ? `${containerName}:${color}` : containerName;
}

export function effectivePopGen(
  popGen: Map<string, number>,
  containerName: string,
  cellColor: string | undefined
): number {
  const whole = popGen.get(popGenKey(containerName)) || 0;
  const scoped = cellColor ? popGen.get(popGenKey(containerName, cellColor)) || 0 : 0;
  return Math.max(whole, scoped);
}

// ── 減少動態效果 ────────────────────────────────────────────────────────────
// swap（LinearPlugin）、pull（ContainerVisualizer）的位移都是用 inline style
// 直接算出來的，不是 CSS class，沒辦法像 cell-pop 那樣交給 @media 處理，兩邊
// 都要在觸發動畫前查一次，所以共用同一份。
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
