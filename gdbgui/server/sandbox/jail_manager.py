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
        env -i PATH=… HOME=<scratch> TMPDIR=<scratch>  ← 空環境，只給必要的三個
          <實際命令>

順序是有意義的，**不可對調**：`unshare --user` 之後 uid 對映會失效，
`setpriv` 再降權到一個未對映的 uid 會失敗。

## 為什麼是 `env -i`（環境變數也是一條資料邊界）

`env` 沒有 `-i` 的話子行程會**繼承伺服器整份環境**。被關進去的東西裡有
使用者自己編譯出來的程式，而它以該 session 的帳號執行——它讀得到自己的
`/proc/self/environ`，也就是說任何登入者用三行 `getenv()` 就能把伺服器的
`NVIDIA_API_KEY` / `LESSON_AI_API_KEY` 印出來。降權與 namespace 擋不住這件事，
因為那些值是**跟著 exec 一起交到它手上的**。

所以改成從空環境出發，白名單只有 `PATH`（見 `_ENV_PASSTHROUGH`）。
實測（本專案 image）在只有 PATH/HOME/TMPDIR 的環境下：g++ 編譯與錯誤訊息
正常、gdb 的內嵌 Python 正常、`/etc/gdb/gdbinit` 照樣載入、libstdc++
pretty-printer 照樣輸出 `std::set with 5 elements = {…}`。
`TERM`／`LANG`／`LC_*` 本來就不在這個 image 的環境裡，沒有東西可以失去。

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

try:
    import fcntl
except ImportError:  # Windows：本模組在那裡本來就不作用（見 _missing_prerequisites）
    fcntl = None  # type: ignore[assignment]

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

#: 唯一從伺服器環境傳給被關住的子行程的變數。
#:
#: 這是白名單，不是黑名單：新加進 compose 的任何變數（包含金鑰）預設**不會**
#: 流進使用者的程式。要加東西進來，先問「使用者的 C++ 讀到它會怎樣」。
#:
#: PATH 在名單裡是因為 argv[0] 是 `g++` / `gdb` 這種相對名稱，要靠它解析
#: （GNU env 用**新**環境的 PATH 查表）。HOME 與 TMPDIR 不在名單裡——
#: 它們的值由 confine() 自己指定成 scratch 目錄，跟伺服器的值無關。
_ENV_PASSTHROUGH = ("PATH",)


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

#: 持有 scratch root 獨佔鎖的 fd（None = 本行程還沒拿到）。
#: 刻意是行程層級的狀態：鎖由核心綁在 open file description 上，行程死掉
#: （含被 kill、當掉）核心會自動釋放，不會留下需要人工清的殘留鎖。
_owner_lock_fd: Optional[int] = None


# ---------------------------------------------------------------------------
# scratch root 的獨佔擁有權
#
# reap_orphans() 是**破壞性**操作：它刪掉主機上所有 gdbs_* 帳號與 scratch 目錄，
# 也就是把當下每一個正在除錯的使用者踢下線。它唯一正當的使用時機是伺服器啟動、
# 且這台機器上沒有別的 gdbgui 在跑（清掉上一次執行的殘留）。
#
# 但它會被任何 import 到 run_server() 的東西觸發——tests/test_backend.py 在
# module import 時就呼叫 run_server(testing=True)，所以
# `docker compose exec gdbgui pytest tests/` 打在**正在服務的容器**上時，
# 測試會把線上使用者的帳號與檔案全部刪掉。（實測會發生。）
#
# 光在測試那邊加 guard 不夠：下一個測試檔一樣會踩到。真正的不變式要放在這裡——
# reap_orphans() 只有在**本行程獨佔擁有 SCRATCH_ROOT** 時才會動手，而擁有權
# 是一把 flock。活著的伺服器一直持有它，所以任何在旁邊跑起來的行程
# （測試、腳本、第二個伺服器）都拿不到，reap 就會拒絕執行並回 0。
# ---------------------------------------------------------------------------

#: 獨佔鎖檔。放在 SCRATCH_ROOT（root 擁有、0755）底下，session 帳號動不了它。
#: 名稱刻意不以 ACCOUNT_PREFIX 開頭，reap 的清掃迴圈才不會把它自己刪掉。
_OWNER_LOCK_NAME = ".scratch-root-owner.lock"


