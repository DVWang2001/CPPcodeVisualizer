/**
 * ContainerVisualizer 的輪詢一偵測到容器有資料，就會呼叫
 * registry["container"].open() 把面板撐回來——原本是為了「有東西可看就自動
 * 秀出來」，但這會跟 applyLayout 的 close:container（或 open:xxx 沒帶
 * container 而被連帶關閉）打架：applyLayout 剛關掉，下一次輪詢馬上又開回去，
 * 使用者連手動收合都收不住。
 *
 * 這支函式判斷某一行的 @layout 字串是不是「明確要收掉/打開 container」，
 * 純函式、跟 SourceCode 元件的 state 完全脫鉤，方便單獨測試。
 *
 * 呼叫端要把結果寫進獨立的 gdbgui_container_auto_open_suppressed 旗標，
 * 不能借用 LiveQuizPanel 出題流程用的 gdbgui_table_quiz_hides_container——
 * 那支旗標同時也在門控「確認出題」對話框要不要顯示（true 就不顯示）。
 * 兩支旗標語意不同、生效時機也不同：出題那支是「已經確認完、正在秀預覽」，
 * 這支是「教案這一行明確要收掉面板」；混用會在題目還沒確認出來之前就
 * 誤把確認對話框壓住，導致老師永遠看不到「確認出題」（實測過的真實 bug）。
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
