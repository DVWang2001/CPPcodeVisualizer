# 教案標籤與主頁瀏覽 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教案加上全站共用的標籤，主頁 `/` 換成可搜尋、可依標籤篩選的教案清單，除錯器搬到 `/edit`。

**Architecture:** 三層。`tags.py` 是純函式（正規化、驗證）加上標籤與教案的關聯讀寫；`db.py` 加兩個查詢函式（搜尋、標籤計數）；`http_routes.py` 換路由並加一個 API。前端不動 React，瀏覽頁是 Jinja 模板，沿用 `_auth_base.html` 既有的設計語言。

**Tech Stack:** Python 3.13 / Flask / SQLite（WAL、`foreign_keys=ON`）/ Jinja2 / pytest / Playwright

設計文件：`docs/superpowers/specs/2026-07-30-lesson-tags-and-browse-design.md`

## Global Constraints

* 每篇教案最多 **8** 個標籤；單一標籤正規化後 **1–24** 字元。
* 標籤正規化 = NFKC → 移除控制字元（Unicode 類別 `Cc`/`Cf`）→ 連續空白收成一個半形空格 → `strip()` → `casefold()`。
* 搜尋字串 `q` 上限 **100** 字元，超過**截斷**不報錯；篩選標籤上限 **8** 個，超過截斷。
* 文字與標籤、標籤與標籤之間一律 **AND**。
* `q` 進 SQL 前必須跳脫 `\`、`%`、`_`，並用 `ESCAPE '\'`。
* 排序永遠是 `updated_at DESC, id DESC`（第二個鍵是分頁正確性的必要條件，見 `migrations/0002`）。
* 標籤寫入只有教案作者可以，非作者回 **404**（不是 403——403 等於確認「這篇存在但不是你的」）。
* migration 必須冪等（`CREATE TABLE IF NOT EXISTS` 等），理由見 `db.migrate()`。
* 每次 `git commit` 都會觸發 pre-commit 跑 jest；Python 測試要自己跑。
* e2e 一律加 `--build`：`docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test`

## File Structure

| 檔案 | 職責 |
|---|---|
| `gdbgui/server/migrations/0003_tags.sql` | 建 `tags`、`lesson_tags` 與索引 |
| `gdbgui/server/tags.py`（新） | 正規化／驗證／`set_lesson_tags`／`tags_for_lessons` |
| `gdbgui/server/db.py` | 新增 `search_lessons`、`search_count`、`tag_counts` |
| `gdbgui/server/http_routes.py` | `/` ↔ `/edit` 換位、兩條轉址、標籤 API |
| `gdbgui/server/auth.py` | 個人檔案頁帶標籤資料 |
| `gdbgui/templates/lessons.html` | 改成瀏覽頁（搜尋框＋標籤列） |
| `gdbgui/templates/profile.html` | 加標籤顯示與編輯表單 |
| `tests/test_tags.py`（新） | 正規化、限制、權限、CASCADE |
| `tests/test_lesson_search.py`（新） | 搜尋、跳脫、AND、計數、分頁 |
| `e2e/tests/zz_lesson_tags.spec.ts`（新） | 貼標籤→搜尋得到、點標籤、兩條轉址 |

`tags.py` 獨立出來是因為正規化是純函式、會被 API 與模板兩處用到，而且是最需要被測的部分。搜尋查詢留在 `db.py`，因為它跟既有的 `recent_lessons` / `lesson_count` 是同一類東西，拆走只會讓「教案怎麼查」散在兩個檔案。

---

### Task 1: 資料表與標籤正規化

**Files:**
- Create: `gdbgui/server/migrations/0003_tags.sql`
- Create: `gdbgui/server/tags.py`
- Test: `tests/test_tags.py`

**Interfaces:**
- Consumes: `db.connect()`、`db._now()`
- Produces: `tags.TagRejected`、`tags.normalize_tag(str) -> str`、`tags.parse_tag_input(str) -> list[str]`、`tags.MAX_TAGS_PER_LESSON = 8`、`tags.MAX_TAG_LENGTH = 24`

- [ ] **Step 1: 寫 migration**

`gdbgui/server/migrations/0003_tags.sql`：

```sql
-- 教案標籤。詞彙是全站共用的：同一個標籤在不同教案之間是 tags 裡的同一列，
-- 這正是「全域標籤」的意思，也是計數與列出標籤的前提。存 TEXT 欄位搜尋得到，
-- 但那兩件做不到。
--
-- ★ Migration 必須寫成冪等的 ★（理由見 0001 與 db.migrate() 的說明）

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    -- 正規化後的形式（NFKC → 去控制字元 → 收斂空白 → casefold）。
    -- UNIQUE 是「BST 與 bst 是同一個標籤」的實際保證。
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_tags (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id),
    -- 這個 PK 同時是「同一篇不會重複掛同一個標籤」的保證，以及
    -- 「這篇有哪些標籤」的索引，所以不需要第二個索引。
    PRIMARY KEY (lesson_id, tag_id)
);

-- 反向：「有這個標籤的教案有哪些」——標籤篩選的查詢型態。
CREATE INDEX IF NOT EXISTS lesson_tags_tag_idx ON lesson_tags (tag_id);
```

- [ ] **Step 2: 寫失敗的測試**

`tests/test_tags.py`：

```python
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
```

- [ ] **Step 3: 確認測試失敗**

Run: `python -m pytest tests/test_tags.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'gdbgui.server.tags'`

- [ ] **Step 4: 實作 `tags.py` 的正規化部分**

```python
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
```

- [ ] **Step 5: 確認測試通過**

Run: `python -m pytest tests/test_tags.py -q`
Expected: PASS（15 passed）

- [ ] **Step 6: 提交**

```bash
git add gdbgui/server/migrations/0003_tags.sql gdbgui/server/tags.py tests/test_tags.py
git commit -m "feat(tags): 標籤資料表與正規化"
```

---

### Task 2: 標籤與教案的關聯讀寫

**Files:**
- Modify: `gdbgui/server/tags.py`（接在 Task 1 之後）
- Test: `tests/test_tags.py`（接續同一檔案）

**Interfaces:**
- Consumes: Task 1 的 `parse_tag_input`、`TagRejected`
- Produces: `tags.set_lesson_tags(lesson_id: int, user_id: int, raw: str) -> Optional[List[str]]`（非作者回 `None`）、`tags.tags_for_lessons(lesson_ids: Iterable[int]) -> Dict[int, List[str]]`

**另外要修 Task 1 留下的一個缺陷**（審查發現，使用者裁決在此處一併處理）：

`parse_tag_input` 用 `piece.strip()` 判斷空片段，但 `str.strip()` 不吃 U+200B（零寬空格）
與 U+FEFF（BOM），那些字元要到 `normalize_tag` 裡才被移除——結果變成空字串，於是
**整串輸入被拒**。實測 `parse_tag_input("a,,b")` 回 `["a","b"]`，但
`parse_tag_input("a,​,b")` 拋 `TagRejected`。從網頁複製貼上很容易夾帶這些字元，
而「只有看不見的字元」的片段比空片段更像手滑。

改法：讓 `normalize_tag` 對「正規化後什麼都不剩」拋一個可辨識的子類，
`parse_tag_input` 只吞這一種。**不要用比對錯誤訊息字串的方式分辨**——訊息改個字就壞。

