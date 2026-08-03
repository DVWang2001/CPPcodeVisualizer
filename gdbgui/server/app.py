import logging
import os
from typing import Dict, List
import traceback
from flask import Flask, abort, request, session

# python-engineio 4.10+ 將 max_decode_packets 改為 1（強制 v4 協議），
# 但瀏覽器 socket.io client 仍會批次送多個封包，造成大量 ValueError。
# 用兩層防禦：class attribute + monkey-patch decode，確保各版本都能正常。
try:
    from engineio import payload as _eio_payload

    # 層 1：直接設 class attribute（舊版有效）
    if hasattr(_eio_payload.Payload, 'max_decode_packets'):
        _eio_payload.Payload.max_decode_packets = 500

    # 層 2：替換 decode，移除 packet 數量上限檢查（新版有效）
    _orig_payload_decode = _eio_payload.Payload.decode

    def _patched_payload_decode(self, encoded_payload):
        # 暫時把 class attribute 調高（有些版本在方法內讀 self.__class__）
        _cls = type(self)
        _old = getattr(_cls, 'max_decode_packets', None)
        try:
            _cls.max_decode_packets = 500
            return _orig_payload_decode(self, encoded_payload)
        except ValueError as exc:
            if 'Too many packets' in str(exc):
                pass  # 忽略，直接回傳已解析的部分
            else:
                raise
        finally:
            if _old is not None:
                _cls.max_decode_packets = _old

    _eio_payload.Payload.decode = _patched_payload_decode
except Exception:
    pass
from flask_compress import Compress  # type: ignore
from flask_socketio import SocketIO, emit  # type: ignore

from . import auth, db, live_quiz
from .constants import DEFAULT_GDB_EXECUTABLE, STATIC_DIR, TEMPLATE_DIR
from .http_routes import blueprint
from .http_util import CSRF_EXEMPT_ENDPOINTS, is_cross_origin, owner_key, require_login
from .sandbox import jail_manager
from .sessionmanager import SessionManager, DebugSession

logger = logging.getLogger(__file__)
# Create flask application and add some configuration keys to be used in various callbacks
app = Flask(__name__, template_folder=str(TEMPLATE_DIR), static_folder=str(STATIC_DIR))
Compress(
    app
)  # add gzip compression to Flask. see https://github.com/libwilliam/flask-compress
app.register_blueprint(blueprint)
app.register_blueprint(auth.blueprint)
app.register_blueprint(live_quiz.blueprint)
app.config["initial_binary_and_args"] = []
app.config["gdb_path"] = DEFAULT_GDB_EXECUTABLE
app.config["gdb_command"] = None
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["project_home"] = None
app.config["remap_sources"] = {}
app.config["MOBILE_JOIN_BASE_URL"] = os.environ.get("MOBILE_JOIN_BASE_URL", "")
# 每個 session 的 scratch 目錄放在這底下。有隔離時是 container-local 的
# SCRATCH_ROOT（刻意不掛共用 volume：user namespace 的 uid 對映會讓
# namespace 內外的檔案所有權不一致）；沒有隔離的本機開發才退回 uploads/。
app.config["upload_folder"] = (
    str(jail_manager.SCRATCH_ROOT)
    if jail_manager.isolation_available()
    else os.path.join(app.root_path, "uploads")
)
manager = SessionManager()
app.config["_manager"] = manager

# 資料庫：建立資料目錄（0700）並套用 migration。必須在讀 SECRET_KEY 之前。
db.initialize()

# 這裡以前是 `binascii.hexlify(os.urandom(24))`——每次啟動換一把新鑰匙，所有
# session 立刻失效。沒有登入時無所謂；有了登入之後，那代表每次部署或重啟都把
# 所有人登出。金鑰現在活在 0600 的檔案裡、放在 0700 的資料目錄底下，那個目錄
# 不在任何 session 帳號讀得到的地方（見 db.py 的模組說明）。
app.secret_key = db.get_or_create_secret_key()

