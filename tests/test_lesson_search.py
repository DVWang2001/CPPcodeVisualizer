"""教案搜尋：文字比對標題／作者／標籤，加上可複選的標籤篩選，全部 AND。

最重要的一條是跳脫：`%` 與 `_` 是 LIKE 的萬用字元，不跳脫的話使用者打一個
`%` 就是無條件全表掃描——一個輸入框就能點的 DoS。
"""

import uuid
from contextlib import closing

import pytest

from gdbgui.server import db, tags
from .conftest import register_user


@pytest.fixture()
def corpus(flask_app):
    """三個作者、五篇教案，標籤刻意重疊，讓 AND 與 OR 會給出不同答案。

    所有字面值都帶一個唯一後綴。測試共用同一個資料庫（conftest 只建一次、
    不跨測試隔離），固定字面值會讓不同測試的 corpus 互相污染——依賴精確
    集合相等的斷言就會隨執行順序時好時壞。
    """
    uniq = uuid.uuid4().hex[:8]
    wang = register_user(flask_app, display_name=f"王老師{uniq}").user_id
    lin = register_user(flask_app, display_name=f"林助教{uniq}").user_id

    def T(name: str) -> str:
        """標籤名 → 這次 corpus 專屬的標籤名。"""
        return f"{name}{uniq}"

    def mk(uid, title, tag_names):
        lid = db.create_lesson(uid, title, '{"version":"2.0","source_code":"int main(){}"}')
        tags.set_lesson_tags(lid, uid, ", ".join(T(n) for n in tag_names))
        return lid

    return {
        "uniq": uniq,
        "T": T,
        "wang": wang,
        "lin": lin,
        "bst":  mk(wang, f"二元搜尋樹 lower_bound {uniq}", ["bst", "stl"]),
        "vec":  mk(wang, f"vector 擴容 {uniq}",            ["stl", "記憶體"]),
        "rec":  mk(lin,  f"遞迴呼叫樹 {uniq}",              ["遞迴", "樹"]),
        "dp":   mk(lin,  f"背包問題 {uniq}",                ["dp"]),
        "bare": mk(lin,  f"沒有標籤的一篇 {uniq}",          []),
    }


def _titles(rows):
    return [r["title"] for r in rows]


def _ids(rows):
    return {int(r["id"]) for r in rows}


# ── 文字搜尋 ───────────────────────────────────────────────────────────────


def test_matches_the_title(corpus):
    assert corpus["bst"] in _ids(db.search_lessons(q=f"lower_bound {corpus['uniq']}"))


def test_matches_the_author_display_name(corpus):
    found = _ids(db.search_lessons(q=f"王老師{corpus['uniq']}"))
    assert corpus["bst"] in found and corpus["vec"] in found
    assert corpus["rec"] not in found


def test_matches_a_tag_name(corpus):
    found = _ids(db.search_lessons(q=corpus["T"]("記憶體")))
    assert found == {corpus["vec"]}


def test_an_empty_query_returns_everything(corpus):
    assert len(db.search_lessons(q="", limit=50)) >= 5


# ── 跳脫（這一節是這個檔案存在的主要理由）─────────────────────────────────


def test_a_percent_sign_is_a_literal_not_a_wildcard(corpus):
    """打 % 要找的是標題裡有 % 的教案，不是「全部」。

    斷言刻意不是「全域結果是空的」：共用 DB 裡可能有別條測試（例如
    test_a_literal_percent_in_a_title_is_findable）留下真的帶 % 的標題，
    那本來就該被找到，不算誤判。這裡只驗證 corpus 這五篇（標題都不含 %）
    不會被「當萬用字元」意外命中。
    """
    found = _ids(db.search_lessons(q="%", limit=1000))
    corpus_ids = {corpus["bst"], corpus["vec"], corpus["rec"], corpus["dp"], corpus["bare"]}
    assert not (found & corpus_ids)


def test_an_underscore_is_a_literal_not_a_single_char_wildcard(corpus):
    """_ 在 LIKE 裡是「任一個字元」。不跳脫的話 "____" 會match四字標題。"""
    assert db.search_lessons(q="____") == []


