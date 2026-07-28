"""
jail_manager.py — 每個 debug session 一個臨時 OS 帳號 + 私有 scratch 目錄

設計文件：docs/superpowers/specs/2026-07-29-execution-isolation-design.md（架構 ②③④⑤）

## 這解決什麼

在此之前，所有使用者的程式都以同一個 OS 使用者（root）執行，session 之間
只靠 uploads/ 底下的**亂數檔名**分隔。檔名不是權限：任何一支使用者 C++ 都能
`open()` 讀取其他使用者的原始碼與編譯結果。本模組把分隔換成 OS 權限。

## 邊界長什麼樣

每個 session 取得：

  * 一個臨時 OS 帳號 `gdbs_<sha256(session_key)[:16]>`（無 home、shell 為 nologin）
  * 一個 scratch 目錄 `<SCRATCH_ROOT>/<帳號名>`，`0700`、屬於該帳號
  * 編譯器與 GDB 都以該帳號、在 `unshare --user --net` 內執行

`confine()` 產生的命令鏈是：

    setpriv --reuid=U --regid=G --clear-groups --      ← 降權（檔案權限邊界）
      unshare --user --net --map-current-user --       ← user + network namespace
        env HOME=<scratch> TMPDIR=<scratch>            ← 不碰 /root、不碰共用 /tmp
          <實際命令>

順序是有意義的，**不可對調**：`unshare --user` 之後 uid 對映會失效，
`setpriv` 再降權到一個未對映的 uid 會失敗。

## 為什麼 GDB 整個跑在 namespace 內，而不是只包住被除錯的程式

實測（本專案 image、Docker 28.5.2、kernel 6.18）：只要**被除錯的 inferior**
換了 uid 或進入了 user namespace，而 GDB 留在外面，GDB 就無法下中斷點
（`Cannot insert breakpoint / Cannot access memory`）——**加上 CAP_SYS_PTRACE
也一樣不行**。跨 uid / 跨 user namespace 的 ptrace 不是加個 capability 就能解決。

所以邊界必須包住 GDB 自己：GDB 與 inferior 同 uid、同 namespace，
ptrace 屬於同層親子關係，一切正常。這也是比較強的隔離——連 GDB 都被關進去了。

`set exec-wrapper`（sandbox/wrapper.sh）仍然保留，但它只做 ulimit，
不再嘗試降權；降權由本模組在更外層完成。

## 不放持久資料

scratch 是暫存，session 結束即整個刪除，且**刻意不放在共用 volume 上**：
user namespace 的 uid 對映會讓 namespace 內外的檔案所有權不一致，
scratch 不跨容器共享就完全迴避這個坑。持久資料屬於資料庫（子專案 A）。

## 失效模式

`GDBGUI_REQUIRE_ISOLATION=1`（compose 有設）時，隔離無法建立就**拋例外**，
絕不默默降級成「大家共用 root」。沒設時（本機非 Docker 開發）才允許回傳 None。
"""

import hashlib
import logging
import os
import pwd
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

#: scratch 根目錄。務必是 container-local 路徑，**不要**掛成共用 volume。
SCRATCH_ROOT = Path(os.environ.get("GDBGUI_SCRATCH_ROOT") or "/srv/gdbgui-scratch")

#: 同時存在的 session 上限（架構 ⑤ 的全域併發上限）。
MAX_SESSIONS = int(os.environ.get("GDBGUI_MAX_SESSIONS") or 24)

#: 超過這麼久沒有動靜的 session 會被回收（秒）。
IDLE_TIMEOUT_SECONDS = int(os.environ.get("GDBGUI_SESSION_IDLE_SECONDS") or 3600)

#: 1 = 隔離建立不起來就失敗（部署用）；未設 = 允許降級（本機開發用）。
REQUIRE_ISOLATION = os.environ.get("GDBGUI_REQUIRE_ISOLATION") == "1"

ACCOUNT_PREFIX = "gdbs_"

# session_key 會被放進 useradd 的 argv，因此只接受 hex（uuid4().hex 的形狀）。
_SESSION_KEY_RE = re.compile(r"\A[0-9a-f]{8,64}\Z")

_SETPRIV = "/usr/bin/setpriv"
_UNSHARE = "/usr/bin/unshare"
_ENV = "/usr/bin/env"
_USERADD = "/usr/sbin/useradd"
_USERDEL = "/usr/sbin/userdel"
_PKILL = "/usr/bin/pkill"


class JailError(RuntimeError):
    """隔離相關的基底例外。"""


class TooManySessions(JailError):
    """同時存在的 session 數已達 MAX_SESSIONS。"""


class JailUnavailable(JailError):
    """這台機器建立不了隔離（缺工具、非 root、scratch 不可寫……）。"""


@dataclass
class Jail:
    session_key: str
    name: str
    uid: int
    gid: int
    dir: Path
    last_used: float = field(default_factory=time.time)


_lock = threading.RLock()
_jails: Dict[str, Jail] = {}


# ---------------------------------------------------------------------------
# 能力偵測
# ---------------------------------------------------------------------------