- [ ] **Step 1: 寫失敗的測試**

追加到 `tests/test_tags.py`：

```python
from gdbgui.server import db
from .conftest import register_user


def _lesson(user_id: int, title: str = "測試教案") -> int:
    return db.create_lesson(user_id, title, '{"version":"2.0","source_code":"int main(){}"}')


def test_setting_tags_stores_them_normalized(flask_app):
    uid = register_user(flask_app, display_name="tag_a").user_id
    lid = _lesson(uid)
    assert tags.set_lesson_tags(lid, uid, "BST, STL") == ["bst", "stl"]
    assert tags.tags_for_lessons([lid]) == {lid: ["bst", "stl"]}


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
    所以不進配額——否則貼幾個標籤就可能讓一個原本存得下的教案存不下。"""
    monkeypatch.setattr(db, "MAX_USER_BYTES", 3000)
    uid = register_user(flask_app, display_name="tag_quota").user_id
    lid = _lesson(uid)
    tags.set_lesson_tags(lid, uid, "一, 二, 三, 四, 五, 六, 七, 八")

    # 貼滿標籤之後，這個人的可用空間應該跟貼之前一樣
    with closing(db.connect()) as conn:
        used = int(conn.execute(
            "SELECT COALESCE(SUM(LENGTH(CAST(bundle_json AS BLOB))), 0) "
            "FROM lessons WHERE user_id = ?", (uid,)
        ).fetchone()[0])
    assert used < 3000
    assert db.create_lesson(uid, "還存得下", '{"version":"2.0","source_code":"x"}')


def test_too_many_tags_is_refused_at_the_write_boundary(flask_app):
    uid = register_user(flask_app, display_name="tag_h").user_id
    lid = _lesson(uid)
    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON + 1))
    with pytest.raises(tags.TagRejected):
        tags.set_lesson_tags(lid, uid, raw)
    assert tags.tags_for_lessons([lid]) == {lid: []}


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
```

檔案最上面補上 `from contextlib import closing`。

- [ ] **Step 2: 確認測試失敗**

Run: `python -m pytest tests/test_tags.py -q`
Expected: FAIL — `AttributeError: module 'gdbgui.server.tags' has no attribute 'set_lesson_tags'`

- [ ] **Step 3a: 修掉零寬字元那個缺陷**

在 `gdbgui/server/tags.py` 的 `TagRejected` 底下加一個子類：

```python
class EmptyTag(TagRejected):
    """正規化之後什麼都不剩。

    獨立成一個子類，是為了讓 parse_tag_input 能只寬容「空片段」這一種情況，
    而不必去比對錯誤訊息字串——訊息改個字那種寫法就壞了。
    它繼承 TagRejected，所以既有的 `except TagRejected` 呼叫端不受影響。
    """
```

`normalize_tag` 裡「空」那一條改成拋 `EmptyTag`（訊息不變）：

```python
    if not text:
        raise EmptyTag("標籤不可以是空的。")
```

`parse_tag_input` 裡原本那個 for 迴圈整段換掉，改成先正規化、只吞 `EmptyTag`：

```python
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
```

- [ ] **Step 3b: 實作關聯讀寫**

追加到 `gdbgui/server/tags.py`：

```python
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
```

- [ ] **Step 4: 確認測試通過**

Run: `python -m pytest tests/test_tags.py -q`
Expected: PASS（28 passed）

- [ ] **Step 5: 提交**

```bash
git add gdbgui/server/tags.py tests/test_tags.py
git commit -m "feat(tags): 標籤關聯讀寫，並修掉零寬字元讓整串被拒的缺陷"
```

---

### Task 3: 搜尋與標籤計數

**Files:**
- Modify: `gdbgui/server/db.py`（接在 `recent_lessons` 之後，`lesson_count` 之前）
- Test: `tests/test_lesson_search.py`

**Interfaces:**
- Consumes: `db.connect()`、`db.LESSONS_PER_PAGE`
- Produces: `db.search_lessons(q="", tags=(), limit=..., offset=0) -> List[sqlite3.Row]`、`db.search_count(q="", tags=()) -> int`、`db.tag_counts(q="", tags=(), limit=None) -> List[sqlite3.Row]`（每列 `name`、`n`）、`db.MAX_QUERY_LENGTH = 100`、`db.MAX_FILTER_TAGS = 8`、`db.FACET_LIMIT = 12`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_lesson_search.py`：

```python
"""教案搜尋：文字比對標題／作者／標籤，加上可複選的標籤篩選，全部 AND。

最重要的一條是跳脫：`%` 與 `_` 是 LIKE 的萬用字元，不跳脫的話使用者打一個
`%` 就是無條件全表掃描——一個輸入框就能點的 DoS。
"""

import pytest

from gdbgui.server import db, tags
from .conftest import register_user


@pytest.fixture()
def corpus(flask_app):
    """三個作者、五篇教案，標籤刻意重疊，讓 AND 與 OR 會給出不同答案。"""
    wang = register_user(flask_app, display_name="王老師").user_id
    lin = register_user(flask_app, display_name="林助教").user_id

    def mk(uid, title, tag_str):
        lid = db.create_lesson(uid, title, '{"version":"2.0","source_code":"int main(){}"}')
        tags.set_lesson_tags(lid, uid, tag_str)
        return lid

    return {
        "wang": wang,
        "lin": lin,
        "bst": mk(wang, "二元搜尋樹 lower_bound", "bst, stl"),
        "vec": mk(wang, "vector 擴容", "stl, 記憶體"),
        "rec": mk(lin, "遞迴呼叫樹", "遞迴, 樹"),
        "dp":  mk(lin, "背包問題", "dp"),
        "bare": mk(lin, "沒有標籤的一篇", ""),
    }


def _titles(rows):
    return [r["title"] for r in rows]


def _ids(rows):
    return {int(r["id"]) for r in rows}


# ── 文字搜尋 ───────────────────────────────────────────────────────────────


def test_matches_the_title(corpus):
    assert corpus["bst"] in _ids(db.search_lessons(q="lower_bound"))


def test_matches_the_author_display_name(corpus):
    found = _ids(db.search_lessons(q="王老師"))
    assert corpus["bst"] in found and corpus["vec"] in found
    assert corpus["rec"] not in found


def test_matches_a_tag_name(corpus):
    found = _ids(db.search_lessons(q="記憶體"))
    assert found == {corpus["vec"]}


def test_an_empty_query_returns_everything(corpus):
    assert len(db.search_lessons(q="", limit=50)) >= 5


# ── 跳脫（這一節是這個檔案存在的主要理由）─────────────────────────────────


def test_a_percent_sign_is_a_literal_not_a_wildcard(corpus):
    """打 % 要找的是標題裡有 % 的教案，不是「全部」。"""
    assert db.search_lessons(q="%") == []


def test_an_underscore_is_a_literal_not_a_single_char_wildcard(corpus):
    """_ 在 LIKE 裡是「任一個字元」。不跳脫的話 "____" 會match四字標題。"""
    assert db.search_lessons(q="____") == []


def test_a_backslash_does_not_break_the_query(corpus):
    assert db.search_lessons(q="\\") == []


