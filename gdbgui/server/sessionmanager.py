import datetime
import logging
import os
import secrets
import shlex
import signal
import stat
import time
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set

from pygdbmi.IoManager import IoManager

from .ptylib import Pty
from .sandbox import jail_manager

# sandbox wrapper.sh 路徑（同 package 下的 sandbox/ 子目錄）
_SANDBOX_WRAPPER = Path(__file__).parent / "sandbox" / "wrapper.sh"

logger = logging.getLogger(__name__)

#: 每一次被拒絕的 attach 都回這一句，**不區分**「這個 pid 不存在」與
#: 「這個 pid 存在但不是你的」。gdbpid 是小整數、可列舉，只要兩者的回應
#: 有任何差別，這個端點就變成「哪些 pid 是別人正在跑的 GDB」的 oracle，
#: 攻擊者可以先掃出目標再去想辦法。兩條路徑必須完全同形。
ATTACH_REFUSED_MESSAGE = "No debug session is available with that id"


def _reap(pid: int, attempts: int = 20, interval: float = 0.05) -> None:
    """收掉 pty.fork() 出來的子行程，避免留下 zombie。

    這個行程是 GDB 的直接父行程，不 waitpid 的話每個結束的 debug session 都會
    留一個 <defunct>，永久佔用一個 PID。配上 compose 的 pids_limit 與 200 個帳號，
    累積下來就是可用性問題；而且 zombie 還會讓 jail 的清理「看起來」失敗
    （帳號與目錄都刪了，ps 裡卻還看得到那個 uid 的行程）。
    """
    for _ in range(attempts):
        try:
            reaped, _status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return  # 已經被收走了
        except OSError:
            return
        if reaped == pid:
            return
        time.sleep(interval)
    logger.warning("[sandbox] pid %s did not exit; it may linger as a zombie", pid)


