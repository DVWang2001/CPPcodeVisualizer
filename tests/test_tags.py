"""標籤的正規化與限制。

正規化這件事的唯一目的：讓「同一個標籤」在全站真的是同一個東西。使用者會打
BST、bst、` BST `、全形空白，這些必須收斂成一列，否則標籤列會出現四個看起來
一樣的項目，而每一個都只有一篇教案。
"""

import pytest

from gdbgui.server import tags


def test_case_is_folded():
    assert tags.normalize_tag("BST") == tags.normalize_tag("bst") == "bst"


def test_surrounding_and_inner_whitespace_is_collapsed():
    assert tags.normalize_tag("  二分   搜尋  ") == "二分 搜尋"


def test_fullwidth_forms_are_normalized_to_ascii():
    """NFKC：全形 ＳＴＬ 與半形 STL 是同一個標籤。"""
    assert tags.normalize_tag("ＳＴＬ") == "stl"


def test_control_characters_are_stripped():
    assert tags.normalize_tag("BS\x00T​") == "bst"


def test_chinese_tags_work():
    assert tags.normalize_tag("遞迴") == "遞迴"


def test_an_empty_tag_is_refused():
    with pytest.raises(tags.TagRejected):
        tags.normalize_tag("   ")


def test_a_tag_over_the_length_cap_is_refused():
    with pytest.raises(tags.TagRejected):
        tags.normalize_tag("x" * (tags.MAX_TAG_LENGTH + 1))


def test_a_tag_at_the_length_cap_is_accepted():
    assert tags.normalize_tag("x" * tags.MAX_TAG_LENGTH) == "x" * tags.MAX_TAG_LENGTH


def test_comma_separated_input_becomes_a_list():
    assert tags.parse_tag_input("BST, STL,二分搜尋") == ["bst", "stl", "二分搜尋"]


def test_fullwidth_comma_also_separates():
    """使用者用中文輸入法打逗號，得到的是全形逗號。"""
    assert tags.parse_tag_input("BST，STL") == ["bst", "stl"]


def test_empty_pieces_are_dropped_not_errors():
    assert tags.parse_tag_input("a,,  ,b") == ["a", "b"]


def test_duplicates_collapse_keeping_first_order():
    assert tags.parse_tag_input("STL, stl, BST") == ["stl", "bst"]


def test_too_many_tags_is_refused():
    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON + 1))
    with pytest.raises(tags.TagRejected):
        tags.parse_tag_input(raw)


def test_exactly_the_tag_limit_is_accepted():
    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON))
    assert len(tags.parse_tag_input(raw)) == tags.MAX_TAGS_PER_LESSON


def test_empty_input_is_an_empty_list_not_an_error():
    assert tags.parse_tag_input("") == []
    assert tags.parse_tag_input(None) == []