def test_a_backslash_does_not_break_the_query(corpus):
    assert db.search_lessons(q="\\") == []


def test_a_literal_percent_in_a_title_is_findable(flask_app):
    uniq = uuid.uuid4().hex[:8]
    uid = register_user(flask_app, display_name=f"pct{uniq}").user_id
    lid = db.create_lesson(uid, f"折扣 50% 的算法 {uniq}", '{"version":"2.0","source_code":"x"}')
    assert lid in _ids(db.search_lessons(q="50%", limit=1000))


def test_an_over_long_query_is_truncated_to_the_cap(flask_app):
    """截斷必須真的發生，不能只是「沒有爆炸」。

    標題剛好 MAX_QUERY_LENGTH 個 x，查 MAX_QUERY_LENGTH + 50 個 x：
      有截斷 → pattern 收成 100 個 x → 命中
      無截斷 → pattern 是 150 個 x → 永遠比不到
    兩種行為給出不同結果，所以這條分辨得出來。
    網址是可以被亂改的，把它當輸入而不是契約。
    """
    uid = register_user(flask_app, display_name="q_trunc").user_id
    title = "x" * db.MAX_QUERY_LENGTH  # < MAX_TITLE_LENGTH (200)，存得下
    lid = db.create_lesson(uid, title, '{"version":"2.0","source_code":"y"}')
    found = _ids(db.search_lessons(q="x" * (db.MAX_QUERY_LENGTH + 50), limit=50))
    assert lid in found


# ── 標籤篩選 ───────────────────────────────────────────────────────────────


def test_a_single_tag_filters(corpus):
    assert _ids(db.search_lessons(tags=[corpus["T"]("stl")])) == {corpus["bst"], corpus["vec"]}


def test_multiple_tags_are_and_not_or(corpus):
    """這條分辨 AND 與 OR：OR 會給兩篇，AND 只給一篇。"""
    assert _ids(db.search_lessons(tags=[corpus["T"]("stl"), corpus["T"]("記憶體")])) == {corpus["vec"]}


def test_text_and_tags_are_also_and(corpus):
    assert _ids(db.search_lessons(q=f"王老師{corpus['uniq']}", tags=[corpus["T"]("stl")])) == {
        corpus["bst"],
        corpus["vec"],
    }
    assert db.search_lessons(q=f"林助教{corpus['uniq']}", tags=[corpus["T"]("stl")]) == []


def test_an_unknown_tag_gives_no_results_not_an_error(corpus):
    assert db.search_lessons(tags=["不存在的標籤"]) == []


def test_too_many_filter_tags_are_truncated_to_the_cap(flask_app):
    """截斷必須真的發生，而且是「保留前 N 個」。

    一篇教案貼滿 MAX_FILTER_TAGS 個真標籤，篩選時送那些 + 5 個不存在的：
      有截斷 → 只用前 8 個（都存在）→ 命中
      無截斷 → 13 個全都要有 → 落空
    """
    uid = register_user(flask_app, display_name="tag_trunc").user_id
    real = [f"tt{i}" for i in range(db.MAX_FILTER_TAGS)]
    lid = db.create_lesson(uid, "貼滿標籤", '{"version":"2.0","source_code":"y"}')
    tags.set_lesson_tags(lid, uid, ", ".join(real))

    many = real + [f"fake{i}" for i in range(5)]
    assert lid in _ids(db.search_lessons(tags=many, limit=50))


# ── 計數與分頁 ─────────────────────────────────────────────────────────────


def test_search_count_matches_the_unpaged_result(corpus):
    q = f"王老師{corpus['uniq']}"
    assert db.search_count(q=q) == len(db.search_lessons(q=q, limit=100))