class DebugSession:
    def __init__(
        self,
        *,
        pygdbmi_controller: IoManager,
        pty_for_gdbgui: Pty,
        pty_for_gdb: Pty,
        pty_for_debugged_program: Pty,
        command: str,
        mi_version: str,
        pid: int,
        owner_key: Optional[str] = None,
        jail_key: Optional[str] = None,
    ):
        self.command = command
        # ── 授權用的擁有者身分 ──────────────────────────────────────────────
        # 誰可以 attach 到這個 debug session。目前的來源是 Flask session 的
        # uploaded_prefix（也就是 jail 用的同一把 key，見 http_util.owner_key）。
        # 之後接上登入時，只要改 http_util.owner_key() 的回傳來源成 user id，
        # 這裡與所有授權判斷都不用動 —— is_owned_by() 是唯一的判斷點。
        #
        # 刻意與 jail_key 分開兩個欄位：jail_key 只在真的有隔離時才有值
        # （本機無隔離開發時是 None），但「誰擁有這個 session」必須在兩種
        # 環境下都成立，不能因為沒有 jail 就退化成「大家都可以 attach」。
        self.owner_key = owner_key
        # 這個 debug session 綁到哪個隔離 session（jail）。session 結束時要一起清掉。
        self.jail_key = jail_key
        self.pygdbmi_controller = pygdbmi_controller
        self.pty_for_gdbgui = pty_for_gdbgui
        self.pty_for_gdb = pty_for_gdb
        self.pty_for_debugged_program = pty_for_debugged_program
        self.mi_version = mi_version
        self.pid = pid
        self.start_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.client_ids: Set[str] = set()
        # Token tied to the current compilation/run session; validated on every GDB command.
        self.run_token: Optional[str] = None
        self.last_request_id: int = 0
        self.packet_seq_num: int = 0

    def terminate(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except Exception as e:
                logger.error(f"Failed to kill pid {self.pid}: {str(e)}")
            _reap(self.pid)

        self.pygdbmi_controller = None

        # SIGKILL 不給 GDB 收尾的機會，被除錯的 inferior 可能變成孤兒。
        # release() 會 pkill 該 session uid 的所有行程，再刪帳號與 scratch 目錄，
        # 所以清理不依賴 GDB 自己乖乖結束。
        if self.jail_key:
            try:
                jail_manager.release(self.jail_key)
            except Exception:
                logger.exception(
                    "[jail] failed to release jail for session %s", self.jail_key[:8]
                )

    def is_owned_by(self, owner_key: Optional[str]) -> bool:
        """這個 debug session 是不是屬於 owner_key？

        Fail closed：沒有記錄擁有者的 session（例如單元測試裡不帶 key 建立的）
        不屬於任何人，誰都 attach 不上去。空的 owner_key 同理 —— 「我沒有身分」
        絕不能等於「我符合沒有擁有者的那個 session」。

        用 compare_digest 而不是 ==：owner key 是 secret（uuid4 hex），
        逐字元短路比較會洩漏前綴資訊。
        """
        if not self.owner_key or not owner_key:
            return False
        try:
            return secrets.compare_digest(self.owner_key, owner_key)
        except TypeError:
            # compare_digest 對非 ASCII 的 str 會丟 TypeError。不該發生
            # （key 是伺服器自己產的 uuid4 hex），但如果發生了要當成「不符合」，
            # 不是讓例外從授權檢查裡冒出去變成別的行為。
            logger.warning("[authz] non-ascii owner key rejected")
            return False

    def to_dict(self):
        return {
            "pid": self.pid,
            "start_time": self.start_time,
            "command": self.command,
            "c2": "hi",
            "client_ids": list(self.client_ids),
        }

    def add_client(self, client_id: str):
        self.client_ids.add(client_id)

    def remove_client(self, client_id: str):
        self.client_ids.discard(client_id)
        if len(self.client_ids) == 0:
            self.terminate()


class SessionManager(object):
    def __init__(self):
        self.debug_session_to_client_ids: Dict[DebugSession, List[str]] = defaultdict(
            list
        )  # key is controller, val is list of client ids

        self.gdb_reader_thread = None
        # Maps csrf_token → run_token so WebSocket handlers can validate without Flask session cookie lag.
        self.run_tokens: Dict[str, str] = {}

    def connect_client_to_debug_session(
        self, *, desired_gdbpid: int, client_id: str, owner_key: Optional[str]
    ) -> DebugSession:
        """把一個 websocket client 接到既有的 debug session 上。

        desired_gdbpid 直接來自 request.args，完全由呼叫端控制，所以這裡一定
        要驗擁有者。attach 上去就等於取得那個 GDB 的完整控制權（讀對方記憶體、
        下任意 GDB 指令、在對方的 jail 裡執行程式），而 pid 是可列舉的小整數。

        owner_key 是必填的 keyword，沒有預設值 —— 未來新增呼叫端時會被
        TypeError 擋下來，而不是安靜地跳過授權。
        """
        debug_session = self.debug_session_from_pid(desired_gdbpid)

        if debug_session is None or not debug_session.is_owned_by(owner_key):
            # 這一行只進伺服器 log，不會回給對方 —— 偵測用的細節留在這邊，
            # 送出去的訊息維持同形。
            logger.warning(
                "[authz] refused attach to gdbpid %s (session exists: %s)",
                desired_gdbpid,
                debug_session is not None,
            )
            # 「不存在」與「不是你的」共用同一個例外與同一句訊息，見
            # ATTACH_REFUSED_MESSAGE。不要在這裡加上 pid 或任何條件式細節。
            raise ValueError(ATTACH_REFUSED_MESSAGE)
        debug_session.add_client(client_id)
        self.debug_session_to_client_ids[debug_session].append(client_id)
        return debug_session

    def debug_session_from_owner(self, owner_key: Optional[str]) -> Optional[DebugSession]:
        """owner_key 目前還活著的 debug session（沒有就 None）。

        「一個使用者一個 debug session」用的：第二個分頁不再另外開一個 GDB，
        而是 attach 到第一個。每個 GDB 大約 21 MB 容器記憶體，200 個帳號的
        部署下分頁數量會直接變成記憶體上限問題。

        已經 terminate 但還沒從簿記中移除的 session（pygdbmi_controller 為
        None）不算數 —— 重用一個死掉的 GDB 會讓第二個分頁停在一個永遠不回應
        的 session。
        """
        if not owner_key:
            return None
        for debug_session in list(self.debug_session_to_client_ids):
            if debug_session.pygdbmi_controller is None:
                continue
            if debug_session.is_owned_by(owner_key):
                return debug_session
        return None

    def debug_sessions_owned_by(self, owner_key: Optional[str]) -> List[DebugSession]:
        """owner_key 擁有的所有 debug session。dashboard 與 kill 用。"""
        if not owner_key:
            return []
        return [
            debug_session
            for debug_session in list(self.debug_session_to_client_ids)
            if debug_session.is_owned_by(owner_key)
        ]

    def add_new_debug_session(
        self, *, gdb_command: str, mi_version: str, client_id: str,
        exec_wrapper: Optional[str] = None,
        session_key: Optional[str] = None,
    ) -> DebugSession:
        """開一個新的 GDB。

        session_key 同時是**擁有者身分**與 jail 的 key（來源見
        http_util.owner_key）。刻意共用一把 key，不另外發明一組平行身分。
        """
        pty_for_debugged_program = Pty(echo=False)
        pty_for_gdbgui = Pty(echo=False)
        gdbgui_startup_cmds = [
            f"new-ui {mi_version} {pty_for_gdbgui.name}",
            f"set inferior-tty {pty_for_debugged_program.name}",
            "set pagination off",
        ]

        # exec-wrapper 現在只負責 ulimit（見 sandbox/wrapper.sh）。
        # 降權與 namespace 隔離發生在更外層 —— GDB 自己就跑在裡面，
        # 因為跨 uid / 跨 user namespace 的 ptrace 就算給 CAP_SYS_PTRACE 也不會動。
        try:
            wp = Path(exec_wrapper) if exec_wrapper else _SANDBOX_WRAPPER
            if wp.exists():
                current_mode = wp.stat().st_mode
                wanted = current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
                if current_mode != wanted:
                    # session 帳號要能執行它，o+x 是必要的
                    wp.chmod(wanted)
                gdbgui_startup_cmds.append(f"set exec-wrapper {wp}")
                logger.info(f"[sandbox] exec-wrapper: {wp}")
        except Exception as e:
            logger.warning(f"[sandbox] Could not set exec-wrapper: {e}")

        # 被除錯程式的 pty 由 root 建立，但 GDB 以 session 帳號執行，
        # 必須讓它開得起來才寫得出程式輸出。
        jail = jail_manager.get(session_key) if session_key else None

        # Fail closed。沒有 jail 就代表 GDB 與使用者程式會以 root、在沒有 network
        # namespace 的情況下執行——那正是這整個子專案要消滅的狀態，絕不能默默發生。
        if jail is None and jail_manager.REQUIRE_ISOLATION:
            raise RuntimeError(
                "refusing to start gdb without per-session isolation "
                f"(session_key={'set' if session_key else 'missing'})"
            )

        if jail is not None:
            for pty in (pty_for_debugged_program, pty_for_gdbgui):
                try:
                    os.chown(pty.name, jail.uid, jail.gid)
                    os.chmod(pty.name, 0o600)
                except OSError:
                    logger.exception("[jail] could not hand pty %s to session", pty.name)

        # instead of writing to the pty after it starts, add startup
        # commands to gdb. This allows gdb to be run as sudo and prompt for a
        # password, for example.
        gdb_argv = shlex.split(gdb_command)
        for cmd in gdbgui_startup_cmds:
            gdb_argv += ["-iex", cmd]

        full_argv = jail_manager.confine(jail, gdb_argv)
        pty_for_gdb = Pty(cmd=shlex.join(full_argv))

        pid = pty_for_gdb.pid
        debug_session = DebugSession(
            # 擁有者一律記錄下來（即使沒有 jail），jail_key 只有在真的建立了
            # 隔離時才有值 —— 只有那時候 terminate() 才需要去 release 它。
            owner_key=session_key,
            jail_key=session_key if jail is not None else None,
            pygdbmi_controller=IoManager(
                os.fdopen(pty_for_gdbgui.stdin, mode="wb", buffering=0),  # type: ignore
                os.fdopen(pty_for_gdbgui.stdout, mode="rb", buffering=0),  # type: ignore
                None,
            ),
            pty_for_gdbgui=pty_for_gdbgui,
            pty_for_gdb=pty_for_gdb,
            pty_for_debugged_program=pty_for_debugged_program,
            command=gdb_command,
            mi_version=mi_version,
            pid=pid,
        )
        debug_session.add_client(client_id)
        self.debug_session_to_client_ids[debug_session] = [client_id]
        return debug_session

    # 這裡以前有 remove_debug_session_by_pid(gdbpid)：使用者送什麼 pid 就殺什麼，
    # 沒有任何擁有者檢查。唯一的呼叫端 /kill_session 現在自己先做擁有者檢查再呼叫
    # remove_debug_session()，所以這個「拿 pid 直接殺」的原語被刻意移除，
    # 免得日後有人再接回去而漏掉授權。

    def remove_debug_session(self, debug_session: DebugSession) -> List[str]:
        logger.info(f"Removing debug session for pid {debug_session.pid}")
        try:
            debug_session.terminate()
        except Exception:
            logger.error(traceback.format_exc())
        orphaned_client_ids = self.debug_session_to_client_ids.pop(debug_session, [])
        return orphaned_client_ids

    def remove_debug_sessions_with_no_clients(self) -> None:
        to_remove = []
        for debug_session, _ in self.debug_session_to_client_ids.items():
            if len(debug_session.client_ids) == 0:
                to_remove.append(debug_session)
        for debug_session in to_remove:
            self.remove_debug_session(debug_session)

    def get_pid_from_debug_session(self, debug_session: DebugSession) -> Optional[int]:
        if debug_session and debug_session.pid:
            return debug_session.pid
        return None

    def debug_session_from_pid(self, pid: int) -> Optional[DebugSession]:
        for debug_session in self.debug_session_to_client_ids:
            this_pid = self.get_pid_from_debug_session(debug_session)
            if this_pid == pid:
                return debug_session
        return None

    def debug_session_from_client_id(self, client_id: str) -> Optional[DebugSession]:
        for debug_session, client_ids in self.debug_session_to_client_ids.items():
            if client_id in client_ids:
                return debug_session
        return None

    def get_dashboard_data(self, *, owner_key: Optional[str]) -> List[dict]:
        """dashboard 只列出呼叫者自己的 debug session。

        以前它列出**所有人**的 pid、啟動時間與 websocket id。就算 attach 已經
        擋住了，把別人的 gdbpid 列出來仍然是替攻擊者省掉列舉的工，也讓
        「pid 存不存在」這件事重新變得可觀察。owner_key 一樣是必填 keyword。
        """
        return [
            debug_session.to_dict()
            for debug_session in self.debug_sessions_owned_by(owner_key)
        ]

    def disconnect_client(self, client_id: str):
        for debug_session, client_ids in self.debug_session_to_client_ids.items():
            if client_id in client_ids:
                client_ids.remove(client_id)
                debug_session.remove_client(client_id)
        self.remove_debug_sessions_with_no_clients()
