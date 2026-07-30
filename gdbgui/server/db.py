"""SQLite 資料層 —— 使用者、教案，以及持久化的 SECRET_KEY。

設計文件：docs/superpowers/specs/2026-07-29-user-profile-slice-design.md

## 為什麼是 stdlib sqlite3 而不是 ORM

三張表、約 200 個帳號、寫入只發生在註冊與存教案。SQLite 就是一個檔案，
零相依、一個 compose 就能跑。所有查詢一律**參數化**，本模組裡不存在任何
用 f-string / % / + 拼出來的 SQL；唯一會被拼進 SQL 的是 migration 檔的內容，
而那是本 repo 自己的檔案，不是使用者輸入。

## 為什麼需要一個持久 volume

在此之前容器裡沒有任何持久儲存：scratch 是 tmpfs（刻意的），uploads 的
bind mount 已於 4c54fc1 移除。資料庫是第一個真正需要活過重啟的東西，
SECRET_KEY 是第二個。

## 權限：session 帳號絕對不能讀到這裡

同一個容器裡跑著不可信的使用者 C++ 程式（sandbox/jail_manager.py 的
per-session 帳號）。資料目錄裡有密碼雜湊與 SECRET_KEY——SECRET_KEY 外洩等於
可以偽造任何人的 session cookie，也就等於冒充任何使用者、取得任何人的
owner_key()。所以：

  * 資料目錄 0700、屬於伺服器（root）——session 帳號連 traverse 都不行
  * SECRET_KEY 檔 0600，用 O_EXCL | O_NOFOLLOW 建立
  * 部署模式（GDBGUI_REQUIRE_ISOLATION=1）下若權限收不緊就**拒絕啟動**，
    絕不默默地把金鑰放在別人讀得到的地方

刻意**不**放在 SCRATCH_ROOT 底下：那裡是 tmpfs，而且每個 session 帳號都在
裡面有自己的目錄。
"""

import logging
import os
import re
import secrets
import sqlite3
import stat
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

#: 持久資料的家。compose 掛一個 named volume 到這裡。
#: 測試會 monkeypatch 這個模組層變數，所以底下一律透過函式讀取它。
DATA_DIR = Path(os.environ.get("GDBGUI_DATA_DIR") or "/var/lib/gdbgui")

DB_FILENAME = "gdbgui.sqlite3"
SECRET_KEY_FILENAME = "secret_key"

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

#: migration 檔名的形狀：`0001_something.sql`
_MIGRATION_NAME_RE = re.compile(r"\A(\d+)_[A-Za-z0-9_]+\.sql\Z")

#: 1 = 這是真正的多使用者部署（compose 有設）。權限收不緊時要炸掉而不是警告。
_REQUIRE_STRICT_PERMISSIONS = os.environ.get("GDBGUI_REQUIRE_ISOLATION") == "1"


class DatabaseError(RuntimeError):
    """資料層無法安全地初始化。"""


# ---------------------------------------------------------------------------
# 路徑
# ---------------------------------------------------------------------------


def data_dir() -> Path:
    return DATA_DIR


def db_path() -> Path:
    return DATA_DIR / DB_FILENAME


def secret_key_path() -> Path:
    return DATA_DIR / SECRET_KEY_FILENAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 目錄與檔案權限
# ---------------------------------------------------------------------------


def ensure_data_dir() -> Path:
    """建立資料目錄並把權限收成 0700。

    0700 是這裡唯一真正的邊界：容器內跑著不可信的 per-session 帳號，
    目錄少了 x 權限他們連 stat 底下的檔案都做不到。
    """
    directory = data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        logger.warning("[db] could not chmod 0700 %s", directory, exc_info=True)

    _assert_not_group_or_world_accessible(directory)
    return directory


