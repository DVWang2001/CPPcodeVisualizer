/**
 * 「別人的教案是唯讀的」這條規則的判斷邏輯。
 *
 * 規則本身在伺服器端就成立（live_quiz.create_session 的 WHERE l.user_id=? 、
 * 教案儲存走 fork），這裡守的是前端別提供無效的編輯入口。
 */

/** 與 SourceCode.isReadOnlyLesson 相同的判斷。 */
function isReadOnlyLesson(currentLessonId: number | null, currentLessonIsMine: boolean): boolean {
  return currentLessonId !== null && !currentLessonIsMine;
}

describe("isReadOnlyLesson", () => {
  it("別人的教案 → 唯讀", () => {
    expect(isReadOnlyLesson(21, false)).toBe(true);
  });

  it("自己的教案 → 可編輯", () => {
    expect(isReadOnlyLesson(21, true)).toBe(false);
  });

  it("全新／匯入的工作區（沒有 lesson id）→ 可編輯", () => {
    // 這條最容易寫錯：只看 isMine 的話，還沒存過的新教案會被誤鎖成唯讀。
    expect(isReadOnlyLesson(null, false)).toBe(false);
  });

  it("fork 之後（id 換成自己的那份、isMine 變 true）→ 解鎖", () => {
    expect(isReadOnlyLesson(99, true)).toBe(false);
  });

  it("id 為 0 仍視為有載入教案，不因 falsy 而漏判", () => {
    expect(isReadOnlyLesson(0, false)).toBe(true);
  });
});
