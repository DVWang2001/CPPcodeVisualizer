"""教案的三層儲存上限：單篇、每人總量、全站總量。

設計依據：真實教案量出來是 0.9–6.0 KB（cf_oop 那 24 篇平均 1.6 KB），所以
單篇 256 KB 是最大真實教案的約 40 倍、每人 20 MB 約 3000 篇。這些數字的用途
不是限制正常使用，是讓「填滿磁碟」這件事有界。

要守住的性質，依重要性排：

1. **使用者永遠能自救。** 配額用盡時刪掉舊教案就能再存——否則就是一個使用者
   無法脫離的死結。這也是為什麼用量以 bundle 位元組總和衡量，而不是 SQLite
   檔案大小（刪除後檔案不會縮小，除非 VACUUM）。
2. **每次改動都算完整快照。** 歷史版本要留下來，所以每次提交都會增加新版
   bundle 的完整位元組數；不變的提交不建立快照，也不增加用量。
3. **fork 算在 fork 的人頭上**，不是原作者。
4. 全站上限觸發時只擋新增，讀取與登入不受影響。

per-user 與全站的上限用 monkeypatch 調小來測——真的塞 20 MB 只是讓測試變慢，
不會多驗證到任何東西。
"""

from contextlib import closing

import pytest

from gdbgui.server import db
from .conftest import register_user


def _bundle_of_size(nbytes: int) -> str:
    """回傳一個恰好 nbytes 位元組的 bundle JSON 字串（純 ASCII）。"""
    shell = '{"version":"2.0","source_code":"%s"}'
    pad = nbytes - (len(shell) - 2)
    assert pad > 0, "要求的大小比外殼還小"
    out = shell % ("x" * pad)
    assert len(out.encode("utf-8")) == nbytes, (len(out.encode("utf-8")), nbytes)
    return out


# ---------------------------------------------------------------------------
# 單篇上限
# ---------------------------------------------------------------------------


def test_a_lesson_just_under_the_per_lesson_cap_is_accepted(flask_app):
    uid = register_user(flask_app, display_name="quota_a").user_id
    lid = db.create_lesson(uid, "剛好在上限內", _bundle_of_size(db.MAX_BUNDLE_BYTES))
    assert db.lesson_by_id(lid) is not None


def test_a_lesson_over_the_per_lesson_cap_is_refused(flask_app):
    uid = register_user(flask_app, display_name="quota_b").user_id
    with pytest.raises(db.LessonRejected):
        db.create_lesson(uid, "超過一個位元組", _bundle_of_size(db.MAX_BUNDLE_BYTES + 1))