# HttpOnly 是 Flask 預設；SameSite=Lax 讓瀏覽器不會在跨站的 POST 帶上 cookie，
# 疊在既有的全域 CSRF token 檢查之上，一行、零成本。
# Secure 要靠 HTTPS，而目前的部署是 http://；用環境變數開，預設不開（開了會
# 讓 http 部署完全無法登入，那是比缺一個旗標更糟的失效模式）。
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("GDBGUI_SECURE_COOKIES") == "1"

# ── 請求本體的全域上限 ────────────────────────────────────────────────────────
#
# 沒有這一條的話，一個「Content-Length: 2 GB」的請求就是一台單請求全站中斷機：
# `request.get_json()` / `request.files` 會把整份 body 讀進記憶體之後，才輪到任何
# 路由層的驗證。部署是單容器、eventlet 單 worker、`mem_limit: 3g`，compose 裡沒有
# 反向代理替我們擋 body，而註冊是開放的——攻擊者資格免費。
#
# 刻意訂在**全域**而不是逐路由補：同樣的洞現在至少還在 http_routes 的
# explain_error、generate_lesson 與 /upload 的 request.files 三處，只補一條會讓
# 下一個人以為這件事已經想過了。之後新增、作者沒想過這件事的路由也自動受保護。
#
# 16 MB 是「擋得住 OOM」與「不弄壞 /upload」之間的取捨：/upload 收的是編譯後的
# 執行檔，帶除錯符號的 C++ binary 輕易好幾 MB，上限訂太低會讓正常使用失敗。
#
# http_routes._lesson_payload() 既有的 512 KB 檢查**保留不動**：它比較嚴，繼續
# 當教案路由自己的上限。這一條是所有路由的地板，不是誰的替代品。
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

socketio = SocketIO(manage_session=False)
live_quiz.register_socket_handlers(socketio)


@app.before_request
def csrf_protect_all_post_and_cross_origin_requests():
    """returns None upon success"""
    success = None
    if is_cross_origin(request):
        logger.warning("Received cross origin request. Aborting")
        abort(403)
    if request.endpoint in CSRF_EXEMPT_ENDPOINTS:
        return success
    # DELETE 加進來的理由與 POST/PUT 完全一樣：它會改變伺服器狀態
    # （/api/lessons/<id> 是硬刪除）。跨站的 DELETE 目前還被另外兩層擋著
    # （SameSite=Lax 不帶 cookie、上面的 is_cross_origin 會 403），但一個
    # 「只保護部分變更方法」的 CSRF 閘門遲早會在有人加第五條路由時漏掉。
    if request.method in ["POST", "PUT", "DELETE", "PATCH"]:
        server_token = session.get("csrf_token")
        if not isinstance(server_token, str) or not server_token:
            # session 裡沒有 token 時，底下每一個 `server_token == X` 都會在
            # 「請求也沒帶」的情況下變成 None == None 而放行。已登入的 session
            # 一定有 token（start_user_session 會種），所以這條只會擋到未登入的
            # 請求——但一個「兩邊都沒有就算通過」的比對不該存在。
            logger.warning("Received a state-changing request with no session token")
            abort(403)
        if server_token == request.form.get("csrf_token"):
            return success
        elif server_token == request.environ.get("HTTP_X_CSRFTOKEN"):
            return success
        else:
            # get_json(silent=True) 而不是 request.json：後者在 Content-Type
            # 不是 application/json 時會丟 415，於是「CSRF token 不對」與
            # 「body 不是 JSON」變成兩種不同的失敗，而且 415 比 403 難查。
            # 判斷本身沒有放寬——token 仍然必須完全相等才放行。
            body = request.get_json(silent=True)
            if isinstance(body, dict) and server_token == body.get("csrf_token"):
                return success
            logger.warning("Received invalid csrf token. Aborting")
            abort(403)