def test_a_literal_percent_in_a_title_is_findable(flask_app):
    uid = register_user(flask_app, display_name="pct").user_id
    lid = db.create_lesson(uid, "折扣 50% 的算法", '{"version":"2.0","source_code":"x"}')
    assert lid in _ids(db.search_lessons(q="50%"))


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
    assert _ids(db.search_lessons(tags=["stl"])) == {corpus["bst"], corpus["vec"]}


def test_multiple_tags_are_and_not_or(corpus):
    """這條分辨 AND 與 OR：OR 會給兩篇，AND 只給一篇。"""
    assert _ids(db.search_lessons(tags=["stl", "記憶體"])) == {corpus["vec"]}


def test_text_and_tags_are_also_and(corpus):
    assert _ids(db.search_lessons(q="王老師", tags=["stl"])) == {corpus["bst"], corpus["vec"]}
    assert db.search_lessons(q="林助教", tags=["stl"]) == []


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
    assert db.search_count(q="王老師") == len(db.search_lessons(q="王老師", limit=100))


def test_pagination_does_not_repeat_or_drop(corpus):
    page1 = db.search_lessons(limit=2, offset=0)
    page2 = db.search_lessons(limit=2, offset=2)
    assert len(page1) == 2 and len(page2) == 2
    assert _ids(page1).isdisjoint(_ids(page2))


def test_ordering_is_newest_first(corpus):
    rows = db.search_lessons(limit=50)
    keys = [(r["updated_at"], int(r["id"])) for r in rows]
    assert keys == sorted(keys, reverse=True)


# ── 標籤列 ─────────────────────────────────────────────────────────────────


def test_tag_counts_are_scoped_to_the_result_set(corpus):
    """全站 stl 有兩篇，但在 q=王老師 的結果裡也是兩篇；記憶體是一篇。"""
    counts = {r["name"]: r["n"] for r in db.tag_counts(q="王老師")}
    assert counts["stl"] == 2
    assert counts["記憶體"] == 1
    assert "遞迴" not in counts  # 林助教的標籤不該出現在王老師的結果裡


def test_tag_counts_exclude_tags_that_would_empty_the_result(corpus):
    """已經選了 stl 時，列上不該出現任何選了就變空的標籤。"""
    names = {r["name"] for r in db.tag_counts(tags=["stl"])}
    assert "dp" not in names
    for name in names:
        assert db.search_lessons(tags=["stl", name]), f"選 {name} 會變成空清單"


def test_tag_counts_are_ordered_by_use_then_name(corpus):
    rows = db.tag_counts()
    pairs = [(-int(r["n"]), r["name"]) for r in rows]
    assert pairs == sorted(pairs)
```

- [ ] **Step 2: 確認測試失敗**

Run: `python -m pytest tests/test_lesson_search.py -q`
Expected: FAIL — `AttributeError: module 'gdbgui.server.db' has no attribute 'search_lessons'`

- [ ] **Step 3: 實作查詢**

在 `gdbgui/server/db.py` 的 `recent_lessons` 之後插入：

```python
#: 搜尋字串的字元上限。超過就截斷——網址是可以被亂改的，把它當輸入不是契約。
MAX_QUERY_LENGTH = 100
#: 一次可以篩選幾個標籤。tag 是可重複的 query 參數，不設限就是一個用網址
#: 就能點的 DoS（跟 ?page=99999999 是同一類問題）。
MAX_FILTER_TAGS = 8
#: 標籤列預設顯示幾個。
FACET_LIMIT = 12

#: LIKE 的萬用字元。不跳脫的話使用者打一個 % 就是無條件全表掃描。
_LIKE_ESCAPE = str.maketrans({"\\": r"\\", "%": r"\%", "_": r"\_"})


def _like_pattern(q: str) -> str:
    return "%" + q.translate(_LIKE_ESCAPE) + "%"


def _clean_query(q) -> str:
    return (q or "").strip()[:MAX_QUERY_LENGTH] if isinstance(q, str) else ""


def _clean_tags(tags) -> List[str]:
    if not tags:
        return []
    # dict.fromkeys 去重且保持順序；順序不影響結果，但影響 SQL 快取命中。
    return [t for t in dict.fromkeys(tags) if isinstance(t, str) and t][:MAX_FILTER_TAGS]


def _search_predicate(q: str, tags: List[str]):
    """回傳 (WHERE 片段, 參數list)。搜尋、計數、標籤列三處共用同一個條件。

    共用是刻意的：三者若各寫一份，標籤列的計數遲早會跟清單對不起來。
    """
    clauses = ["1=1"]
    params: List = []

    if q:
        pattern = _like_pattern(q)
        clauses.append(
            "(l.title LIKE ? ESCAPE '\\'"
            " OR u.display_name LIKE ? ESCAPE '\\'"
            " OR u.username LIKE ? ESCAPE '\\'"
            " OR EXISTS (SELECT 1 FROM lesson_tags lt JOIN tags t ON t.id = lt.tag_id"
            "             WHERE lt.lesson_id = l.id AND t.name LIKE ? ESCAPE '\\'))"
        )
        params += [pattern] * 4

    if tags:
        placeholders = ",".join("?" * len(tags))
        # HAVING COUNT(DISTINCT t.id) = ? 就是「這些標籤全都有」（AND）。
        clauses.append(
            f"l.id IN (SELECT lt.lesson_id FROM lesson_tags lt"
            f"          JOIN tags t ON t.id = lt.tag_id"
            f"         WHERE t.name IN ({placeholders})"
            f"         GROUP BY lt.lesson_id"
            f"        HAVING COUNT(DISTINCT t.id) = ?)"
        )
        params += list(tags) + [len(tags)]

    return " AND ".join(clauses), params


def search_lessons(q="", tags=(), limit=None, offset=0) -> List[sqlite3.Row]:
    """一頁搜尋結果。q 與每個標籤之間都是 AND。

    用 EXISTS 而不是 LEFT JOIN tags + DISTINCT：後者會讓一篇教案有幾個標籤就
    產生幾列，再靠 DISTINCT 收掉，而那跟 ORDER BY + LIMIT/OFFSET 分頁一起用
    很脆。EXISTS 從一開始就不產生重複列。
    """
    q = _clean_query(q)
    tags = _clean_tags(tags)
    limit = LESSONS_PER_PAGE if limit is None else max(0, int(limit))
    offset = max(0, int(offset))

    where, params = _search_predicate(q, tags)
    with closing(connect()) as conn:
        return list(
            conn.execute(
                "SELECT l.id, l.user_id, l.title, l.created_at, l.updated_at, "
                "       u.username, u.display_name "
                "FROM lessons l JOIN users u ON u.id = l.user_id "
                f"WHERE {where} "
                "ORDER BY l.updated_at DESC, l.id DESC "
                "LIMIT ? OFFSET ?",
                params + [limit, offset],
            )
        )


def search_count(q="", tags=()) -> int:
    where, params = _search_predicate(_clean_query(q), _clean_tags(tags))
    with closing(connect()) as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM lessons l JOIN users u ON u.id = l.user_id "
                f"WHERE {where}",
                params,
            ).fetchone()[0]
        )