def _assert_not_group_or_world_accessible(path: Path) -> None:
    """group/other 只要還有任何一個 bit，部署模式就拒絕繼續。

    只在有 POSIX 權限語意的平台上檢查（Windows 的 chmod 只切唯讀旗標，
    在那裡本來就沒有 session 帳號這種東西）。
    """
    if os.name != "posix":
        return
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return
    if not mode & 0o077:
        return
    message = (
        f"{path} is accessible to group/other (mode {mode:04o}); the SECRET_KEY and "
        "password hashes live here and per-session accounts run in this container"
    )
    if _REQUIRE_STRICT_PERMISSIONS:
        raise DatabaseError(message)
    logger.warning("[db] %s", message)


def _harden_db_files() -> None:
    """資料庫本體與 WAL/SHM 邊檔一律 0600。

    目錄 0700 已經擋住了別的帳號，這是第二層：萬一資料目錄哪天被掛成別的
    權限（volume 設定變動），檔案本身還是關著的。
    """
    if os.name != "posix":
        return
    base = db_path()
    for path in (base, Path(str(base) + "-wal"), Path(str(base) + "-shm")):
        try:
            if path.exists():
                os.chmod(path, 0o600)
        except OSError:
            logger.warning("[db] could not chmod 0600 %s", path, exc_info=True)


# ---------------------------------------------------------------------------
# 連線
# ---------------------------------------------------------------------------


def connect() -> sqlite3.Connection:
    """開一條新連線。

    每次操作開一條、用完就關：伺服器是 eventlet 單執行緒 + 一條 tpool 執行緒池，
    連線的執行緒歸屬會很難講清楚，而這裡的查詢量（登入、註冊、看個人檔案）
    小到不值得為了省連線成本去承擔那個複雜度。
    """
    ensure_data_dir()
    conn = sqlite3.connect(str(db_path()), timeout=10.0)
    _harden_db_files()
    conn.row_factory = sqlite3.Row
    # WAL：讀不擋寫、寫不擋讀。這是 DB 檔案的持久屬性，設一次就好，
    # 但每條連線都設是冪等且便宜的。
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