# ── 全站登入閘門 ──────────────────────────────────────────────────────────────
#
# **預設拒絕。** 白名單只有 /login、/register、/logout 與靜態資源
# （http_util.PUBLIC_ENDPOINTS）；其餘所有已註冊路由——包含之後才加上去、
# 作者忘了想這件事的那些——一律要求登入。
#
# 註冊在 CSRF 檢查**之後**：跨來源與 CSRF token 先驗，未登入者因此也不會有一條
# 繞過那兩道檢查的捷徑。
#
# 這不是第二套認證機制，是同一套的另一個掛載點：它與 @authenticate 裝飾器共用
# http_util.current_user_id() 這一個判斷（說明見 http_util）。
app.before_request(require_login)


@socketio.on("connect", namespace="/gdb_listener")
def client_connected():
    """Connect a websocket client to a debug session

    This is the main intial connection.

    Depending on the arguments passed, the client will connect
    to an existing debug session, or create a new one.
    A message is a emitted back to the client with details on
    the debug session that was created or connected to.
    """
    if is_cross_origin(request):
        logger.warning("Received cross origin request. Aborting")
        abort(403)

    # ── 身分優先 ────────────────────────────────────────────────────────────
    #
    # HTTP 擋住而 websocket 沒擋等於沒擋：驅動 GDB 的就是這條連線。這裡以前只
    # 檢查 CSRF token，而 CSRF token 是**任何**訪客 GET 一次頁面就拿得到的東西
    # ——它證明「這個請求來自這個瀏覽器的 session」，不證明「這個 session 是
    # 誰」。少了下面這一段，未登入者仍然可以開 websocket、配置一個 jail、
    # 啟動 GDB 並執行任意編譯出來的程式。
    #
    # 在 CSRF 檢查之前做：先問「你是誰」，再問「這個請求是不是你送的」。
    #
    # 回傳 False 才是真的拒絕連線（只 emit 的話 socket 仍然是連上的，後續的
    # run_gdb_command / pty_interaction 事件照樣進得來）。
    session_key = owner_key()
    if session_key is None:
        logger.warning("[authz] refused unauthenticated websocket connection")
        emit("server_error", {"message": "請先登入。"})
        return False

    csrf_token = request.args.get("csrf_token")
    if csrf_token is None:
        logger.warning("Recieved invalid csrf token")
        emit("server_error", {"message": "Recieved invalid csrf token"})
        return

    elif csrf_token != session.get("csrf_token"):
        # this can happen fairly often, so log debug message, not warning
        logger.debug(
            "Recieved invalid csrf token %s (expected %s)"
            % (csrf_token, str(session.get("csrf_token")))
        )
        emit(
            "server_error", {"message": "Session expired. Please refresh this webpage."}
        )
        return

    # session_key（＝本次連線的擁有者身分）已經在最上面取好了：attach 授權與
    # 「一人一個 debug session」都以它為準，來源只有 http_util.owner_key() 一處。
    # 不要在這裡重新取一次。

    try:
        desired_gdbpid = int(request.args.get("gdbpid", 0))
    except (TypeError, ValueError):
        desired_gdbpid = 0

    if not desired_gdbpid:
        # 一個使用者一個 debug session：同一個 Flask session 開第二個分頁時
        # 不再另外起一個 GDB（每個約 21 MB 容器記憶體，且兩者共用同一個 jail
        # 帳號），而是接到既有的那一個上，兩個分頁看到同一個 session。
        #
        # 這裡帶出來的 pid 是伺服器自己查到的、屬於本 session 的，不是使用者
        # 送上來的，但底下仍然走同一條有授權檢查的路徑，不開後門。
        existing = manager.debug_session_from_owner(session_key)
        if existing is not None:
            desired_gdbpid = existing.pid

    try:
        if desired_gdbpid:
            # connect to existing debug session（需通過擁有者檢查）
            debug_session = manager.connect_client_to_debug_session(
                desired_gdbpid=desired_gdbpid,
                client_id=request.sid,
                owner_key=session_key,
            )
            # attach 不佔用新的併發額度，但要讓 jail 的閒置計時器知道這個
            # session 還活著，否則長時間只有第二個分頁在用會被 reap 掉。
            if session_key:
                jail_manager.touch(session_key)
            emit(
                "debug_session_connection_event",
                {
                    "ok": True,
                    "started_new_gdb_process": False,
                    "pid": debug_session.pid,
                    "message": f"Connected to existing gdb process {debug_session.pid}",
                },
            )
        else:
            # start new debug session.
            #
            # gdb_command 一律取伺服器端設定，**不接受** request.args。
            # 它會被 shlex.split 後直接 execvp，以前等於讓任何連上 websocket 的人
            # 指定要執行哪個程式；前端本來就只是把伺服器發下去的值原封送回來。
            gdb_command = app.config["gdb_command"]
            mi_version = request.args.get("mi_version", "mi2")

            # session_key 就是上面那一個 owner_key()；不要在這裡重新取一次身分。
            try:
                if session_key:
                    jail_manager.acquire(session_key)
            except jail_manager.TooManySessions as e:
                logger.warning("[jail] refusing new debug session: %s", e)
                emit(
                    "debug_session_connection_event",
                    {
                        "ok": False,
                        "message": (
                            "伺服器同時執行的除錯 session 已達上限，請稍後再試。"
                            " (server is at its concurrent debug-session limit)"
                        ),
                    },
                )
                return
            except jail_manager.JailError:
                logger.exception("[jail] could not establish execution isolation")
                emit(
                    "debug_session_connection_event",
                    {
                        "ok": False,
                        "message": "無法建立執行隔離環境，已拒絕啟動除錯 session。",
                    },
                )
                return

            debug_session = manager.add_new_debug_session(
                gdb_command=gdb_command,
                mi_version=mi_version,
                client_id=request.sid,
                exec_wrapper=session.get("exec_wrapper"),
                session_key=session_key,
            )
            emit(
                "debug_session_connection_event",
                {
                    "ok": True,
                    "started_new_gdb_process": True,
                    "message": f"Started new gdb process, pid {debug_session.pid}",
                    "pid": debug_session.pid,
                },
            )
    except Exception as e:
        emit(
            "debug_session_connection_event",
            {"message": f"Failed to establish gdb session: {e}", "ok": False},
        )

    # Make sure there is a reader thread reading. One thread reads all instances.
    if manager.gdb_reader_thread is None:
        manager.gdb_reader_thread = socketio.start_background_task(
            target=read_and_forward_gdb_and_pty_output
        )
        logger.info("Created background thread to read gdb responses")


