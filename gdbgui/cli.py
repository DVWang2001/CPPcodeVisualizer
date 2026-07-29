#!/usr/bin/env python

"""
A server that provides a graphical user interface to the gnu debugger (gdb).
https://github.com/cs01/gdbgui
"""

import argparse
import json
import logging
import os
import platform
import re
import shlex
from typing import List, Optional

import shlex
from typing import List, Optional
import atexit
import shutil
import signal


from gdbgui import __version__
from gdbgui.server.app import app, socketio
from gdbgui.server.constants import DEFAULT_GDB_EXECUTABLE, DEFAULT_HOST, DEFAULT_PORT
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


def warn_startup_with_shell_off(platform: str, gdb_args: str):
    """return True if user may need to turn shell off
    if mac OS version is 16 (sierra) or higher, may need to set shell off due
    to os's security requirements
    http://stackoverflow.com/questions/39702871/gdb-kind-of-doesnt-work-on-macos-sierra
    """
    darwin_match = re.match(r"darwin-(\d+)\..*", platform)
    on_darwin = darwin_match is not None and int(darwin_match.groups()[0]) >= 16
    if on_darwin:
        shell_is_off = "startup-with-shell off" in gdb_args
        return not shell_is_off
    return False


def get_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    gdb_group = parser.add_argument_group(title="gdb settings")
    args_group = parser.add_mutually_exclusive_group()
    network = parser.add_argument_group(title="gdbgui network settings")
    security = parser.add_argument_group(title="security settings")
    other = parser.add_argument_group(title="other settings")

    gdb_group.add_argument(
        "-g",
        "--gdb-cmd",
        help="""
        gdb binary and arguments to run. If passing arguments,
        enclose in quotes.
        If using rr, it should be specified here with
        'rr replay'.
        Examples: gdb, /path/to/gdb, 'gdb --command=FILE -ix', 'rr replay'

        """,
        default=DEFAULT_GDB_EXECUTABLE,
    )
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
    args_group.add_argument(
        "debug_program",
        nargs="?",
        help="The executable file you wish to debug, and any arguments to pass to it."
        " To pass flags to the binary, wrap in quotes, or use --args instead."
        " Example: gdbgui ./mybinary [other-gdbgui-args...]"
        " Example: gdbgui './mybinary myarg -flag1 -flag2' [other gdbgui args...]",
        default=None,
    )
    args_group.add_argument(
        "--args",
        nargs=argparse.REMAINDER,
        help="Specify the executable file you wish to debug and any arguments to pass to it. All arguments are"
        " taken literally, so if used, this must be the last argument. This can also be specified later in the frontend."
        " passed to gdbgui."
        " Example: gdbgui [...] --args ./mybinary myarg -flag1 -flag2",
        default=[],
    )
    return parser


def get_initial_binary_and_args(
    user_supplied_args: List[str], debug_program_and_args: Optional[str]
) -> List[str]:
    if debug_program_and_args:
        # passed via positional
        return shlex.split(debug_program_and_args)
    else:
        # passed via --args
        return user_supplied_args


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

    app.config["gdb_command"] = args.gdb_cmd
    app.config["initial_binary_and_args"] = get_initial_binary_and_args(
        args.args, args.debug_program
    )
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

    if warn_startup_with_shell_off(platform.platform().lower(), args.gdb_cmd):
        logger.warning(
            "You may need to set startup-with-shell off when running on a mac. i.e.\n"
            "  gdbgui --gdb-cmd='gdb --init-eval-command=\"set startup-with-shell off\"'\n"
            "see http://stackoverflow.com/questions/39702871/gdb-kind-of-doesnt-work-on-macos-sierra\n"
            "and https://sourceware.org/gdb/onlinedocs/gdb/Starting.html"
        )

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