_SCHEMA_VERSION_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
)
"""


def migration_files() -> List[Path]:
    """依編號排序的 migration 檔。編號重複直接視為錯誤。"""
    if not MIGRATIONS_DIR.is_dir():
        return []
    found = {}
    for path in sorted(MIGRATIONS_DIR.iterdir()):
        match = _MIGRATION_NAME_RE.fullmatch(path.name)
        if match is None:
            continue
        version = int(match.group(1))
        if version in found:
            raise DatabaseError(
                f"duplicate migration number {version}: {found[version].name} and {path.name}"
            )
        found[version] = path
    return [found[version] for version in sorted(found)]


def migrate() -> int:
    """把所有還沒套用過的 migration 依序套上，回傳這次套了幾個。

    ★ 每一個 migration 都必須寫成冪等的（`CREATE TABLE IF NOT EXISTS` 等）★

    原因是 sqlite3 的 `executescript()` 在執行前會先隱式 COMMIT，所以沒有辦法
    把一整個腳本包在一個交易裡。折衷是：腳本本身冪等，而版本號只在腳本整個
    跑完之後才寫進 schema_version。腳本跑到一半失敗 → 版本沒被記錄 →
    下次啟動重跑一次，因為冪等所以安全。
    """
    with closing(connect()) as conn:
        conn.execute(_SCHEMA_VERSION_DDL)
        conn.commit()
        applied = {
            int(row[0]) for row in conn.execute("SELECT version FROM schema_version")
        }

        count = 0
        for path in migration_files():
            version = int(_MIGRATION_NAME_RE.fullmatch(path.name).group(1))
            if version in applied:
                continue
            logger.info("[db] applying migration %s", path.name)
            conn.executescript(path.read_text(encoding="utf-8"))
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (version, _now()),
            )
            conn.commit()
            count += 1
        return count


def schema_version() -> int:
    """目前套用到第幾號（空資料庫是 0）。"""
    with closing(connect()) as conn:
        conn.execute(_SCHEMA_VERSION_DDL)
        row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


# ---------------------------------------------------------------------------
# SECRET_KEY
# ---------------------------------------------------------------------------


def get_or_create_secret_key() -> str:
    """讀取（必要時產生）Flask 的 SECRET_KEY。

    在此之前 app.py 每次啟動都 `binascii.hexlify(os.urandom(24))`——換一把新
    鑰匙，所有 session 立刻失效。沒有登入時無所謂；有了登入之後，每次部署或
    重啟都會把所有人登出，上課上到一半重啟服務會很擾人。

    O_CREAT | O_EXCL：兩個行程同時啟動時只有一個會寫，另一個讀它寫的那把。
    O_NOFOLLOW：不跟 symlink 走（資料目錄是 0700 root，理論上放不進 symlink，
    但建立金鑰檔這種事不該依賴「理論上」）。
    """
    ensure_data_dir()
    path = secret_key_path()

    try:
        fd = os.open(
            str(path),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
    except FileExistsError:
        return _read_secret_key(path)
    except OSError as exc:
        raise DatabaseError(f"could not create the secret key at {path}: {exc}") from exc

    try:
        key = secrets.token_hex(32)
        os.write(fd, key.encode("ascii"))
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
    finally:
        os.close(fd)

    logger.info("[db] generated a new persistent SECRET_KEY at %s", path)
    return key


def _read_secret_key(path: Path) -> str:
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise DatabaseError(f"could not read the secret key at {path}: {exc}") from exc
    try:
        if os.name == "posix":
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise DatabaseError(f"{path} is not a regular file")
            if stat.S_IMODE(info.st_mode) & 0o077:
                # 修好而不是只是抱怨：這把鑰匙讀得到就等於可以偽造任何人的 session。
                try:
                    os.fchmod(fd, 0o600)
                    logger.warning("[db] tightened permissions on %s to 0600", path)
                except OSError as exc:
                    raise DatabaseError(
                        f"{path} is readable beyond its owner and could not be fixed: {exc}"
                    ) from exc
        key = os.read(fd, 4096).decode("ascii", errors="strict").strip()
    except UnicodeDecodeError as exc:
        raise DatabaseError(f"{path} does not contain a usable secret key") from exc
    finally:
        os.close(fd)

    if len(key) < 32:
        raise DatabaseError(
            f"{path} does not contain a usable secret key (too short). "
            "Refusing to start with a weak session signing key."
        )
    return key


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------


def create_user(username: str, password_hash: str, display_name: str) -> Optional[int]:
    """新增使用者，回傳 user id；username 已被使用回傳 None。

    刻意用「先 INSERT 再接 IntegrityError」而不是「先查再寫」：後者在兩個人
    同時註冊同一個名字時會兩個都通過查詢。UNIQUE 約束是唯一可靠的仲裁者。
    """
    with closing(connect()) as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, display_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (username, password_hash, display_name, _now()),
            )
        except sqlite3.IntegrityError:
            return None
        conn.commit()
        return int(cursor.lastrowid)


def user_by_username(username: str) -> Optional[sqlite3.Row]:
    if not isinstance(username, str) or not username:
        return None
    with closing(connect()) as conn:
        return conn.execute(
            "SELECT id, username, password_hash, display_name, created_at "
            "FROM users WHERE username = ?",
            (username,),
        ).fetchone()


def user_by_id(user_id: int) -> Optional[sqlite3.Row]:
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        return None
    with closing(connect()) as conn:
        return conn.execute(
            "SELECT id, username, password_hash, display_name, created_at "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()


def user_count() -> int:
    with closing(connect()) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])


# ---------------------------------------------------------------------------
# lessons
#
# ## 可見性：全部公開給登入者
#
# 使用者於 2026-07-30 決定「每一篇存下來的教案都對每一個登入者可見」，所以
# **沒有** visibility 欄位、**沒有** 軟刪除。這不是為了省一個欄位：有那種欄位
# 時，每一條查詢都必須記得過濾，漏掉任何一條就是資料外洩，而那種疏漏在 code
# review 裡幾乎看不出來。沒有可漏的過濾，就沒有那一整類漏洞。
#
# ## 授權：user_id 永遠取自 session
#
# 本模組的函式一律把 user_id 當成**呼叫端已經從 session 取好的身分**。
# 「是不是擁有者」這件事寫在 SQL 的 WHERE 子句裡（`AND user_id = ?`），不是
# 先 SELECT 出來再用 Python 比對——WHERE 版本沒有 check-then-act 的空隙，
# 而且擋不住的時候是「改到 0 列」而不是「改到別人的那一列」。
# ---------------------------------------------------------------------------

#: 標題長度上限（字元）。標題會被渲染進教案庫頁與個人檔案頁。
MAX_TITLE_LENGTH = 200

#: bundle 原文的位元組上限。這是使用者提供的 JSON：沒有上限就等於一條把
#: SQLite 檔案與伺服器記憶體塞爆的路徑（一個請求即可，不需要任何權限）。
#:
#: 256 KB 是量出來的，不是猜的：這個 repo 裡真實教案是 0.9–6.0 KB（cf_oop
#: 那 24 篇平均 1.6 KB），所以這是最大真實教案的約 40 倍。原本的 1 MB 是
#: 真實值的 500 倍，實際上沒有守住任何東西。
MAX_BUNDLE_BYTES = 256 * 1024

#: 單一使用者所有教案的位元組總和上限。以真實教案大小算約 3000 篇——正常
#: 使用者一輩子碰不到，但擋得住一個粗心或惡意的**帳號**。
#:
#: 注意它擋不住蓄意攻擊：註冊是開放的且沒有速率限制（使用者明確的決定，見
#: auth.py），所以攻擊者可以多開帳號繞過 per-user 配額。真正有界的是下面的
#: 全域上限。
MAX_USER_BYTES = 20 * 1024 * 1024

#: 全站所有教案的位元組總和上限。這是唯一真正有界的一道。
#:
#: 它的價值在失敗方式：磁碟被塞爆時 SQLite 寫入失敗、secret key 無法輪替、
#: 整個服務以無法預測的方式壞掉；這個上限觸發時只是「暫時存不了新教案」，
#: 登入正常、既有教案照樣讀得到。
MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024

#: 用「bundle 位元組總和」而不是 SQLite 檔案大小來衡量用量。
#:
#: 檔案大小看起來更誠實（含索引與 WAL 的額外開銷），但 SQLite 刪除資料後
#: **不會把頁面還給作業系統**（除非 VACUUM），所以用檔案大小會導致「使用者
#: 刪掉教案之後仍然存不了東西」——一個使用者無法自救的死結。位元組總和會
#: 隨刪除下降，代價是低估了索引開銷；用大額度的安全邊際吸收那個誤差。
_USED_BYTES_SQL = "SELECT COALESCE(SUM(LENGTH(CAST(bundle_json AS BLOB))), 0) FROM lessons"

#: 教案庫頁每頁筆數。
LESSONS_PER_PAGE = 10


class LessonRejected(ValueError):
    """教案的標題或內容不符合儲存層的限制。

    在資料層而不只是在路由層檢查：路由那一層會回一個乾淨的 400/413，這一層
    則保證「不管哪個呼叫端、將來多加幾條路由」，超過上限的東西都進不了資料庫。
    """


class LessonQuotaExceeded(LessonRejected):
    """配額用盡（個人或全站），而不是這一篇本身有問題。

    分成獨立的類別是為了讓路由能回一個**使用者能據以行動**的訊息：「這一篇
    格式不對」跟「你的空間滿了，刪幾篇再存」要做的事完全不同。繼承
    LessonRejected 所以既有的 except 仍然接得住，不會因為新增例外而漏接。
    """

    def __init__(self, message: str, used: int, limit: int):
        super().__init__(message)
        self.used = used
        self.limit = limit


def _check_quotas(conn, user_id: int, new_bytes: int, replacing_lesson_id=None) -> None:
    """在同一個交易裡檢查個人與全站配額。

    replacing_lesson_id 不是 None 時扣掉那一列的現有大小——更新一篇教案要算的
    是**差額**，不是新版的完整大小。否則一個接近配額的使用者連「把教案改短」
    都會被拒絕，那顯然是錯的。

    fork（把別人的教案存成自己的）走的是新增路徑，所以整篇都算在 fork 的人
    頭上，這是對的：那確實是一份新的資料。
    """
    old_bytes = 0
    if replacing_lesson_id is not None:
        row = conn.execute(
            "SELECT LENGTH(CAST(bundle_json AS BLOB)) FROM lessons WHERE id = ? AND user_id = ?",
            (replacing_lesson_id, user_id),
        ).fetchone()
        if row is not None:
            old_bytes = int(row[0])

    delta = new_bytes - old_bytes
    if delta <= 0:
        return  # 沒有變大就一定不會突破任何上限

    user_used = int(
        conn.execute(
            _USED_BYTES_SQL + " WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
    )
    if user_used + delta > MAX_USER_BYTES:
        raise LessonQuotaExceeded(
            "user storage quota exceeded", used=user_used, limit=MAX_USER_BYTES
        )

    total_used = int(conn.execute(_USED_BYTES_SQL).fetchone()[0])
    if total_used + delta > MAX_TOTAL_BYTES:
        raise LessonQuotaExceeded(
            "site storage quota exceeded", used=total_used, limit=MAX_TOTAL_BYTES
        )


def _require_user_id(user_id) -> int:
    """把 user_id 收成一個真的正整數，否則直接拒絕。

    fail closed：一個壞掉的身分（None、字串、True）絕不可以被當成某個人的
    id 送進 WHERE 子句去。
    """
    if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
        raise LessonRejected("a lesson needs a real user id")
    return user_id


def _require_lesson_id(lesson_id) -> Optional[int]:
    if isinstance(lesson_id, bool) or not isinstance(lesson_id, int) or lesson_id <= 0:
        return None
    return lesson_id


def _validated_lesson(title, bundle_json):
    """(title, bundle_json)，不合格就 raise LessonRejected。"""
    if not isinstance(title, str) or not isinstance(bundle_json, str):
        raise LessonRejected("lesson title and bundle must both be text")
    title = title.strip()
    if not title:
        raise LessonRejected("a lesson needs a title")
    if len(title) > MAX_TITLE_LENGTH:
        raise LessonRejected("lesson title is too long")
    # 位元組而不是字元：撐爆磁碟與記憶體的是位元組，而一個中文字元是三個。
    if len(bundle_json.encode("utf-8")) > MAX_BUNDLE_BYTES:
        raise LessonRejected("lesson bundle is too large")
    return title, bundle_json


def create_lesson(user_id: int, title: str, bundle_json: str) -> int:
    """新增一篇教案，回傳它的 id。

    user_id 由呼叫端從 session 取得（http_util.current_user_id），永遠不是
    請求本體裡的欄位。
    """
    user_id = _require_user_id(user_id)
    title, bundle_json = _validated_lesson(title, bundle_json)
    now = _now()
    new_bytes = len(bundle_json.encode("utf-8"))
    with closing(connect()) as conn:
        # BEGIN IMMEDIATE：檢查與寫入必須在同一個寫入交易裡，否則兩個同時
        # 送出的儲存請求會各自讀到「還沒滿」然後都寫進去。
        conn.execute("BEGIN IMMEDIATE")
        _check_quotas(conn, user_id, new_bytes)
        cursor = conn.execute(
            "INSERT INTO lessons (user_id, title, bundle_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, title, bundle_json, now, now),
        )
        conn.commit()
        return int(cursor.lastrowid)


def lesson_by_id(lesson_id: int) -> Optional[sqlite3.Row]:
    """一篇教案（含 bundle 原文與作者資訊）。任何登入者都讀得到——見上方
    「可見性」的說明，這裡刻意沒有 user_id 條件。"""
    lesson_id = _require_lesson_id(lesson_id)
    if lesson_id is None:
        return None
    with closing(connect()) as conn:
        return conn.execute(
            "SELECT l.id, l.user_id, l.title, l.bundle_json, l.created_at, "
            "       l.updated_at, u.username, u.display_name "
            "FROM lessons l JOIN users u ON u.id = l.user_id "
            "WHERE l.id = ?",
            (lesson_id,),
        ).fetchone()


def update_lesson_owned_by(
    lesson_id: int, user_id: int, title: str, bundle_json: str
) -> bool:
    """只更新「這個 id 而且屬於這個 user」的那一列，回傳有沒有真的改到。

    `AND user_id = ?` 才是授權本身。呼叫端（http_routes）在此之前還會自己看
    一次擁有權以決定要更新還是要另存副本，但那是**行為**分支；這裡的 WHERE
    是最後一道，少了它，那個分支寫錯就會直接覆寫別人的教案。
    """
    user_id = _require_user_id(user_id)
    lesson_id = _require_lesson_id(lesson_id)
    if lesson_id is None:
        return False
    title, bundle_json = _validated_lesson(title, bundle_json)
    new_bytes = len(bundle_json.encode("utf-8"))
    with closing(connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        # 只算差額：把教案改短或改成一樣大的人，不該因為接近配額而被擋。
        _check_quotas(conn, user_id, new_bytes, replacing_lesson_id=lesson_id)
        cursor = conn.execute(
            "UPDATE lessons SET title = ?, bundle_json = ?, updated_at = ? "
            "WHERE id = ? AND user_id = ?",
            (title, bundle_json, _now(), lesson_id, user_id),
        )
        conn.commit()
        return cursor.rowcount == 1


def delete_lesson_owned_by(lesson_id: int, user_id: int) -> bool:
    """硬刪除，只刪自己的那一列；回傳有沒有真的刪到。

    硬刪除而不是軟刪除：軟刪除會讓「全部公開」的簡單性失效——每一條查詢又要
    記得多過濾一個 `deleted_at IS NULL`，正是這個設計刻意避開的那類疏漏。
    """
    user_id = _require_user_id(user_id)
    lesson_id = _require_lesson_id(lesson_id)
    if lesson_id is None:
        return False
    with closing(connect()) as conn:
        cursor = conn.execute(
            "DELETE FROM lessons WHERE id = ? AND user_id = ?", (lesson_id, user_id)
        )
        conn.commit()
        return cursor.rowcount == 1


def lessons_for_user(user_id: int) -> List[sqlite3.Row]:
    """某個使用者的教案清單。

    個人檔案頁只呈現 owner 自己的教案——WHERE 條件就是那道界線，
    不要在呼叫端過濾（那樣一旦有人忘記過濾就會列出全部）。
    """
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        return []
    with closing(connect()) as conn:
        return list(
            conn.execute(
                "SELECT id, user_id, title, created_at, updated_at "
                "FROM lessons WHERE user_id = ? ORDER BY updated_at DESC, id DESC",
                (user_id,),
            )
        )


def recent_lessons(limit: int, offset: int) -> List[sqlite3.Row]:
    """教案庫頁的一頁：全部教案，`updated_at DESC, id DESC`。

    第二個排序鍵不是裝飾。updated_at 只到秒（_now()），同一秒存下的幾篇教案
    光靠它沒有確定的先後，而 LIMIT/OFFSET 分頁在排序不是全序時會讓第 1 頁與
    第 2 頁重複或遺漏項目。id 是 PRIMARY KEY，補上去就是全序。
    索引見 migrations/0002_lessons_recent_index.sql。
    """
    limit = max(0, int(limit))
    offset = max(0, int(offset))
    with closing(connect()) as conn:
        return list(
            conn.execute(
                "SELECT l.id, l.user_id, l.title, l.created_at, l.updated_at, "
                "       u.username, u.display_name "
                "FROM lessons l JOIN users u ON u.id = l.user_id "
                "ORDER BY l.updated_at DESC, l.id DESC "
                "LIMIT ? OFFSET ?",
                (limit, offset),
            )
        )


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


def lesson_count() -> int:
    with closing(connect()) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM lessons").fetchone()[0])


# ---------------------------------------------------------------------------
# 啟動
# ---------------------------------------------------------------------------


def initialize() -> None:
    """建目錄、套 migration。app.py 在 import 時呼叫一次。"""
    ensure_data_dir()
    applied = migrate()
    if applied:
        logger.info("[db] applied %d migration(s); schema is at v%d", applied, schema_version())
