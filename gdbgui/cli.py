#!/usr/bin/env python

"""
A server that provides a graphical user interface to the gnu debugger (gdb).
https://github.com/cs01/gdbgui
"""

import argparse
import json
import logging
import os
import atexit
import shutil
import signal


from gdbgui import __version__
from gdbgui.server.app import app, socketio
from gdbgui.server.constants import DEFAULT_HOST, DEFAULT_PORT
from gdbgui.server.server import run_server


logger = logging.getLogger(__name__)
logging.getLogger("werkzeug").setLevel(logging.ERROR)

def clear_uploads_dir():
    """Remove all files and subdirectories inside server/uploads."""
    try:
        uploads_dir = os.path.join(os.path.dirname(__file__), "server", "uploads")
        if not os.path.exists(uploads_dir):
            return
        for name in os.listdir(uploads_dir):
            path = os.path.join(uploads_dir, name)
            try:
                if os.path.isfile(path) or os.path.islink(path):
                    os.remove(path)
                elif os.path.isdir(path):
                    shutil.rmtree(path)
            except Exception:
                logger.exception("Failed to remove upload path: %s", path)
    except Exception:
        logger.exception("Error while clearing uploads directory")

# ensure cleanup on normal interpreter exit
atexit.register(clear_uploads_dir)

# ensure cleanup on SIGINT / SIGTERM (e.g. Ctrl-C, system stop)
def _signal_handler(signum, frame):
    logger.info("Received signal %s, clearing uploads and exiting", signum)
    clear_uploads_dir()
    # restore default handler and re-raise signal so process exits with expected status
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)

for _sig in (signal.SIGINT, signal.SIGTERM):
    try:
        signal.signal(_sig, _signal_handler)
    except Exception:
        # ignore platforms that don't support these signals
        pass

#: 舊的 HTTP Basic Auth 旗標（--auth-file / --user / --password）。
#:
#: 那是「給這台 gdbgui 加一道鎖」的單一組帳密，沒有使用者概念，已經被帳號登入
#: 取代（gdbgui/server/auth.py）。旗標保留下來但**必須直接失敗**，不能靜靜地
#: 被忽略：部署者若以為 `--auth-file` 還在保護這台機器而它其實什麼都沒做，
#: 那比一開始就沒有這個旗標危險得多。
_BASIC_AUTH_REMOVED_MESSAGE = (
    "HTTP Basic auth (--auth-file / --user / --password) has been replaced by user "
    "accounts: everyone registers at /register and logs in at /login. There is no "
    "single shared credential any more, so these flags no longer do anything and "
    "gdbgui refuses to start with them rather than pretend to be protected."
)


def reject_removed_basic_auth_flags(auth_file, user, password):
    if auth_file or user or password:
        print(_BASIC_AUTH_REMOVED_MESSAGE)
        exit(1)


def get_parser():
    # 伺服器 GDB 已移除（程式在瀏覽器內的 wasm 引擎執行），所以 GDB 相關的
    # 選項（--gdb-cmd、要除錯的執行檔位置參數、--args）都已刪除。傳了它們會被
    # argparse 當成未知參數直接報錯，不會被安靜地忽略。
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    network = parser.add_argument_group(title="gdbgui network settings")
    security = parser.add_argument_group(title="security settings")
    other = parser.add_argument_group(title="other settings")

    network.add_argument(
        "-p",
        "--port",
        help="The port on which gdbgui will be hosted",
        default=DEFAULT_PORT,
    )
    network.add_argument(
        "--host", help="The host ip address on which gdbgui serve", default=DEFAULT_HOST
    )
    network.add_argument(
        "-r",
        "--remote",
        help="Shortcut to set host to 0.0.0.0 and suppress browser from opening. This allows remote access "
        "to gdbgui and is useful when running on a remote machine that you want to view/debug from your local "
        "browser, or let someone else debug your application remotely.",
        action="store_true",
    )

    # 這三個旗標已被帳號登入取代。留著只是為了在有人使用它們時**明確報錯**
    # 而不是安靜地忽略（見 reject_removed_basic_auth_flags）。
    security.add_argument(
        "--auth-file",
        help="REMOVED. HTTP Basic auth has been replaced by user accounts "
        "(/register, /login). Passing this flag is an error.",
    )
    security.add_argument(
        "--user",
        help="REMOVED. See --auth-file.",
    )
    security.add_argument(
        "--password",
        help="REMOVED. See --auth-file.",
    )
    security.add_argument(
        "--key",
        default=None,
        help="SSL private key. "
        "Generate with:"
        "openssl req -newkey rsa:2048 -nodes -keyout host.key -x509 -days 365 -out host.cert",
    )
    # https://www.digitalocean.com/community/tutorials/openssl-essentials-working-with-ssl-certificates-private-keys-and-csrs
    security.add_argument(
        "--cert",
        default=None,
        help="SSL certificate. "
        "Generate with:"
        "openssl req -newkey rsa:2048 -nodes -keyout host.key -x509 -days 365 -out host.cert",
    )
    # https://www.digitalocean.com/community/tutorials/openssl-essentials-working-with-ssl-certificates-private-keys-and-csrs

    other.add_argument(
        "--remap-sources",
        "-m",
        help=(
            "Replace compile-time source paths to local source paths. "
            "Pass valid JSON key/value pairs."
            'i.e. --remap-sources=\'{"/buildmachine": "/current/machine"}\''
        ),
    )
    other.add_argument(
        "--project",
        help='Set the project directory. When viewing the "folders" pane, paths are shown relative to this directory.',
    )
    other.add_argument("-v", "--version", help="Print version", action="store_true")

    other.add_argument(
        "-n",
        "--no-browser",
        help="By default, the browser will open with gdbgui. Pass this flag so the browser does not open.",
        action="store_true",
    )
    other.add_argument(
        "-b",
        "--browser",
        help="Use the given browser executable instead of the system default.",
        default=None,
    )
    other.add_argument(
        "--debug",
        help="The debug flag of this Flask application. "
        "Pass this flag when debugging gdbgui itself to automatically reload the server when changes are detected",
        action="store_true",
    )
    return parser


def main():
    """Entry point from command line"""
    parser = get_parser()
    args = parser.parse_args()
    if args.version:
        print(__version__)
        return

    if args.no_browser and args.browser:
        print("Cannot specify no-browser and browser. Must specify one or the other.")
        exit(1)

    reject_removed_basic_auth_flags(args.auth_file, args.user, args.password)
    app.config["project_home"] = args.project
    if args.remap_sources:
        try:
            app.config["remap_sources"] = json.loads(args.remap_sources)
        except json.decoder.JSONDecodeError as e:
            print(
                "The '--remap-sources' argument must be valid JSON. See gdbgui --help."
            )
            print(e)
            exit(1)

    if args.remote:
        args.host = "0.0.0.0"
        args.no_browser = True

    logger.setLevel(logging.DEBUG if args.debug else logging.INFO)

    run_server(
        app=app,
        socketio=socketio,
        host=args.host,
        port=int(args.port),
        debug=bool(args.debug),
        open_browser=(not args.no_browser),
        browsername=args.browser,
        private_key=args.key,
        certificate=args.cert,
    )


if __name__ == "__main__":
    main()