def test_search_count_with_tags_matches_the_unpaged_result(corpus):
    """`search_count` 也要吃 `tags=`——不然使用者會看到「共 N 筆」跟清單筆數對不起來。

    這是 `_search_predicate` 三處共用存在的理由：只餵 `q=` 測不出計數忘了套用
    標籤篩選這種壞法。
    """
    t = [corpus["T"]("stl")]
    assert db.search_count(tags=t) == len(db.search_lessons(tags=t, limit=100))


def test_pagination_does_not_repeat_or_drop(corpus):
    page1 = db.search_lessons(limit=2, offset=0)
    page2 = db.search_lessons(limit=2, offset=2)
    assert len(page1) == 2 and len(page2) == 2
    assert _ids(page1).isdisjoint(_ids(page2))


def test_ordering_is_newest_first(corpus):
    rows = db.search_lessons(limit=50)
    keys = [(r["updated_at"], int(r["id"])) for r in rows]
    assert keys == sorted(keys, reverse=True)


def test_ties_on_updated_at_break_on_id_descending(corpus):
    """`_now()` 只到秒，corpus 這幾篇是同一次 fixture 呼叫連續建立的，
    `updated_at` 幾乎必定完全相同——同秒平手是常態，不是邊角案例。

    沒有 `id DESC` 這個第二排序鍵，`LIMIT/OFFSET` 分頁在平手時會漏或重複。

    這裡刻意連 `migrations/0002` 建的 `lessons_recent_idx (updated_at DESC, id DESC)`
    也暫時拿掉（結束前還原）：那個索引本身就是 `(updated_at DESC, id DESC)`，只要
    query planner 選它做 index scan，掃描順序天生就是 id DESC——不管 SQL 文字裡的
    `ORDER BY` 到底有沒有寫 `id DESC` 都一樣，那個索引會替沒寫 tie-break 的查詢
    「頂住」。所以光靠平常的查詢觀察不到「拿掉 id DESC」這個退化：只有沒有索引可用、
    SQLite 真的得對 updated_at 做 filesort 時，缺 tie-break 才會現形（那時候平手的
    列會退回 rowid／插入順序，也就是 id 遞增，跟預期的遞減相反）。
    """
    q = corpus["uniq"]  # 五篇教案的標題都帶這個後綴，updated_at 全部相同
    all_ids = _ids(db.search_lessons(q=q, limit=50))
    assert len(all_ids) == 5

    with closing(db.connect()) as conn:
        conn.execute("DROP INDEX IF EXISTS lessons_recent_idx")
    try:
        rows = db.search_lessons(q=q, limit=50)
        ids = [int(r["id"]) for r in rows]
        assert set(ids) == all_ids  # 沒漏、沒重複
        assert ids == sorted(ids, reverse=True)  # 嚴格遞減，不是巧合
    finally:
        with closing(db.connect()) as conn:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS lessons_recent_idx"
                " ON lessons (updated_at DESC, id DESC)"
            )


# ── 標籤列 ─────────────────────────────────────────────────────────────────


def test_tag_counts_are_scoped_to_the_result_set(corpus):
    """全站 stl 有兩篇，但在 q=王老師 的結果裡也是兩篇；記憶體是一篇。"""
    counts = {r["name"]: r["n"] for r in db.tag_counts(q=f"王老師{corpus['uniq']}")}
    assert counts[corpus["T"]("stl")] == 2
    assert counts[corpus["T"]("記憶體")] == 1
    assert corpus["T"]("遞迴") not in counts  # 林助教的標籤不該出現在王老師的結果裡


def test_tag_counts_exclude_tags_that_would_empty_the_result(corpus):
    """已經選了 stl 時，列上不該出現任何選了就變空的標籤。"""
    names = {r["name"] for r in db.tag_counts(tags=[corpus["T"]("stl")])}
    assert corpus["T"]("dp") not in names
    for name in names:
        assert db.search_lessons(tags=[corpus["T"]("stl"), name]), f"選 {name} 會變成空清單"


def test_tag_counts_are_ordered_by_use_then_name(corpus):
    rows = db.tag_counts()
    pairs = [(-int(r["n"]), r["name"]) for r in rows]
    assert pairs == sorted(pairs)