def tag_counts(q="", tags=(), limit=None) -> List[sqlite3.Row]:
    """目前結果集裡出現的標籤與它們在結果集內的出現次數。

    刻意不是全站計數：只列出結果集裡真的存在的標籤，使用者就點不出空清單——
    會讓結果變空的標籤根本不會出現在列上。
    """
    where, params = _search_predicate(_clean_query(q), _clean_tags(tags))
    sql = (
        "SELECT t.name AS name, COUNT(*) AS n "
        "FROM lesson_tags lt JOIN tags t ON t.id = lt.tag_id "
        "WHERE lt.lesson_id IN ("
        "  SELECT l.id FROM lessons l JOIN users u ON u.id = l.user_id "
        f" WHERE {where}) "
        "GROUP BY t.id ORDER BY n DESC, t.name ASC"
    )
    if limit is not None:
        sql += " LIMIT ?"
        params = params + [max(0, int(limit))]
    with closing(connect()) as conn:
        return list(conn.execute(sql, params))
```

- [ ] **Step 4: 確認測試通過**

Run: `python -m pytest tests/test_lesson_search.py -q`
Expected: PASS（21 passed）

- [ ] **Step 5: 跑整組 Python 測試確認沒弄壞既有的**

Run: `python -m pytest tests/ -q`
Expected: 既有測試全過（`test_lesson_quotas.py`、`test_lesson_sharing.py` 等）

- [ ] **Step 6: 提交**

```bash
git add gdbgui/server/db.py tests/test_lesson_search.py
git commit -m "feat(search): 教案搜尋與標籤計數，LIKE 萬用字元一律跳脫"
```

---

### Task 4: 標籤 API

**Files:**
- Modify: `gdbgui/server/http_routes.py`（接在 `get_lesson` 之後、`lesson_library` 之前）
- Test: `tests/test_tags_api.py`

**Interfaces:**
- Consumes: Task 2 的 `tags.set_lesson_tags`、`tags.TagRejected`；既有的 `_lesson_author()`、`_lesson_not_found()`、`@authenticate`
- Produces: `POST /api/lessons/<int:lesson_id>/tags`，body `{"tags": "BST, STL"}`，回 `{"tags": ["bst", "stl"]}`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_tags_api.py`：

```python
"""標籤 API 的授權與驗證。

一句話說完這個端點的規則：只有作者能改，別人一律 404。
"""

import json

from gdbgui.server import db, tags
from .conftest import register_user


def _post_tags(user, lesson_id, raw):
    # LoggedInUser 的 test client 是 .http，csrf token 是 .csrf（見 conftest）。
    return user.http.post(
        f"/api/lessons/{lesson_id}/tags",
        data=json.dumps({"tags": raw}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )


def _lesson(user_id):
    return db.create_lesson(user_id, "題目", '{"version":"2.0","source_code":"int main(){}"}')


def test_the_author_can_set_tags(flask_app):
    author = register_user(flask_app, display_name="api_a")
    lid = _lesson(author.user_id)
    response = _post_tags(author, lid, "BST, STL")
    assert response.status_code == 200
    assert response.get_json()["tags"] == ["bst", "stl"]


def test_a_non_author_gets_404_and_changes_nothing(flask_app):
    """404 而不是 403：403 等於確認「這篇存在但不是你的」。"""
    author = register_user(flask_app, display_name="api_b1")
    other = register_user(flask_app, display_name="api_b2")
    lid = _lesson(author.user_id)
    tags.set_lesson_tags(lid, author.user_id, "原本的")

    assert _post_tags(other, lid, "被改掉").status_code == 404
    assert tags.tags_for_lessons([lid]) == {lid: ["原本的"]}


def test_a_missing_lesson_gets_404(flask_app):
    user = register_user(flask_app, display_name="api_c")
    assert _post_tags(user, 999_999_999, "x").status_code == 404


def test_too_many_tags_gets_400_with_a_message(flask_app):
    user = register_user(flask_app, display_name="api_d")
    lid = _lesson(user.user_id)
    raw = ",".join(f"t{i}" for i in range(tags.MAX_TAGS_PER_LESSON + 1))
    response = _post_tags(user, lid, raw)
    assert response.status_code == 400
    assert "8" in response.get_json()["message"]


def test_an_over_long_tag_gets_400(flask_app):
    user = register_user(flask_app, display_name="api_e")
    lid = _lesson(user.user_id)
    assert _post_tags(user, lid, "x" * (tags.MAX_TAG_LENGTH + 1)).status_code == 400


def test_clearing_tags_with_an_empty_string_works(flask_app):
    user = register_user(flask_app, display_name="api_f")
    lid = _lesson(user.user_id)
    _post_tags(user, lid, "a, b")
    response = _post_tags(user, lid, "")
    assert response.status_code == 200
    assert response.get_json()["tags"] == []


def test_a_request_without_the_csrf_header_is_refused(flask_app):
    """全域 before_request 擋所有 POST；漏帶 header 會 400/415 而不是靜默成功。"""
    user = register_user(flask_app, display_name="api_g")
    lid = _lesson(user.user_id)
    response = user.http.post(
        f"/api/lessons/{lid}/tags",
        data=json.dumps({"tags": "x"}),
        content_type="application/json",
    )
    assert response.status_code >= 400
    assert tags.tags_for_lessons([lid]) == {lid: []}
```

- [ ] **Step 2: 確認測試失敗**

Run: `python -m pytest tests/test_tags_api.py -q`
Expected: FAIL — 404（路由還不存在），`test_the_author_can_set_tags` 失敗

- [ ] **Step 3: 實作路由**

在 `gdbgui/server/http_routes.py` 檔頭 import 區加入 `from . import tags as tags_module`，並在 `get_lesson` 之後插入：

```python
@blueprint.route("/api/lessons/<int:lesson_id>/tags", methods=["POST"])
@authenticate
def update_lesson_tags(lesson_id: int):
    """整批設定一篇教案的標籤。只有作者可以。

    刻意不叫 set_lesson_tags——那是 tags.py 裡做實事的那個函式的名字，
    兩個同名會讓「哪一個擋權限」變成要看 import 才知道的事。

    刻意**不**沿用 PUT /api/lessons/<id> 的 fork 行為（那條在教案不是你的
    時候會另存一份副本）。改內容是創作，另存合理；改標籤不是。靜默 fork 會
    讓使用者以為自己整理了教案庫，其實只是替自己複製了一堆。
    """
    user_id = _lesson_author()
    payload = request.get_json(silent=True) or {}
    raw = payload.get("tags", "")

    try:
        result = tags_module.set_lesson_tags(lesson_id, user_id, raw)
    except tags_module.TagRejected as exc:
        return jsonify({"message": str(exc)}), 400

    if result is None:
        logger.info("[authz] refused tag write on lesson %s", lesson_id)
        return _lesson_not_found()
    return jsonify({"tags": result})
```

- [ ] **Step 4: 確認測試通過**

Run: `python -m pytest tests/test_tags_api.py -q`
Expected: PASS（7 passed）

- [ ] **Step 5: 提交**

```bash
git add gdbgui/server/http_routes.py tests/test_tags_api.py
git commit -m "feat(tags): POST /api/lessons/<id>/tags，非作者一律 404"
```

---

### Task 5: 路由換位與轉址

**Files:**
- Modify: `gdbgui/server/http_routes.py:949`（`gdbgui` 的 route 裝飾器）、`:1709`（`lesson_library`）
- Test: `tests/test_routes_swap.py`

