import datetime
import logging
import os
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
        session_key: Optional[str] = None,
    ):
        self.command = command
        # 這個 debug session 綁到哪個隔離 session（jail）。session 結束時要一起清掉。
        self.session_key = session_key
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
        if self.session_key:
            try:
                jail_manager.release(self.session_key)
            except Exception:
                logger.exception(
                    "[jail] failed to release jail for session %s", self.session_key[:8]
                )

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
        self, *, desired_gdbpid: int, client_id: str
    ) -> DebugSession:
        debug_session = self.debug_session_from_pid(desired_gdbpid)

        if not debug_session:
            raise ValueError(f"No existing gdb process with pid {desired_gdbpid}")
        debug_session.add_client(client_id)
        self.debug_session_to_client_ids[debug_session].append(client_id)
        return debug_session

    def add_new_debug_session(
        self, *, gdb_command: str, mi_version: str, client_id: str,
        exec_wrapper: Optional[str] = None,
        session_key: Optional[str] = None,
    ) -> DebugSession:
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
            session_key=session_key if jail is not None else None,
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

    def remove_debug_session_by_pid(self, gdbpid: int) -> List[str]:
        debug_session = self.debug_session_from_pid(gdbpid)
        if debug_session:
            orphaned_client_ids = self.remove_debug_session(debug_session)
        else:
            logger.info(f"could not find debug session with gdb pid {gdbpid}")
            orphaned_client_ids = []
        return orphaned_client_ids

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

    def get_dashboard_data(self) -> List[DebugSession]:
        return [
            debug_session.to_dict()
            for debug_session in self.debug_session_to_client_ids.keys()
        ]

    def disconnect_client(self, client_id: str):
        for debug_session, client_ids in self.debug_session_to_client_ids.items():
            if client_id in client_ids:
                client_ids.remove(client_id)
                debug_session.remove_client(client_id)
        self.remove_debug_sessions_with_no_clients()
