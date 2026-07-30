"""標籤的正規化與限制。

正規化這件事的唯一目的：讓「同一個標籤」在全站真的是同一個東西。使用者會打
BST、bst、` BST `、全形空白，這些必須收斂成一列，否則標籤列會出現四個看起來
一樣的項目，而每一個都只有一篇教案。
"""

from contextlib import closing

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


from gdbgui.server import db
from .conftest import register_user


def _lesson(user_id: int, title: str = "測試教案") -> int:
    return db.create_lesson(user_id, title, '{"version":"2.0","source_code":"int main(){}"}')


def test_setting_tags_stores_them_normalized(flask_app):
    uid = register_user(flask_app, display_name="tag_a").user_id
    lid = _lesson(uid)
    assert tags.set_lesson_tags(lid, uid, "BST, STL") == ["bst", "stl"]
    assert tags.tags_for_lessons([lid]) == {lid: ["bst", "stl"]}


def test_setting_tags_returns_alphabetical_order_matching_tags_for_lessons(flask_app):
    """set_lesson_tags 當下回傳的順序，要跟重新整理頁面時 tags_for_lessons 讀回來的
    順序一致——否則同一批標籤在寫入當下（若照輸入序）跟重新整理後（字母序，
    tags_for_lessons 用 ORDER BY t.name ASC）會不一樣，UI 上會閃一下。
    這裡刻意用一個輸入序不等於字母序的例子，讓這條斷言在 sorted() 被拿掉時會紅。
    """
    uid = register_user(flask_app, display_name="tag_order").user_id
    lid = _lesson(uid)
    result = tags.set_lesson_tags(lid, uid, "zeta, alpha, mid")
    assert result == ["alpha", "mid", "zeta"]
    assert tags.tags_for_lessons([lid]) == {lid: result}


def test_setting_tags_replaces_wholesale_not_incrementally(flask_app):
    """送什麼就是什麼。增量語意會讓「拿掉一個標籤」變成沒有辦法表達的動作。"""
    uid = register_user(flask_app, display_name="tag_b").user_id
    lid = _lesson(uid)
    tags.set_lesson_tags(lid, uid, "a, b, c")
    tags.set_lesson_tags(lid, uid, "b")
    assert tags.tags_for_lessons([lid]) == {lid: ["b"]}


def test_setting_an_empty_string_clears_all_tags(flask_app):
    uid = register_user(flask_app, display_name="tag_c").user_id
    lid = _lesson(uid)
    tags.set_lesson_tags(lid, uid, "a, b")
    assert tags.set_lesson_tags(lid, uid, "") == []
    assert tags.tags_for_lessons([lid]) == {lid: []}


def test_a_non_owner_cannot_change_tags(flask_app):
    """非作者回 None，而且原本的標籤一個字都沒變。"""
    author = register_user(flask_app, display_name="tag_d1").user_id
    other = register_user(flask_app, display_name="tag_d2").user_id
    lid = _lesson(author)
    tags.set_lesson_tags(lid, author, "原本的")

    assert tags.set_lesson_tags(lid, other, "被別人改掉") is None
    assert tags.tags_for_lessons([lid]) == {lid: ["原本的"]}


def test_tagging_a_missing_lesson_returns_none(flask_app):
    uid = register_user(flask_app, display_name="tag_e").user_id
    assert tags.set_lesson_tags(999_999_999, uid, "x") is None


def test_the_same_tag_on_two_lessons_is_one_row(flask_app):
    """全域標籤的核心性質：同一個名字在 tags 表裡只有一列。"""
    uid = register_user(flask_app, display_name="tag_f").user_id
    a, b = _lesson(uid, "甲"), _lesson(uid, "乙")
    tags.set_lesson_tags(a, uid, "共用")
    tags.set_lesson_tags(b, uid, "共用")
    with closing(db.connect()) as conn:
        n = conn.execute("SELECT COUNT(*) FROM tags WHERE name = '共用'").fetchone()[0]
    assert n == 1


def test_deleting_a_lesson_removes_its_tag_links(flask_app):
    """ON DELETE CASCADE 真的生效——connect() 有設 PRAGMA foreign_keys=ON。"""
    uid = register_user(flask_app, display_name="tag_g").user_id
    lid = _lesson(uid)
    tags.set_lesson_tags(lid, uid, "會被連坐")
    assert db.delete_lesson_owned_by(lid, uid) is True
    with closing(db.connect()) as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM lesson_tags WHERE lesson_id = ?", (lid,)
        ).fetchone()[0]
    assert n == 0