**Interfaces:**
- Consumes: Task 3 的 `db.search_lessons` / `db.search_count` / `db.tag_counts`
- Produces: `/` = 瀏覽頁（endpoint 名仍是 `http_routes.lesson_library`）、`/edit` = 除錯器（endpoint 名仍是 `http_routes.gdbgui`）

**端點名稱刻意不改**：模板裡既有的 `url_for('http_routes.gdbgui')` 會自動變成 `/edit`，`url_for('http_routes.lesson_library')` 自動變成 `/`，不必逐一改呼叫端。

- [ ] **Step 1: 寫失敗的測試**

`tests/test_routes_swap.py`：

```python
"""主頁換成瀏覽頁、除錯器搬到 /edit，以及兩條保住舊書籤的轉址。"""

from .conftest import register_user


def test_the_root_is_no_longer_the_debugger(flask_app):
    """這個任務只換路由，模板是 Task 6 的事。所以這裡驗的是「根路徑不再是
    除錯器」——用 initial_data 判斷，那是除錯器頁面才有的東西，不依賴任何
    還沒建立的 data-testid。"""
    user = register_user(flask_app, display_name="rt_a")
    response = user.http.get("/")
    assert response.status_code == 200
    assert b"initial_data" not in response.data


def test_edit_serves_the_debugger(flask_app):
    user = register_user(flask_app, display_name="rt_b")
    response = user.http.get("/edit")
    assert response.status_code == 200
    assert b"initial_data" in response.data


def test_the_old_lessons_url_redirects_to_the_root(flask_app):
    user = register_user(flask_app, display_name="rt_c")
    response = user.http.get("/lessons")
    assert response.status_code == 302
    assert response.headers["Location"].endswith("/")


def test_the_old_lesson_deeplink_redirects_to_edit(flask_app):
    """/?lesson=42 是既有的教案連結，必須繼續有用。"""
    user = register_user(flask_app, display_name="rt_d")
    response = user.http.get("/?lesson=42")
    assert response.status_code == 302
    assert "/edit?lesson=42" in response.headers["Location"]


def test_the_root_still_requires_login(flask_app):
    """首頁換成瀏覽頁不代表它變公開。"""
    anon = flask_app.test_client()
    response = anon.get("/")
    assert response.status_code == 302
    assert "/login" in response.headers["Location"]


def test_edit_also_requires_login(flask_app):
    anon = flask_app.test_client()
    assert anon.get("/edit").status_code == 302


def test_an_out_of_range_page_is_clamped_not_an_error(flask_app):
    user = register_user(flask_app, display_name="rt_f")
    assert user.http.get("/?page=99999999999").status_code == 200
```

- [ ] **Step 2: 確認測試失敗**

Run: `python -m pytest tests/test_routes_swap.py -q`
Expected: FAIL — `/edit` 是 404，`/` 回的是除錯器

- [ ] **Step 3: 改路由**

`http_routes.py:949`，把 `gdbgui` 的裝飾器改成：

```python
# 除錯器。以前掛在 "/"；主頁讓給教案瀏覽之後搬到這裡。
# endpoint 名稱刻意維持 "gdbgui"——模板裡既有的 url_for('http_routes.gdbgui')
# 因此自動指向 /edit，不必逐一改呼叫端。
@blueprint.route("/edit", methods=["GET"])
@authenticate
def gdbgui():
```

`http_routes.py:1709`，把 `lesson_library` 整段換成：

```python
@blueprint.route("/", methods=["GET"])
@authenticate
def lesson_library():
    """主頁：可搜尋、可依標籤篩選的教案清單。

    標題與作者顯示名稱是使用者輸入，全部靠 Jinja 的 autoescape 轉義
    （模板裡沒有任何 |safe，也沒有任何使用者字串被插進 <script>）。
    """
    # /?lesson=42 是除錯器的舊深連結（教案庫頁與外部書籤都在用）。
    # 主頁換了用途，但那些連結必須繼續有用。
    requested_lesson = request.args.get("lesson")
    if requested_lesson is not None:
        return redirect(url_for("http_routes.gdbgui", lesson=requested_lesson))

    add_csrf_token_to_session()

    q = request.args.get("q", "")
    # tag 是可重複參數：/?tag=stl&tag=bst。上限在 db 層截斷。
    selected_tags = request.args.getlist("tag")
    show_all_tags = request.args.get("alltags") == "1"

    per_page = db.LESSONS_PER_PAGE
    total = db.search_count(q=q, tags=selected_tags)
    last_page = max(1, -(-total // per_page))

    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    # 夾到 [1, last_page]：否則 ?page=99999999999 會變成一個
    # OFFSET 999999999990 的全表掃描，一個 GET 就能點的 DoS。
    page = min(max(1, page), last_page)

    lessons = db.search_lessons(q=q, tags=selected_tags,
                                limit=per_page, offset=(page - 1) * per_page)
    facets = db.tag_counts(q=q, tags=selected_tags,
                           limit=None if show_all_tags else db.FACET_LIMIT)
    facet_total = len(db.tag_counts(q=q, tags=selected_tags))

    return render_template(
        "lessons.html",
        lessons=lessons,
        lesson_tags=tags_module.tags_for_lessons([row["id"] for row in lessons]),
        facets=facets,
        facet_total=facet_total,
        show_all_tags=show_all_tags,
        q=q,
        selected_tags=[t for t in selected_tags if t],
        page=page,
        last_page=last_page,
        total=total,
        per_page=per_page,
        current_user_id=current_user_id(),
        csrf_token=session["csrf_token"],
    )


@blueprint.route("/lessons", methods=["GET"])
@authenticate
def lesson_library_legacy():
    """教案庫的舊網址。內容搬到主頁了，但書籤要繼續有用。"""
    return redirect(url_for("http_routes.lesson_library", **request.args.to_dict(flat=True)))
```

`redirect` 與 `url_for` 在 `http_routes.py:23-35` 的 `from flask import (...)` 裡已經有了，不必加。

- [ ] **Step 4: 確認測試全數通過**

Run: `python -m pytest tests/test_routes_swap.py -q`
Expected: PASS（6 passed）。這個任務收尾時整檔全綠——瀏覽頁 UI 的驗證屬於
Task 6，不放在這裡，所以不該有任何「預期失敗」的測試。

- [ ] **Step 5: 提交**

```bash
git add gdbgui/server/http_routes.py tests/test_routes_swap.py
git commit -m "feat(routes): 主頁換成教案瀏覽，除錯器搬到 /edit"
```

---

### Task 6: 瀏覽頁模板

**Files:**
- Modify: `gdbgui/templates/lessons.html`（整頁改寫）
- Modify: `gdbgui/templates/_auth_base.html`（加標籤與搜尋框的樣式）
- Test: `tests/test_routes_swap.py`（Task 5 剩下的兩條）

**Interfaces:**
- Consumes: Task 5 傳進模板的 `lessons`、`lesson_tags`、`facets`、`facet_total`、`show_all_tags`、`q`、`selected_tags`、`page`、`last_page`、`total`、`per_page`、`current_user_id`、`csrf_token`
- Produces: `data-testid`：`lesson-browse-list`、`lesson-browse-empty`、`lesson-browse-search`、`lesson-browse-facet`、`lesson-browse-title`、`lesson-browse-tag`、`lesson-browse-total`