def _owner_lock_path() -> Path:
    return SCRATCH_ROOT / _OWNER_LOCK_NAME


def claim_scratch_root() -> bool:
    """試著取得 SCRATCH_ROOT 的獨佔擁有權，成功回傳 True。

    冪等：本行程已經持有就直接回 True。取得後**不釋放**（除非明確呼叫
    release_scratch_root()），鎖跟著行程的生命週期走。
    """
    global _owner_lock_fd
    if fcntl is None:
        return False
    with _lock:
        if _owner_lock_fd is not None:
            return True
        try:
            ensure_scratch_root()
            fd = os.open(str(_owner_lock_path()), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            logger.exception("[jail] could not open the scratch-root owner lock")
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            # 別的行程活著且持有它。
            os.close(fd)
            return False
        try:
            os.ftruncate(fd, 0)
            os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        except OSError:
            pass
        _owner_lock_fd = fd
        return True


def owns_scratch_root() -> bool:
    """本行程是否持有獨佔擁有權（不嘗試取得）。"""
    with _lock:
        return _owner_lock_fd is not None


def release_scratch_root() -> None:
    """放掉獨佔擁有權。正常運作不需要呼叫（行程結束核心會收），
    測試要模擬「換一個擁有者」時才用。"""
    global _owner_lock_fd
    with _lock:
        if _owner_lock_fd is not None:
            try:
                os.close(_owner_lock_fd)
            except OSError:
                pass
            _owner_lock_fd = None


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

    ★ 只有在本行程獨佔擁有 SCRATCH_ROOT 時才會動手 ★
    見上方「scratch root 的獨佔擁有權」。這裡是那條不變式的唯一守門處：
    只要有另一個活著的 gdbgui 持有鎖（正在服務的伺服器），本函式一律拒絕
    並回 0，絕不去刪別人正在用的帳號與檔案。呼叫端不需要（也不該）自己判斷。
    """
    if _missing_prerequisites():
        return 0

    if not claim_scratch_root():
        logger.warning(
            "[jail] refusing to reap orphaned sessions: another live process owns %s. "
            "This is the guard that stops a test run from wiping a serving deployment.",
            SCRATCH_ROOT,
        )
        return 0

    with _lock:
        live = len(_jails)
    if live:
        # 只有「啟動時清上一次執行的殘留」這一個正當用途，那時候 _jails 必然是空的。
        # 已經有活著的 session 還來 reap，就是把自己的使用者砍掉（run_server()
        # 被重複呼叫時會發生），一律拒絕。
        logger.warning(
            "[jail] refusing to reap orphaned sessions: %d session(s) are live in "
            "this process", live,
        )
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

def child_environment(jail: Jail) -> List[str]:
    """被關住的子行程看到的**完整**環境，寫成 `NAME=VALUE` 的清單。

    這裡回傳的就是全部——`confine()` 用 `env -i` 起頭，沒列在這裡的東西
    一律不存在。理由見模組 docstring 的「為什麼是 `env -i`」。
    """
    env = [f"HOME={jail.dir}", f"TMPDIR={jail.dir}"]
    for name in _ENV_PASSTHROUGH:
        value = os.environ.get(name)
        if value:
            env.append(f"{name}={value}")
    if not any(item.startswith("PATH=") for item in env):
        # 伺服器自己沒有 PATH 的極端情況：給一個能找到 g++/gdb 的預設，
        # 不要讓子行程落到「完全沒有 PATH」而 exec 失敗。
        env.append(f"PATH={os.defpath}")
    return env


def confine(jail: Optional[Jail], argv: List[str]) -> List[str]:
    """把 argv 包成「以 session 帳號、在 user+net namespace 內、從空環境執行」的命令。

    jail 為 None（本機開發、隔離不可用）時原樣回傳。

    注意 setpriv 必須在 unshare 之前，理由見模組 docstring。
    `env -i` 也不是可有可無的裝飾，理由同上。
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
        "-i",
        *child_environment(jail),
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
