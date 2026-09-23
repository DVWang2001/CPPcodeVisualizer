/**
 * ContainerVisualizer 的輪詢一偵測到容器有資料，就會呼叫
 * registry["container"].open() 把面板撐回來——原本是為了「有東西可看就自動
 * 秀出來」，但這會跟 applyLayout 的 close:container（或 open:xxx 沒帶
 * container 而被連帶關閉）打架：applyLayout 剛關掉，下一次輪詢馬上又開回去，
 * 使用者連手動收合都收不住。
 *
 * 這支函式判斷某一行的 @layout 字串是不是「明確要收掉/打開 container」，
 * 純函式、跟 SourceCode 元件的 state 完全脫鉤，方便單獨測試。
 */
export function resolveContainerAutoOpenSuppression(
  tokens: string[],
  idsToOpen: Set<string>,
  resolveId: (id: string) => string
): boolean | null {
  const containerClosedByLayout =
    (idsToOpen.size > 0 && !idsToOpen.has("container")) ||
    tokens.some(t => {
      const idx = t.indexOf(":");
      if (idx < 0 || t.slice(0, idx) !== "close") return false;
      return t.slice(idx + 1).split(",").some(id => resolveId(id.trim()) === "container");
    });
  if (containerClosedByLayout) return true;
  if (idsToOpen.has("container")) return false;
  return null;
}