- [ ] **Step 1: 加樣式**

在 `_auth_base.html` 的 `<style>` 裡，`.pager` 規則之前插入：

```css
      /* ── 搜尋框 ───────────────────────────────────────────── */
      .search-form { margin: 0 0 0.9rem; }
      .search-row { display: flex; gap: 0.5rem; }
      .search-row input[type="search"] {
        flex: 1 1 auto;
        min-width: 0;
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--struct-border);
        border-radius: 8px;
        font-size: 1rem;
        font-family: inherit;
        color: var(--ink);
        background: var(--surface);
      }
      .search-row input[type="search"]:focus-visible {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .search-row button { margin-top: 0; width: auto; flex: none; padding: 0.55rem 1rem; }

      /* ── 標籤 ─────────────────────────────────────────────
         標籤列只列出目前結果集裡存在的標籤，所以點不出空清單。 */
      .facets {
        display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
        margin: 0 0 0.4rem;
      }
      .facets .facet-label {
        font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.08em; color: var(--ink-faint); flex: none;
      }
      .tag {
        display: inline-flex; align-items: center; gap: 0.3rem;
        font-size: 0.72rem; line-height: 1.5;
        padding: 0.05rem 0.45rem;
        border: 1px solid var(--struct-border);
        border-radius: 999px;
        color: var(--ink-soft);
        background: var(--surface);
        text-decoration: none;
        white-space: nowrap;
      }
      .tag:hover { border-color: var(--accent); color: var(--accent); }
      .tag.on {
        border-color: var(--accent); background: var(--accent-soft);
        color: var(--accent); font-weight: 600;
      }
      .tag .n {
        font-family: var(--font-mono); font-variant-numeric: tabular-nums;
        font-size: 0.68rem; color: var(--ink-faint);
      }
      .tag.on .n { color: var(--accent); }
```

- [ ] **Step 2: 改寫 `lessons.html`**

```jinja
{% extends "_auth_base.html" %}
{% block title %}教案庫 - gdbgui{% endblock %}
{% block body %}
  {# Jinja 的 autoescape 是開著的。title、display_name、標籤名都是使用者輸入，
     一律靠它轉義；這一頁沒有任何 |safe，也沒有任何使用者字串被插進 <script>
     或 HTML 屬性裡——底下那段 JS 只讀 data-lesson-id（整數）。 #}
  <style>.card { --card-width: 42rem; }</style>

  {# 目前的篩選條件，用來組「加上／拿掉一個標籤」的連結。 #}
  {% macro tag_url(name, on) -%}
    {%- set others = selected_tags | reject('equalto', name) | list -%}
    {%- set final = others if on else (others + [name]) -%}
    {{ url_for('http_routes.lesson_library', q=q or None, tag=final or None) }}
  {%- endmacro %}

  <h1>教案庫</h1>
  <p class="lede">
    {% if q or selected_tags %}
      <span class="count" data-testid="lesson-browse-total">{{ total }}</span> 篇符合條件
    {% else %}
      共 <span class="count" data-testid="lesson-browse-total">{{ total }}</span> 篇教案，最近更新的在前。
    {% endif %}
  </p>

  <form class="search-form" method="get" action="{{ url_for('http_routes.lesson_library') }}">
    {# 已選的標籤跟著送出去，否則打字會把標籤篩選清掉。 #}
    {% for name in selected_tags %}
      <input type="hidden" name="tag" value="{{ name }}" />
    {% endfor %}
    <div class="search-row">
      <input type="search" name="q" value="{{ q }}"
             placeholder="搜尋標題、作者或標籤…"
             aria-label="搜尋教案"
             data-testid="lesson-browse-search" />
      <button type="submit">搜尋</button>
    </div>
  </form>

  {% if facets or selected_tags %}
    <p class="facets">
      <span class="facet-label">標籤</span>
      {% for facet in facets %}
        {% set on = facet['name'] in selected_tags %}
        <a class="tag {% if on %}on{% endif %}"
           href="{{ tag_url(facet['name'], on) }}"
           data-testid="lesson-browse-facet">{{ facet["name"] }} <span class="n">{{ facet["n"] }}</span></a>
      {% endfor %}
      {% if not show_all_tags and facet_total > facets | length %}
        <a class="tag" href="{{ url_for('http_routes.lesson_library', q=q or None, tag=selected_tags or None, alltags='1') }}">全部 {{ facet_total }} 個 →</a>
      {% endif %}
    </p>
  {% endif %}

  {% if lessons %}
    <ul class="listing" data-testid="lesson-browse-list">
      {% for lesson in lessons %}
        {% set mine = current_user_id is not none and lesson["user_id"] == current_user_id %}
        <li class="row" data-testid="lesson-browse-item">
          {# 行號槽。琥珀色中斷點圓點＝這一篇是你的：沿用 app 的規則
             「顏色代表狀態，不代表類別」。 #}
          <span class="gutter" aria-hidden="true">
            {% if mine %}<span class="bp"></span>{% endif %}{{ loop.index0 + (page - 1) * per_page + 1 }}
          </span>
          <span class="row-main">
            <a class="row-title"
               href="{{ url_for('http_routes.gdbgui', lesson=lesson['id']) }}"
               data-testid="lesson-browse-title">{{ lesson["title"] }}</a>
            <span class="row-meta">
              <a href="{{ url_for('auth.profile', username=lesson['username']) }}"
                 data-testid="lesson-browse-author">{{ lesson["display_name"] }}</a>
              <time datetime="{{ lesson['updated_at'] }}">{{ lesson["updated_at"] }}</time>
              {% for name in lesson_tags.get(lesson["id"], []) %}
                <a class="tag {% if name in selected_tags %}on{% endif %}"
                   href="{{ tag_url(name, name in selected_tags) }}"
                   data-testid="lesson-browse-tag">{{ name }}</a>
              {% endfor %}
              {% if mine %}
                <button type="button" class="lesson-delete"
                        data-lesson-id="{{ lesson['id'] }}"
                        data-testid="lesson-delete">刪除</button>
              {% endif %}
            </span>
          </span>
        </li>
      {% endfor %}
    </ul>
  {% else %}
    <p class="empty" data-testid="lesson-browse-empty">
      {% if q or selected_tags %}
        沒有符合的教案。<a href="{{ url_for('http_routes.lesson_library') }}">清除條件</a>看全部。
      {% else %}
        還沒有任何教案。<a href="{{ url_for('http_routes.gdbgui') }}">開啟除錯器</a>寫第一篇。
      {% endif %}
    </p>
  {% endif %}

  <p class="pager">
    <span>
      {% if page > 1 %}
        <a href="{{ url_for('http_routes.lesson_library', q=q or None, tag=selected_tags or None, page=page - 1) }}"
           data-testid="lesson-browse-prev">← 上一頁</a>
      {% endif %}
    </span>
    <span data-testid="lesson-browse-page">第 {{ page }} / {{ last_page }} 頁</span>
    <span>
      {% if page < last_page %}
        <a href="{{ url_for('http_routes.lesson_library', q=q or None, tag=selected_tags or None, page=page + 1) }}"
           data-testid="lesson-browse-next">下一頁 →</a>
      {% endif %}
    </span>
  </p>

  <p class="nav">
    <a href="{{ url_for('http_routes.gdbgui') }}">開啟除錯器</a>
    <a href="{{ url_for('auth.logout') }}">登出</a>
  </p>

  {# csrf_token 是伺服器產生的 hex，經由 data- 屬性交給下面的腳本讀取。
     刻意不把它（或任何值）插進 JS 原始碼字串裡。 #}
  <script data-csrf="{{ csrf_token }}">
    (function () {
      var token = document.currentScript.getAttribute("data-csrf");
      document.querySelectorAll(".lesson-delete").forEach(function (button) {
        button.addEventListener("click", function () {
          var id = button.getAttribute("data-lesson-id");
          if (!window.confirm("刪除這篇教案？此操作無法復原。")) return;
          fetch("/api/lessons/" + encodeURIComponent(id), {
            method: "DELETE",
            headers: { "x-csrftoken": token },
            credentials: "same-origin"
          }).then(function (response) {
            if (response.ok) { window.location.reload(); }
            else { window.alert("刪除失敗。"); }
          });
        });
      });
    })();
  </script>
{% endblock %}
```