@socketio.on("pty_interaction", namespace="/gdb_listener")
def pty_interaction(message):
    """Write a character to the user facing pty"""
    debug_session = manager.debug_session_from_client_id(request.sid)
    if not debug_session:
        emit(
            "error_running_gdb_command",
            {"message": f"no gdb session available for client id {request.sid}"},
        )
        return

    try:
        data = message.get("data")
        pty_name = data.get("pty_name")
        if pty_name == "user_pty":
            pty = debug_session.pty_for_gdb
        elif pty_name == "program_pty":
            pty = debug_session.pty_for_debugged_program
        else:
            raise ValueError(f"Unknown pty: {pty_name}")

        action = data.get("action")
        if action == "write":
            key = data["key"]
            pty.write(key)
        elif action == "flush":
            import termios as _termios
            try:
                # TCOFLUSH on master only discards data before the line discipline;
                # data already in the slave's canonical input buffer needs TCIFLUSH
                # applied to the slave fd (opened by name).
                slave_fd = os.open(pty.name, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                try:
                    _termios.tcflush(slave_fd, _termios.TCIFLUSH)
                finally:
                    os.close(slave_fd)
            except Exception:
                pass
        elif action == "set_winsize":
            pty.set_winsize(data["rows"], data["cols"])
        else:
            raise ValueError(f"Unknown action {action}")
    except Exception:
        err = traceback.format_exc()
        logger.error(err)
        emit("error_running_gdb_command", {"message": err})


@socketio.on("run_gdb_command", namespace="/gdb_listener")
def run_gdb_command(message: Dict[str, str]):
    """Write commands to gdbgui's gdb mi pty"""
    client_id = request.sid  # type: ignore
    debug_session = manager.debug_session_from_client_id(client_id)
    if not debug_session:
        emit("error_running_gdb_command", {"message": "no session"})
        return

    # Validate run_token: only enforce after the first compile (when a token exists).
    client_token = message.get("run_token")
    csrf_key = session.get("csrf_token", "")
    expected_token = manager.run_tokens.get(csrf_key)
    if expected_token is not None:
        if client_token != expected_token:
            # 每次按下 start 時都會產生不同的雜湊值 (run_token)，
            # 若收到不同次編譯時舊的指令請求，直接忽略，避免讓使用者連線階段過期
            #
            # warning 而非 info：丟棄命令對前端是完全靜默的——它會一直等到自己的
            # 10 秒逾時（GdbApi.waiting_for_response），使用者只看到播放莫名卡住。
            # 這件事發生時一定要在伺服器 log 看得見。
            logger.warning(
                "Dropped stale gdb command: token=%r expected=%r cmds=%r",
                client_token,
                expected_token,
                message.get("cmd"),
            )
            return
        debug_session.run_token = client_token

    req_id = message.get("request_id")
    if req_id is not None:
        debug_session.last_request_id = req_id

    pty_mi = debug_session.pygdbmi_controller
    if pty_mi is not None:
        try:
            # the command (string) or commands (list) to run
            cmds = message["cmd"]
            for cmd in cmds:
                pty_mi.write(
                    cmd + "\n",
                    timeout_sec=0,
                    raise_error_on_timeout=False,
                    read_response=False,
                )

        except Exception:
            err = traceback.format_exc()
            logger.error(err)
            emit("error_running_gdb_command", {"message": err})
    else:
        emit("error_running_gdb_command", {"message": "gdb is not running"})


def send_msg_to_clients(client_ids, msg, error=False, run_token=None):
    """Send message to all clients"""
    if error:
        stream = "stderr"
    else:
        stream = "stdout"

    response = [{"message": None, "type": "console", "payload": msg, "stream": stream}]

    for client_id in client_ids:
        logger.info("emiting message to websocket client id " + client_id)
        debug_session = manager.debug_session_from_client_id(client_id)
        req_id = 0
        pkt_seq = 0
        if debug_session:
            req_id = debug_session.last_request_id
            debug_session.packet_seq_num += 1
            pkt_seq = debug_session.packet_seq_num

        socketio.emit(
            "gdb_response",
            {
                "run_token": run_token,
                "request_id": req_id,
                "packet_seq_num": pkt_seq,
                "data": response,
            },
            namespace="/gdb_listener",
            room=client_id,
        )


@socketio.on("disconnect", namespace="/gdb_listener")
def client_disconnected(reason=None):
    """A websocket went away: drop that client from its debug session.

    reason= 是 python-socketio 5.x 傳進來的。舊簽章（不收參數）之所以還能動，
    只是因為 socketio 在 TypeError 之後會退回 legacy 的單參數呼叫；這條清理路徑
    太重要（少了它 GDB 行程與 jail 都不會被回收），不該靠那個 fallback 活著。

    這裡只移除這一個 client。debug session 要等到**最後一個** client 離開才
    收掉（見 DebugSession.remove_client），兩個分頁共用一個 session 時關掉其中
    一個不可以把另一個一起帶走。
    """
    manager.disconnect_client(request.sid)
    logger.info("Client websocket disconnected, id %s" % (request.sid))


@socketio.on("Client disconnected")
def test_disconnect():
    print("Client websocket disconnected", request.sid)


def read_and_forward_gdb_and_pty_output():
    """A task that runs on a different thread, and emits websocket messages
    of gdb responses"""

    while True:
        socketio.sleep(0.05)
        debug_sessions_to_remove = []
        # 對快照迭代，不要直接走 manager 的實時結構。
        #
        # SessionManager.disconnect_client 會對同一個 client_ids list 做 remove()，
        # 而它跑在另一條 green thread 上。以前這裡直接走原 list：假設 list 是
        # [已斷線的, 還活著的]，emit 完 index 0 的當下 disconnect 把它移除，list
        # 變成長度 1，迴圈的下一個 index 1 已經越界 —— **還活著的 client 就被整個
        # 跳過，而且不會丟出任何例外**。使用者看到的是播放毫無徵兆地卡死。
        for debug_session, client_ids in list(manager.debug_session_to_client_ids.items()):
            client_ids = list(client_ids)
            try:
                try:
                    response = debug_session.pygdbmi_controller.get_gdb_response(
                        timeout_sec=0, raise_error_on_timeout=False
                    )

                except Exception:
                    response = None
                    send_msg_to_clients(
                        client_ids,
                        "The underlying gdb process has been killed. This tab will no longer function as expected.",
                        error=True,
                        run_token=debug_session.run_token,
                    )
                    debug_sessions_to_remove.append(debug_session)

                if response:
                    # 在轉發給瀏覽器之前先自己看一遍：inferior 的 pid 只有這裡
                    # 拿得到，而 /send_signal 需要伺服器端自己有一份紀錄
                    # （呼叫端不再被允許指定 pid）。
                    debug_session.observe_gdb_response(response)
                    # 一則回應一個序號。以前這行在 per-client 迴圈裡，掛兩個
                    # client 時每則回應會遞增兩次，兩邊各自收到跳號的序列。
                    debug_session.packet_seq_num += 1
                    payload = {
                        "run_token": debug_session.run_token,
                        "request_id": debug_session.last_request_id,
                        "packet_seq_num": debug_session.packet_seq_num,
                        "data": response,
                    }
                    for client_id in client_ids:
                        logger.info(
                            "emiting message to websocket client id " + client_id
                        )
                        # 逐一隔離：一個 client 送失敗不該讓其他 client 收不到。
                        try:
                            socketio.emit(
                                "gdb_response",
                                payload,
                                namespace="/gdb_listener",
                                room=client_id,
                            )
                        except Exception:
                            logger.warning(
                                "emit to client %s failed, continuing: %s",
                                client_id,
                                traceback.format_exc(),
                            )
                else:
                    # there was no queued response from gdb, not a problem
                    pass

            except Exception:
                logger.error("caught exception, continuing:" + traceback.format_exc())

        debug_sessions_to_remove += check_and_forward_pty_output()
        for debug_session in set(debug_sessions_to_remove):
            manager.remove_debug_session(debug_session)


def check_and_forward_pty_output() -> List[DebugSession]:
    debug_sessions_to_remove = []
    # 同樣對快照迭代：disconnect_client 會在另一條 green thread 上 remove()，
    # 直接走原 list 會讓還活著的 client 被靜默跳過（見上面那個迴圈的說明）。
    for debug_session, client_ids in list(manager.debug_session_to_client_ids.items()):
        client_ids = list(client_ids)
        try:
            response = debug_session.pty_for_gdb.read()
            if response is not None:
                for client_id in client_ids:
                    socketio.emit(
                        "user_pty_response",
                        response,
                        namespace="/gdb_listener",
                        room=client_id,
                    )

            response = debug_session.pty_for_debugged_program.read()
            if response is not None:
                for client_id in client_ids:
                    socketio.emit(
                        "program_pty_response",
                        response,
                        namespace="/gdb_listener",
                        room=client_id,
                    )
        except Exception as e:
            debug_sessions_to_remove.append(debug_session)
            for client_id in client_ids:
                socketio.emit(
                    "fatal_server_error",
                    {"message": str(e)},
                    namespace="/gdb_listener",
                    room=client_id,
                )
            logger.error(e, exc_info=True)
    return debug_sessions_to_remove
