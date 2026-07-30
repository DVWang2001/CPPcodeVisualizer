"""教案標籤。

標籤詞彙是全站共用的（tags.name UNIQUE），但一篇教案掛什麼標籤只有它的作者
說了算——權限見 set_lesson_tags。

正規化的唯一目的是讓「同一個標籤」在全站真的是同一列。不另外保存「顯示用
原文」：那樣就得回答「誰的大小寫算數」（先貼的人？最後貼的人？），而那個
問題沒有好答案。存什麼就顯示什麼。
"""

import re
import unicodedata
from contextlib import closing
from typing import Dict, Iterable, List, Optional

from . import db

#: 一篇教案最多幾個標籤。超過就不是分類，是筆記。
MAX_TAGS_PER_LESSON = 8
#: 單一標籤的字元上限（正規化後）。標籤是標籤，不是句子。
MAX_TAG_LENGTH = 24

_WHITESPACE_RUN = re.compile(r"\s+")


class TagRejected(ValueError):
    """標籤不符合規則。訊息會直接顯示給使用者，所以要說得出哪一條規則。"""


class EmptyTag(TagRejected):
    """正規化之後什麼都不剩。

    獨立成一個子類，是為了讓 parse_tag_input 能只寬容「空片段」這一種情況，
    而不必去比對錯誤訊息字串——訊息改個字那種寫法就壞了。
    它繼承 TagRejected，所以既有的 `except TagRejected` 呼叫端不受影響。
    """


def normalize_tag(raw: str) -> str:
    """把一個標籤字串收斂成正規形式，不合規則就丟 TagRejected。"""
    if not isinstance(raw, str):
        raise TagRejected("標籤必須是文字。")

    text = unicodedata.normalize("NFKC", raw)
    # Cc = 控制字元，Cf = 格式字元（含零寬空格 U+200B 之類看不見的東西）。
    # 這些混進標籤裡會製造兩個「看起來一模一樣」卻不相等的標籤。
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("Cc", "Cf"))
    text = _WHITESPACE_RUN.sub(" ", text).strip().casefold()

    if not text:
        raise EmptyTag("標籤不可以是空的。")
    if len(text) > MAX_TAG_LENGTH:
        raise TagRejected(f"標籤不可以超過 {MAX_TAG_LENGTH} 個字。")
    return text


def parse_tag_input(raw: Optional[str]) -> List[str]:
    """使用者打的逗號分隔字串 → 正規化、去重、保持輸入順序的標籤清單。

    空片段直接忽略（"a,,b" 是兩個標籤）——那是打字的手滑，不是錯誤。
    """
    if raw is None:
        return []
    if not isinstance(raw, str):
        raise TagRejected("標籤必須是文字。")

    # 中文輸入法打出來的是全形逗號。NFKC 也會把它轉成半形，但那發生在
    # 切開之後，所以這裡先明確換掉。
    out: List[str] = []
    for piece in raw.replace("，", ",").split(","):
        try:
            tag = normalize_tag(piece)
        except EmptyTag:
            # 空片段、或只有空白／零寬字元的片段：那是打字或複製貼上的手滑，
            # 不是錯誤。長度超標之類的真問題仍然往外拋。
            continue
        if tag not in out:
            out.append(tag)

    if len(out) > MAX_TAGS_PER_LESSON:
        raise TagRejected(
            f"一篇教案最多 {MAX_TAGS_PER_LESSON} 個標籤（收到 {len(out)} 個）。"
        )
    return out


def set_lesson_tags(lesson_id: int, user_id: int, raw: Optional[str]) -> Optional[List[str]]:
    """整批取代一篇教案的標籤。回傳正規化後的清單；不是作者（或教案不存在）回 None。

    擁有權在**這裡**擋，而且在同一個交易裡先查再寫——呼叫端不需要、也不應該
    自己先查一次擁有者再呼叫（那中間有一個可以被插隊的空窗）。

    刻意不沿用 PUT /api/lessons 的 fork 行為：改內容是創作，另存副本合理；
    改標籤不是。靜默 fork 會讓人以為自己整理了教案庫，其實只是替自己複製了
    一堆。
    """
    tag_names = parse_tag_input(raw)  # 先驗證再開交易——不合規則就不必碰資料庫

    with closing(db.connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        owner = conn.execute(
            "SELECT user_id FROM lessons WHERE id = ?", (lesson_id,)
        ).fetchone()
        if owner is None or int(owner[0]) != user_id:
            conn.rollback()
            return None

        conn.execute("DELETE FROM lesson_tags WHERE lesson_id = ?", (lesson_id,))
        now = db._now()  # 跟 schema 其他時間戳同一個格式，刻意共用
        for name in tag_names:
            conn.execute(
                "INSERT INTO tags (name, created_at) VALUES (?, ?) "
                "ON CONFLICT(name) DO NOTHING",
                (name, now),
            )
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()[0]
            conn.execute(
                "INSERT INTO lesson_tags (lesson_id, tag_id) VALUES (?, ?)",
                (lesson_id, tag_id),
            )
        conn.commit()
    return tag_names


def tags_for_lessons(lesson_ids: Iterable[int]) -> Dict[int, List[str]]:
    """一次查多篇教案的標籤，避免清單頁對每一列各查一次。

    每個被問到的 id 都會有一個鍵，沒有標籤的是空 list——呼叫端因此不必寫
    .get(id, [])，模板裡也不會有 Undefined。
    """
    ids = [int(i) for i in lesson_ids]
    if not ids:
        return {}

    out: Dict[int, List[str]] = {i: [] for i in ids}
    # f-string 裡只放問號，值仍然全部走參數化——長得像字串拼 SQL，但拼進去的
    # 是 "?,?,?"，沒有任何使用者資料。
    placeholders = ",".join("?" * len(ids))
    with closing(db.connect()) as conn:
        rows = conn.execute(
            f"SELECT lt.lesson_id, t.name FROM lesson_tags lt "
            f"JOIN tags t ON t.id = lt.tag_id "
            f"WHERE lt.lesson_id IN ({placeholders}) "
            f"ORDER BY t.name ASC",
            ids,
        )
        for lesson_id, name in rows:
            out[int(lesson_id)].append(name)
    return out