- [ ] **Step 3: 追加瀏覽頁 UI 的測試**

這兩條驗的是這個任務才建立的模板，所以放在這裡而不是 Task 5。
追加到 `tests/test_routes_swap.py`：

```python
def test_the_root_renders_the_browse_ui(flask_app):
    user = register_user(flask_app, display_name="rt_ui")
    response = user.http.get("/")
    assert response.status_code == 200
    assert b"lesson-browse-search" in response.data
    assert b"lesson-browse-list" in response.data or b"lesson-browse-empty" in response.data


def test_the_search_box_and_tag_filter_narrow_the_listing(flask_app):
    from gdbgui.server import tags

    user = register_user(flask_app, display_name="rt_e")
    lid = db.create_lesson(user.user_id, "獨一無二的標題ZZQ",
                           '{"version":"2.0","source_code":"int main(){}"}')
    tags.set_lesson_tags(lid, user.user_id, "獨特標籤ZZQ")

    assert b"ZZQ" in user.http.get("/?q=ZZQ").data
    assert b"ZZQ" in user.http.get("/?tag=%E7%8D%A8%E7%89%B9%E6%A8%99%E7%B1%A4ZZQ").data
    assert b"ZZQ" not in user.http.get("/?q=絕對不存在的字串QQQ").data
```

檔案最上面補 `from gdbgui.server import db`（Task 5 建立時沒有用到它）。

- [ ] **Step 4: 確認整組路由測試通過**

Run: `python -m pytest tests/test_routes_swap.py -q`
Expected: PASS（8 passed）

- [ ] **Step 5: 手動看一眼**

```bash
docker compose up -d --build
```
開 http://localhost:5000/ ——應該是教案清單、有搜尋框；點一個標籤，網址出現 `?tag=`，清單縮小，該標籤變成實心。

- [ ] **Step 6: 提交**

```bash
git add gdbgui/templates/lessons.html gdbgui/templates/_auth_base.html tests/test_routes_swap.py
git commit -m "feat(browse): 主頁的搜尋框與標籤篩選列"
```

---

### Task 7: 個人檔案頁的標籤編輯

**Files:**
- Modify: `gdbgui/server/auth.py:246-265`（profile 視圖）
- Modify: `gdbgui/templates/profile.html`
- Modify: `gdbgui/templates/_auth_base.html`（標籤編輯表單的樣式）
- Test: `tests/test_tags_api.py`（追加一條）

**Interfaces:**
- Consumes: Task 2 的 `tags.tags_for_lessons`、Task 4 的 `POST /api/lessons/<id>/tags`
- Produces: `data-testid`：`profile-tag-input`、`profile-tag-save`、`profile-tag-list`

- [ ] **Step 1: profile 視圖帶標籤資料**

`auth.py`，把 `profile()` 的 `render_template` 段改成：

```python
    lessons = db.lessons_for_user(int(user["id"]))
    add_csrf_token_to_session()
    return render_template(
        "profile.html",
        profile_username=user["username"],
        display_name=user["display_name"],
        created_at=user["created_at"],
        lessons=lessons,
        lesson_tags=tags.tags_for_lessons([row["id"] for row in lessons]),
        is_self=(current_user_id() == int(user["id"])),
        csrf_token=session["csrf_token"],
    )
```

`auth.py:33` 的 `from . import blocking, db` 改成 `from . import blocking, db, tags`。
其餘都已經 import 過了：`session` 與 `render_template` 在 `auth.py:30`，
`add_csrf_token_to_session` 與 `current_user_id` 在 `auth.py:35`。

- [ ] **Step 2: 加樣式**

在 `_auth_base.html` 的 `<style>` 末尾（`@media (prefers-reduced-motion)` 之前）插入：

```css
      /* ── 標籤編輯（只在自己的個人檔案頁出現）───────────────── */
      .tag-edit {
        margin-top: 0.5rem;
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .tag-edit input[type="text"] {
        flex: 1 1 16rem;
        min-width: 0;
        padding: 0.35rem 0.5rem;
        font-family: var(--font-mono);
        font-size: 0.82rem;
        border-radius: 6px;
      }
      .tag-edit button {
        margin-top: 0; width: auto; flex: none;
        padding: 0.35rem 0.75rem; font-size: 0.8rem;
      }
      .tag-edit .status { font-size: 0.78rem; color: var(--ink-faint); }
      .tag-edit .status.bad { color: var(--danger); }
```

- [ ] **Step 3: 改 `profile.html`**

在每一列 `row-meta` 之後，`{% if is_self %}` 條件裡插入：

```jinja
              <span class="row-meta" data-testid="profile-tag-list">
                {% for name in lesson_tags.get(lesson["id"], []) %}
                  <a class="tag" href="{{ url_for('http_routes.lesson_library', tag=name) }}">{{ name }}</a>
                {% else %}
                  <span style="font-size:0.78rem; color:var(--ink-faint)">還沒有標籤</span>
                {% endfor %}
              </span>
              {% if is_self %}
                <span class="tag-edit">
                  <input type="text"
                         value="{{ lesson_tags.get(lesson['id'], []) | join(', ') }}"
                         placeholder="逗號分隔，最多 8 個"
                         aria-label="這篇教案的標籤"
                         data-lesson-id="{{ lesson['id'] }}"
                         data-testid="profile-tag-input" />
                  <button type="button" data-lesson-id="{{ lesson['id'] }}"
                          data-testid="profile-tag-save">儲存標籤</button>
                  <span class="status"></span>
                </span>
              {% endif %}
```

並在檔案末尾（`{% endblock %}` 之前）加：

```jinja
  <script data-csrf="{{ csrf_token }}">
    // 標籤走 POST /api/lessons/<id>/tags：擁有權在伺服器端判斷，
    // 這個表單只是入口。非作者就算自己造請求也只會拿到 404。
    (function () {
      var token = document.currentScript.getAttribute("data-csrf");
      document.querySelectorAll("[data-testid='profile-tag-save']").forEach(function (button) {
        button.addEventListener("click", function () {
          var id = button.getAttribute("data-lesson-id");
          var box = button.parentNode;
          var input = box.querySelector("input");
          var status = box.querySelector(".status");
          status.className = "status";
          status.textContent = "儲存中…";
          fetch("/api/lessons/" + encodeURIComponent(id) + "/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrftoken": token },
            credentials: "same-origin",
            body: JSON.stringify({ tags: input.value })
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
              if (response.ok) {
                input.value = (data.tags || []).join(", ");
                status.textContent = "已儲存";
              } else {
                status.className = "status bad";
                status.textContent = data.message || "儲存失敗。";
              }
            });
          });
        });
      });
    })();
  </script>
```

