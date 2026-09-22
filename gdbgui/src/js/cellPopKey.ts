// ── 高亮格「放大再縮小」動畫的純邏輯 ───────────────────────────────────────
// CSS 只有 transition（平滑過渡到目標值、停在那裡），沒辦法表達「放大一下
// 又縮回去」這種去而復返的效果——那是 @keyframes 的事。要在 React 裡讓同一顆
// 格子重播一次 keyframes，最簡單的作法是換掉它的 key：key 變了，React 就會
// 把舊節點拆掉、掛一個新節點，瀏覽器對「剛掛上去」的節點套用 animation 屬性
// 自然就會播一次。
//
// key 的尾巴接上高亮的顏色字串：格子第一次亮起，或亮起的顏色換了，key 才變、
// 才會重播；同一格用同一個顏色連續亮著（例如輪詢重繪、或別的原因觸發重繪）
// 不會每次都跳一下——那樣會很吵。
//
// 只在「這格現在確實有高亮」時才套用，且只有呼叫端明確開啟（@layout pop:
// 容器名，見 AUTHORING_GUIDE §4.10）才會生效；沒開啟時 key 原封不動。

export function popCellKey(
  baseKey: string,
  enabled: boolean,
  hl: { bg: string } | null | undefined
): { key: string; className: string | undefined } {
  if (enabled && hl) {
    return { key: `${baseKey}-pop-${hl.bg}`, className: "cell-pop" };
  }
  return { key: baseKey, className: undefined };
}
