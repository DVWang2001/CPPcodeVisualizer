import logging
import os
import socket
import threading
import webbrowser

from .constants import DEFAULT_HOST, DEFAULT_PORT, colorize
from .sandbox import jail_manager

logger = logging.getLogger(__name__)

try:
    from gdbgui.SSLify import SSLify, get_ssl_context  # noqa
except ImportError:
    print("Warning: Optional SSL support is not available")

    def get_ssl_context(private_key, certificate):  # noqa
        return None


def get_extra_files():
    """returns a list of files that should be watched by the Flask server
    when in debug mode to trigger a reload of the server
    """
    FILES_TO_SKIP = ["src/gdbgui.js"]
    THIS_DIR = os.path.dirname(os.path.abspath(__file__))
    extra_dirs = [THIS_DIR]
    extra_files = []
    for extra_dir in extra_dirs:
        for dirname, _, files in os.walk(extra_dir):
            for filename in files:
                filepath = os.path.join(dirname, filename)
                if os.path.isfile(filepath) and filepath not in extra_files:
                    for skipfile in FILES_TO_SKIP:
                        if skipfile not in filepath:
                            extra_files.append(filepath)
    return extra_files


_REAPER_INTERVAL_SECONDS = 300


def _start_execution_isolation():
    """啟動時清掉上次執行殘留的 session 帳號／目錄，並開一條回收執行緒。

    scratch 依設計不含持久資料，所以無條件清除是安全的；不清的話殘留帳號
    會一直佔用併發額度（架構 ⑤），重啟幾次之後就再也開不了新 session。
    """
    if not jail_manager.isolation_available():
        if jail_manager.REQUIRE_ISOLATION:
            raise SystemExit(
                "GDBGUI_REQUIRE_ISOLATION=1 but per-session execution isolation is "
                "unavailable on this host. Refusing to start: user programs would "
                "otherwise all run as the same OS user."
            )
        logger.warning(
            "Per-session execution isolation is NOT active. This is only safe for a "
            "single trusted local user."
        )
        return

    jail_manager.ensure_scratch_root()
    reaped = jail_manager.reap_orphans()
    if reaped:
        logger.info("[jail] reaped %d orphaned session account(s) at startup", reaped)

    def _reaper():
        while True:
            try:
                jail_manager.reap_idle()
            except Exception:
                logger.exception("[jail] idle reaper failed")
            threading.Event().wait(_REAPER_INTERVAL_SECONDS)

    threading.Thread(target=_reaper, name="jail-reaper", daemon=True).start()


def run_server(
    *,
    app=None,
    socketio=None,
    host=DEFAULT_HOST,
    port=DEFAULT_PORT,
    debug=False,
    open_browser=True,
    browsername=None,
    testing=False,
    private_key=None,
    certificate=None,
):
    """Run the server of the gdb gui"""

    _start_execution_isolation()

    kwargs = {}
    ssl_context = get_ssl_context(private_key, certificate)
    if ssl_context:
        # got valid ssl context
        # force everything through https
        SSLify(app)
        # pass ssl_context to flask
        kwargs["ssl_context"] = ssl_context

    url = "%s:%s" % (host, port) + '/upload'
    if kwargs.get("ssl_context"):
        protocol = "https://"
        url_with_prefix = "https://" + url
    else:
        protocol = "http://"
        url_with_prefix = "http://" + url

    socketio.server_options["allow_upgrades"] = False
    socketio.init_app(app)

    if testing is False:
        if host == DEFAULT_HOST:
            url = (DEFAULT_HOST, port)
        else:
            try:
                url = (socket.gethostbyname(socket.gethostname()), port)
            except Exception:
                url = (host, port)

        # if open_browser is requested, do it
        if open_browser is True and debug is False:
            browsertext = repr(browsername) if browsername else "default browser"
            args = (browsertext,) + url
            text = ("Opening gdbgui with %s at " + protocol + "%s:%d") % args
            print(colorize(text))
            b = webbrowser.get(browsername) if browsername else webbrowser
            b.open(url_with_prefix)
        else:
            print(colorize(f"View gdbgui at {protocol}{url[0]}:{url[1]}"))
        

        print("exit gdbgui by pressing CTRL+C")
        try:
            socketio.run(
                app,
                debug=debug,
                port=int(port),
                host=host,
                extra_files=get_extra_files(),
                **kwargs,
            )
        except KeyboardInterrupt:
            # Process was interrupted by ctrl+c on keyboard, show message
            pass