- [ ] **Step 4: 加一條測試確認別人的頁面沒有編輯表單**

追加到 `tests/test_tags_api.py`：

```python
def test_the_tag_editor_only_appears_on_your_own_profile(flask_app):
    """權限的真正防線在伺服器端，但也不該給別人一個沒有用的表單。"""
    author = register_user(flask_app, display_name="prof_a")
    other = register_user(flask_app, display_name="prof_b")
    _lesson(author.user_id)

    own = author.http.get(f"/u/{author.username}")
    assert b"profile-tag-save" in own.data

    theirs = other.http.get(f"/u/{author.username}")
    assert b"profile-tag-save" not in theirs.data
```

- [ ] **Step 5: 跑測試**

Run: `python -m pytest tests/test_tags_api.py -q`
Expected: PASS（8 passed）

- [ ] **Step 6: 提交**

```bash
git add gdbgui/server/auth.py gdbgui/templates/profile.html gdbgui/templates/_auth_base.html tests/test_tags_api.py
git commit -m "feat(tags): 個人檔案頁的標籤編輯"
```

---

### Task 8: e2e

**Files:**
- Create: `e2e/tests/zz_lesson_tags.spec.ts`
- Modify: `e2e/tests/zz_lesson_sharing.spec.ts`

**Interfaces:**
- Consumes: Task 6/7 的 `data-testid`；既有的 `ensureLoggedIn`

- [ ] **Step 1: 改既有的教案分享測試**

`zz_lesson_sharing.spec.ts` 裡：
* `await page.goto('/')` → `await page.goto('/edit')`（兩處）
* `await page.goto(`/?lesson=${lessonId}`)` → `/edit?lesson=${lessonId}`
* `await page.goto('/lessons')` → `await page.goto('/')`
* `expect(href).toMatch(/\/\?lesson=\d+$/)` → `expect(href).toMatch(/\/edit\?lesson=\d+$/)`
* `page.getByTestId('lesson-library-title')` → `lesson-browse-title`
* `page.request.get('/lessons')` → `page.request.get('/')`（兩處）

並在檔案末尾加一條，保住舊網址：

```ts
test('the old bookmarks still work', async ({ page }) => {
  await ensureLoggedIn(page);

  // /lessons 是教案庫的舊網址，內容搬到主頁了
  const lessons = await page.request.get('/lessons', { maxRedirects: 0 });
  expect(lessons.status()).toBe(302);

  // /?lesson=N 是教案的舊深連結，除錯器搬到 /edit 了
  const deeplink = await page.request.get('/?lesson=1', { maxRedirects: 0 });
  expect(deeplink.status()).toBe(302);
  expect(deeplink.headers()['location']).toContain('/edit?lesson=1');
});
```

- [ ] **Step 2: 寫新的標籤 e2e**

`e2e/tests/zz_lesson_tags.spec.ts`：

```ts
/**
 * 標籤與瀏覽。後端授權由 tests/test_tags_api.py 覆蓋；這裡只驗前端接得上：
 * 在個人檔案頁貼標籤 → 主頁搜尋得到 → 點標籤能縮小清單。
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

test('tag a lesson, then find it by搜尋 and by clicking the tag', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);

  const stamp = Date.now();
  const title = `標籤測試 ${stamp}`;
  const tag = `e2etag${stamp}`;

  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': await csrfToken(page), 'Content-Type': 'application/json' },
    data: {
      title,
      bundle: { version: '2.0', fullname_to_render: '', source_code: 'int main(){}\n',
                breakpoints: [], program_input: '' },
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;

  const tagged = await page.request.post(`/api/lessons/${id}/tags`, {
    headers: { 'x-csrftoken': await csrfToken(page), 'Content-Type': 'application/json' },
    data: { tags: `${tag}, STL` },
  });
  expect(tagged.status()).toBe(200);
  expect((await tagged.json()).tags).toContain(tag);

  // 搜尋標籤名找得到這篇
  await page.goto(`/?q=${encodeURIComponent(tag)}`);
  await expect(page.getByTestId('lesson-browse-title').filter({ hasText: title })).toBeVisible();

  // 點列上的標籤 → 網址帶上 tag，清單仍然有這篇
  await page.getByTestId('lesson-browse-tag').filter({ hasText: tag }).first().click();
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  await expect(page.getByTestId('lesson-browse-title').filter({ hasText: title })).toBeVisible();

  // 收乾淨
  await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': await csrfToken(page) },
  });
});

test('the tag editor on your own profile writes tags', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);

  const stamp = Date.now();
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': await csrfToken(page), 'Content-Type': 'application/json' },
    data: {
      title: `編輯器測試 ${stamp}`,
      bundle: { version: '2.0', fullname_to_render: '', source_code: 'int main(){}\n',
                breakpoints: [], program_input: '' },
    },
  });
  const id = (await created.json()).id;

  // 找到自己的個人檔案頁
  await page.goto('/');
  await page.getByTestId('lesson-browse-author').first().click();

  const input = page.getByTestId('profile-tag-input').first();
  await input.fill(`profiletag${stamp}`);
  await page.getByTestId('profile-tag-save').first().click();
  await expect(page.locator('.tag-edit .status').first()).toHaveText('已儲存');

  await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': await csrfToken(page) },
  });
});
```

- [ ] **Step 3: 跑 e2e**

```bash
docker compose -f docker-compose.test.yml run --rm --build e2e \
  npx playwright test tests/zz_lesson_tags.spec.ts tests/zz_lesson_sharing.spec.ts --reporter=list
```
Expected: 5 passed

- [ ] **Step 4: 跟基準線比對，確認沒有回歸**

跑完整 e2e，逐條 diff 目前已知的 18 條既有失敗：

```bash
docker compose -f docker-compose.test.yml run --rm --build e2e \
  npx playwright test --reporter=list > /tmp/e2e_after.log 2>&1
```
Expected: 失敗集合只減不增（`zz_lesson_sharing` 那兩條仍然綠）

- [ ] **Step 5: 提交**

```bash
git add e2e/tests/zz_lesson_tags.spec.ts e2e/tests/zz_lesson_sharing.spec.ts
git commit -m "test(tags): 標籤與瀏覽的 e2e，並讓既有測試跟上新路由"
```

---

## 完成後的驗收

```bash
python -m pytest tests/ -q
docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test --reporter=list
```

手動確認一遍：

1. `/` 是教案清單，未登入會被導去登入頁
2. 打字搜尋能同時比到標題、作者、標籤
3. 點標籤會縮小清單，再點一次會取消；兩個標籤是 AND
4. 標籤列不會出現「點了就變成空清單」的標籤
5. 自己的個人檔案頁能改標籤，別人的頁面沒有那個表單
6. `/lessons` 與 `/?lesson=N` 兩個舊網址仍然有用
