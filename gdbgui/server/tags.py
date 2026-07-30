"""教案標籤。

標籤詞彙是全站共用的（tags.name UNIQUE），但一篇教案掛什麼標籤只有它的作者
說了算——權限見 set_lesson_tags。

正規化的唯一目的是讓「同一個標籤」在全站真的是同一列。不另外保存「顯示用
原文」：那樣就得回答「誰的大小寫算數」（先貼的人？最後貼的人？），而那個
問題沒有好答案。存什麼就顯示什麼。
"""

import re
import unicodedata
from typing import List, Optional

from . import db

#: 一篇教案最多幾個標籤。超過就不是分類，是筆記。
MAX_TAGS_PER_LESSON = 8
#: 單一標籤的字元上限（正規化後）。標籤是標籤，不是句子。
MAX_TAG_LENGTH = 24

_WHITESPACE_RUN = re.compile(r"\s+")


class TagRejected(ValueError):
    """標籤不符合規則。訊息會直接顯示給使用者，所以要說得出哪一條規則。"""


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
        raise TagRejected("標籤不可以是空的。")
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
        if not piece.strip():
            continue
        tag = normalize_tag(piece)
        if tag not in out:
            out.append(tag)

    if len(out) > MAX_TAGS_PER_LESSON:
        raise TagRejected(
            f"一篇教案最多 {MAX_TAGS_PER_LESSON} 個標籤（收到 {len(out)} 個）。"
        )
    return out