def _missing_prerequisites() -> List[str]:
    missing = []
    # os.geteuid 在 Windows 上不存在；那裡本來就不支援（ptylib 會直接 raise），
    # 但別讓「偵測能力」這件事自己爆掉。
    geteuid = getattr(os, "geteuid", None)
    if geteuid is None:
        return ["unsupported platform"]
    if geteuid() != 0:
        missing.append("not running as root")
    for tool in (_SETPRIV, _UNSHARE, _ENV, _USERADD, _USERDEL, _PKILL):
        if not os.path.exists(tool):
            missing.append(f"missing {tool}")
    return missing


def isolation_available() -> bool:
    return not _missing_prerequisites()


def _run(argv: List[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv, capture_output=True, text=True, timeout=30, check=False, **kwargs
    )


# ---------------------------------------------------------------------------
# scratch 根目錄
# ---------------------------------------------------------------------------

def ensure_scratch_root() -> None:
    """建立 scratch 根目錄。0755 且屬於 root：任何人可以走進去，
    但只有 root 能在裡面新增／刪除項目——session 之間彼此建不了目錄。"""
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    os.chown(SCRATCH_ROOT, 0, 0)
    os.chmod(SCRATCH_ROOT, 0o755)


# ---------------------------------------------------------------------------
# 帳號生命週期
# ---------------------------------------------------------------------------

def _account_name(session_key: str) -> str:
    # useradd 的使用者名稱長度上限是 32；gdbs_ + 16 hex = 21 字元，安全。
    digest = hashlib.sha256(session_key.encode("ascii")).hexdigest()[:16]
    return ACCOUNT_PREFIX + digest


def _validate_session_key(session_key: str) -> str:
    if not isinstance(session_key, str) or not _SESSION_KEY_RE.fullmatch(session_key):
        raise JailError("invalid session key")
    return session_key


def _lookup(name: str) -> Optional[pwd.struct_passwd]:
    try:
        return pwd.getpwnam(name)
    except KeyError:
        return None


def _create_account(name: str) -> pwd.struct_passwd:
    existing = _lookup(name)
    if existing is not None:
        return existing
    result = _run(
        [
            _USERADD,
            "--no-create-home",
            "-M",
            "--shell", "/usr/sbin/nologin",
            "--home-dir", "/nonexistent",
            name,
        ]
    )
    entry = _lookup(name)
    if entry is None:
        raise JailUnavailable(
            f"useradd failed for {name} (rc={result.returncode}): {result.stderr.strip()}"
        )
    return entry


def _kill_processes_of(uid: int) -> None:
    """殺掉該 uid 的所有殘留行程。uid 是本模組自己配出來的臨時帳號，
    絕不會是 root（0），因此不可能誤殺伺服器本身。"""
    if uid <= 0:
        raise JailError("refusing to kill processes of uid <= 0")
    for signal_flag in ("-TERM", "-KILL"):
        _run([_PKILL, signal_flag, "-u", str(uid)])


def _delete_account(name: str, uid: int, directory: Path) -> None:
    try:
        _kill_processes_of(uid)
    except Exception:
        logger.exception("[jail] failed killing processes for %s", name)
    try:
        # scratch 目錄由我們自己刪，userdel 不要碰任何檔案（沒有 --remove）
        _run([_USERDEL, name])
    except Exception:
        logger.exception("[jail] userdel failed for %s", name)
    try:
        if directory.is_dir():
            shutil.rmtree(directory, ignore_errors=True)
    except Exception:
        logger.exception("[jail] rmtree failed for %s", directory)


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------

def acquire(session_key: str) -> Optional[Jail]:
    """取得（必要時建立）此 session 的帳號與 scratch 目錄。

    同一個 session_key 重複呼叫是冪等的，回傳同一個 Jail。

    raises TooManySessions  併發上限已滿（呼叫端應回明確錯誤，不要當 500）
    raises JailUnavailable  REQUIRE_ISOLATION=1 但這台機器建不起來
    returns None            REQUIRE_ISOLATION 未設且環境不支援（本機開發）
    """
    session_key = _validate_session_key(session_key)

    with _lock:
        jail = _jails.get(session_key)
        if jail is not None:
            jail.last_used = time.time()
            return jail

        missing = _missing_prerequisites()
        if missing:
            message = "execution isolation unavailable: " + ", ".join(missing)
            if REQUIRE_ISOLATION:
                raise JailUnavailable(message)
            logger.warning("[jail] %s -- running WITHOUT per-session isolation", message)
            return None

        reap_idle()

        if len(_jails) >= MAX_SESSIONS:
            raise TooManySessions(
                f"concurrent debug session limit reached ({MAX_SESSIONS})"
            )

        ensure_scratch_root()

        name = _account_name(session_key)
        entry = _create_account(name)
        directory = SCRATCH_ROOT / name

        # 先建目錄再設權限，且 chmod 在 chown 之後——避免有一瞬間
        # 目錄已經屬於 session 使用者卻還是 0755。
        directory.mkdir(parents=True, exist_ok=True)
        os.chown(directory, entry.pw_uid, entry.pw_gid)
        os.chmod(directory, 0o700)

        jail = Jail(
            session_key=session_key,
            name=name,
            uid=entry.pw_uid,
            gid=entry.pw_gid,
            dir=directory,
        )
        _jails[session_key] = jail
        logger.info(
            "[jail] session %s -> %s uid=%s dir=%s (%d/%d slots)",
            session_key[:8], name, entry.pw_uid, directory, len(_jails), MAX_SESSIONS,
        )
        return jail


def get(session_key: str) -> Optional[Jail]:
    """回傳既有的 Jail，不建立新的。"""
    try:
        session_key = _validate_session_key(session_key)
    except JailError:
        return None
    with _lock:
        jail = _jails.get(session_key)
        if jail is not None:
            jail.last_used = time.time()
        return jail


def touch(session_key: str) -> None:
    get(session_key)


def release(session_key: str) -> None:
    """session 結束：殺行程、刪帳號、刪 scratch 目錄。"""
    with _lock:
        jail = _jails.pop(session_key, None)
    if jail is None:
        return
    logger.info("[jail] releasing %s (uid=%s)", jail.name, jail.uid)
    _delete_account(jail.name, jail.uid, jail.dir)


def reap_idle(now: Optional[float] = None) -> int:
    """回收閒置過久的 session。回傳回收數量。"""
    now = now if now is not None else time.time()
    with _lock:
        stale = [
            key
            for key, jail in _jails.items()
            if now - jail.last_used > IDLE_TIMEOUT_SECONDS
        ]
    for key in stale:
        release(key)
    return len(stale)


def reap_orphans() -> int:
    """啟動時清掉前一次執行留下的帳號與目錄。

    scratch 依設計不含任何持久資料（架構 ④），所以無條件清除是安全的，
    而且是必要的——否則重啟後殘留帳號會一直佔用併發額度。
    """
    if _missing_prerequisites():
        return 0

    removed = 0
    for entry in pwd.getpwall():
        if not entry.pw_name.startswith(ACCOUNT_PREFIX):
            continue
        logger.info("[jail] reaping orphaned account %s", entry.pw_name)
        _delete_account(entry.pw_name, entry.pw_uid, SCRATCH_ROOT / entry.pw_name)
        removed += 1

    if SCRATCH_ROOT.is_dir():
        for child in SCRATCH_ROOT.iterdir():
            if child.name.startswith(ACCOUNT_PREFIX):
                shutil.rmtree(child, ignore_errors=True)
    return removed


def active_session_count() -> int:
    with _lock:
        return len(_jails)


# ---------------------------------------------------------------------------
# 命令封裝
# ---------------------------------------------------------------------------

def confine(jail: Optional[Jail], argv: List[str]) -> List[str]:
    """把 argv 包成「以 session 帳號、在 user+net namespace 內執行」的命令。

    jail 為 None（本機開發、隔離不可用）時原樣回傳。

    注意 setpriv 必須在 unshare 之前，理由見模組 docstring。
    """
    if jail is None:
        return list(argv)
    return [
        _SETPRIV,
        "--reuid", str(jail.uid),
        "--regid", str(jail.gid),
        "--clear-groups",
        "--",
        _UNSHARE,
        "--user",
        "--net",
        "--map-current-user",
        "--",
        _ENV,
        f"HOME={jail.dir}",
        f"TMPDIR={jail.dir}",
        *argv,
    ]


def chown_to_session(path: "str | Path", jail: Optional[Jail], mode: int = 0o600) -> None:
    """伺服器（root）寫進 scratch 的檔案要交給 session 帳號，
    否則以該帳號執行的編譯器／GDB 讀不到。

    透過 fd 而不是路徑操作：scratch 目錄是**不可信的 session 使用者**可寫的，
    直接 os.chown(path) 會跟著 symlink 走，等於給了一個 root 任意 chown。
    O_NOFOLLOW 讓 symlink 直接 ELOOP 失敗。
    """
    if jail is None:
        return
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        logger.exception("[jail] refusing to hand over %s (symlink?)", path)
        return
    try:
        os.fchown(fd, jail.uid, jail.gid)
        os.fchmod(fd, mode)
    except OSError:
        logger.exception("[jail] failed to hand %s to %s", path, jail.name)
    finally:
        os.close(fd)


def write_session_file(
    path: "str | Path", content: str, jail: Optional[Jail], mode: int = 0o600
) -> None:
    """以 root 身分把 content 寫進 session 的 scratch 目錄，並交給 session 帳號。

    這個目錄由不可信的 session 使用者持有，他的 C++ 程式可以在裡面放 symlink。
    普通的 open(path, "w") 會跟著 symlink 走，讓使用者程式把 root 的寫入導到
    /etc/ 底下任何檔案。O_NOFOLLOW 擋掉這件事；chown/chmod 走同一個 fd，
    中間沒有可以被替換的空窗。
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    try:
        os.write(fd, content.encode("utf-8"))
        if jail is not None:
            os.fchown(fd, jail.uid, jail.gid)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)
