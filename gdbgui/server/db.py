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
MAX_BUNDLE_BYTES = 1_000_000

#: 教案庫頁每頁筆數。
LESSONS_PER_PAGE = 10


class LessonRejected(ValueError):
    """教案的標題或內容不符合儲存層的限制。

    在資料層而不只是在路由層檢查：路由那一層會回一個乾淨的 400/413，這一層
    則保證「不管哪個呼叫端、將來多加幾條路由」，超過上限的東西都進不了資料庫。
    """


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
    with closing(connect()) as conn:
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
    with closing(connect()) as conn:
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