def test_the_per_lesson_cap_counts_bytes_not_characters(flask_app):
    """一個中文字是三個位元組。撐爆磁碟的是位元組，所以上限必須數位元組。

    這條在意的是 LENGTH() 的陷阱：SQLite 的 LENGTH() 對 TEXT 數的是字元，
    所以用量統計一律要 CAST(... AS BLOB)。
    """
    uid = register_user(flask_app, display_name="quota_c").user_id
    # 字元數遠低於上限，位元組數超過
    chinese = "教" * (db.MAX_BUNDLE_BYTES // 3)
    payload = '{"v":"%s"}' % chinese
    assert len(payload) < db.MAX_BUNDLE_BYTES  # 以字元算沒超過
    assert len(payload.encode("utf-8")) > db.MAX_BUNDLE_BYTES  # 以位元組算超過
    with pytest.raises(db.LessonRejected):
        db.create_lesson(uid, "中文", payload)


# ---------------------------------------------------------------------------
# 每人總量
# ---------------------------------------------------------------------------


def test_the_per_user_quota_refuses_the_lesson_that_would_exceed_it(flask_app, monkeypatch):
    monkeypatch.setattr(db, "MAX_USER_BYTES", 3000)
    uid = register_user(flask_app, display_name="quota_d").user_id
    db.create_lesson(uid, "一", _bundle_of_size(1000))
    db.create_lesson(uid, "二", _bundle_of_size(1000))
    with pytest.raises(db.LessonQuotaExceeded) as exc:
        db.create_lesson(uid, "三", _bundle_of_size(1500))
    assert exc.value.limit == 3000
    assert exc.value.used == 2000


def test_one_users_lessons_do_not_count_against_another(flask_app, monkeypatch):
    monkeypatch.setattr(db, "MAX_USER_BYTES", 3000)
    a = register_user(flask_app, display_name="quota_e1").user_id
    b = register_user(flask_app, display_name="quota_e2").user_id
    db.create_lesson(a, "A 的", _bundle_of_size(2500))
    # B 完全沒用過空間，不該被 A 影響
    assert db.create_lesson(b, "B 的", _bundle_of_size(2500))


def test_a_user_at_quota_can_delete_and_save_again(flask_app, monkeypatch):
    """配額用盡時使用者必須能自救。

    這是三條裡最重要的一條：如果用量以 SQLite 檔案大小衡量，刪除之後檔案
    不會縮小（除非 VACUUM），使用者就會卡在一個自己解不開的死結裡。
    """
    monkeypatch.setattr(db, "MAX_USER_BYTES", 3000)
    uid = register_user(flask_app, display_name="quota_f").user_id
    first = db.create_lesson(uid, "先存的", _bundle_of_size(2000))
    with pytest.raises(db.LessonQuotaExceeded):
        db.create_lesson(uid, "存不下", _bundle_of_size(2000))

    assert db.delete_lesson_owned_by(first, uid) is True
    # 刪掉之後空間必須真的回來
    assert db.create_lesson(uid, "現在存得下了", _bundle_of_size(2000))


# ---------------------------------------------------------------------------
# 更新保留完整歷史快照
# ---------------------------------------------------------------------------


def test_each_changed_update_charges_a_full_new_snapshot(flask_app, monkeypatch):
    """若錯把更新當差額，第三次同尺寸提交會錯誤地通過。"""
    monkeypatch.setattr(db, "MAX_USER_BYTES", 2500)
    uid = register_user(flask_app, display_name="quota_g").user_id
    lid = db.create_lesson(uid, "v1", _bundle_of_size(1000))

    second = db.update_lesson_owned_by(lid, uid, "v2", _bundle_of_size(1000))
    assert hasattr(second, "version")
    assert second.version == 2
    with pytest.raises(db.LessonQuotaExceeded) as exc:
        db.update_lesson_owned_by(lid, uid, "v3", _bundle_of_size(1000))
    assert exc.value.used == 2000


def test_an_unchanged_save_does_not_consume_another_snapshot(flask_app, monkeypatch):
    monkeypatch.setattr(db, "MAX_USER_BYTES", 1500)
    uid = register_user(flask_app, display_name="quota_h").user_id
    bundle = _bundle_of_size(1000)
    lid = db.create_lesson(uid, "不變", bundle)

    result = db.update_lesson_owned_by(lid, uid, "不變", bundle)
    assert hasattr(result, "changed")
    assert result.changed is False
    with closing(db.connect()) as conn:
        used = conn.execute(db._USED_BYTES_SQL + " WHERE l.user_id = ?", (uid,)).fetchone()[0]
    assert used == 1000


def test_deleting_a_lesson_frees_every_historical_snapshot(flask_app, monkeypatch):
    monkeypatch.setattr(db, "MAX_USER_BYTES", 2500)
    uid = register_user(flask_app, display_name="quota_i").user_id
    lid = db.create_lesson(uid, "v1", _bundle_of_size(1000))
    db.update_lesson_owned_by(lid, uid, "v2", _bundle_of_size(1000))
    with pytest.raises(db.LessonQuotaExceeded):
        db.create_lesson(uid, "還差一點", _bundle_of_size(1000))

    assert db.delete_lesson_owned_by(lid, uid) is True
    assert db.create_lesson(uid, "刪完又存得下", _bundle_of_size(2000))


# ---------------------------------------------------------------------------
# 全站總量
# ---------------------------------------------------------------------------


def _site_bytes_used() -> int:
    """目前全站已用的位元組。測試共用同一個真實資料庫，所以上限必須相對於
    現況設定——寫死一個絕對值會因為前面跑過的測試留下資料而失敗。"""
    from contextlib import closing

    with closing(db.connect()) as conn:
        return int(conn.execute(db._USED_BYTES_SQL).fetchone()[0])


def test_the_site_quota_refuses_new_lessons_from_anyone(flask_app, monkeypatch):
    a = register_user(flask_app, display_name="quota_j1").user_id
    b = register_user(flask_app, display_name="quota_j2").user_id
    # 只留 3000 位元組的餘裕，剛好夠 A 存一篇 2500、不夠 B 再存 1000
    limit = _site_bytes_used() + 3000
    monkeypatch.setattr(db, "MAX_TOTAL_BYTES", limit)
    db.create_lesson(a, "把全站填滿", _bundle_of_size(2500))
    # B 自己的配額還很空，但全站滿了
    with pytest.raises(db.LessonQuotaExceeded) as exc:
        db.create_lesson(b, "存不下", _bundle_of_size(1000))
    assert exc.value.limit == limit


def test_reading_still_works_when_the_site_quota_is_full(flask_app, monkeypatch):
    """全站上限觸發時只擋新增。讀取壞掉的話，這個上限就從『優雅降級』
    變成『把整個站弄壞』——那還不如讓磁碟自己滿。"""
    a = register_user(flask_app, display_name="quota_k").user_id
    lid = db.create_lesson(a, "既有教案", _bundle_of_size(1000))
    monkeypatch.setattr(db, "MAX_TOTAL_BYTES", 500)  # 事後才調小，模擬已經超標
    assert db.lesson_by_id(lid) is not None
    assert len(db.lessons_for_user(a)) == 1
    with pytest.raises(db.LessonQuotaExceeded):
        db.create_lesson(a, "新的", _bundle_of_size(100))


# ---------------------------------------------------------------------------
# fork 算在 fork 的人頭上
# ---------------------------------------------------------------------------


def test_forking_charges_the_forker_not_the_author(flask_app, monkeypatch):
    monkeypatch.setattr(db, "MAX_USER_BYTES", 3000)
    author = register_user(flask_app, display_name="quota_l1").user_id
    forker = register_user(flask_app, display_name="quota_l2").user_id
    original = db.create_lesson(author, "原件", _bundle_of_size(2000))

    # fork 走的是新增路徑
    copy_id = db.create_lesson(forker, "副本", _bundle_of_size(2000))
    assert copy_id != original

    # 作者的用量沒有因為別人 fork 而增加：他還存得下 900 位元組
    assert db.create_lesson(author, "作者又存一篇", _bundle_of_size(900))
    # 而 fork 的人已經用掉 2000，存不下第二份 2000
    with pytest.raises(db.LessonQuotaExceeded):
        db.create_lesson(forker, "再一份", _bundle_of_size(2000))