def test_tags_do_not_count_against_the_storage_quota(flask_app, monkeypatch):
    """配額防的是 bundle 撐爆磁碟。標籤有自己的上限（8 個 × 24 字），本身就有界，
    所以不進配額——否則貼幾個標籤就可能讓一個原本存得下的教案存不下。

    行為性斷言（主要防線）：門檻由測試自己從兩篇教案的實際位元組數算出來，
    剛好卡在邊界、不留任何餘裕。這樣不管「標籤位元組被併入配額」這件事發生
    在哪一層——SQL 常數本身，或是 _check_quotas 裡额外的 Python 加總——
    第二篇教案都會因為餘裕被吃掉而存不下，測試會紅。之前只斷言
    `db._USED_BYTES_SQL` 這個字串常數不含 "lesson_tags"，那只堵得住「改 SQL
    常數」這一種寫法；審查者的突變測試把位元組加總寫在 _check_quotas 的
    Python 邏輯裡（完全不碰那個字串常數），因此完全繞過去、28 passed。
    """
    uid = register_user(flask_app, display_name="tag_quota").user_id
    first_bundle = '{"version":"2.0","source_code":"int main(){}"}'
    second_bundle = '{"version":"2.0","source_code":"x"}'
    lid = db.create_lesson(uid, "測試教案", first_bundle)

    # 門檻 = 兩篇教案的位元組數總和，一點餘裕都不留。只要標籤的任何一個
    # 位元組被算進「這個使用者已用掉的空間」，第二篇就會超過門檻而被拒。
    first_bytes = len(first_bundle.encode("utf-8"))
    second_bytes = len(second_bundle.encode("utf-8"))
    monkeypatch.setattr(db, "MAX_USER_BYTES", first_bytes + second_bytes)

    tags.set_lesson_tags(lid, uid, "一, 二, 三, 四, 五, 六, 七, 八")

    assert db.create_lesson(uid, "還存得下", second_bundle)

    # 白箱防線（次要，補強而非取代上面的行為性斷言）：目前這份 SQL 常數本身
    # 沒有牽扯 lesson_tags/tags。
    assert "lesson_tags" not in db._USED_BYTES_SQL


def test_too_many_tags_is_refused_at_the_write_boundary(flask_app):
    """被拒時，不能連原本已經存在的標籤都一起弄丟——這要求驗證發生在任何
    毀壞性寫入（DELETE FROM lesson_tags）之前，而不是之後。"""
    uid = register_user(flask_app, display_name="tag_h").user_id
    lid = _lesson(uid)
    tags.set_lesson_tags(lid, uid, "a, b")

    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON + 1))
    with pytest.raises(tags.TagRejected):
        tags.set_lesson_tags(lid, uid, raw)
    assert tags.tags_for_lessons([lid]) == {lid: ["a", "b"]}


def test_tags_for_lessons_returns_an_entry_for_every_id_asked(flask_app):
    """沒有標籤的教案回空 list，不是缺一個鍵——呼叫端不必寫 .get(id, [])。"""
    uid = register_user(flask_app, display_name="tag_i").user_id
    a, b = _lesson(uid, "有標籤"), _lesson(uid, "沒標籤")
    tags.set_lesson_tags(a, uid, "x")
    assert tags.tags_for_lessons([a, b]) == {a: ["x"], b: []}


def test_tags_for_lessons_with_no_ids_is_an_empty_dict(flask_app):
    assert tags.tags_for_lessons([]) == {}


def test_a_zero_width_only_piece_is_skipped_like_an_empty_one():
    """U+200B（零寬空格）與 U+FEFF（BOM）從網頁複製貼上很常見。

    str.strip() 不吃這兩個字元，所以它們會活到 normalize_tag 才被移除，
    結果變成空字串 → 整串被拒。空片段跳過、零寬片段爆炸，這兩種行為不該不一致。
    """
    assert tags.parse_tag_input("a,​,b") == ["a", "b"]
    assert tags.parse_tag_input("a,﻿,b") == ["a", "b"]


def test_a_genuinely_invalid_tag_still_raises():
    """寬容只給「空」這一種。太長仍然要拒——否則上面那個改動會順手
    把長度上限一起吞掉，那就從修一個缺陷變成開一個洞。"""
    with pytest.raises(tags.TagRejected):
        tags.parse_tag_input("ok, " + "x" * (tags.MAX_TAG_LENGTH + 1))
