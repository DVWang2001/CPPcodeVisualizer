This is the command line help output of gdbgui (abridged; see `gdbgui/cli.py` for the authoritative option list).

```
usage: gdbgui [-h] [-p PORT] [--host HOST] [-r]
              [--auth-file AUTH_FILE] [--user USER] [--password PASSWORD]
              [--key KEY] [--cert CERT] [--remap-sources REMAP_SOURCES]
              [--project PROJECT] [-v] [-n] [-b BROWSER] [--debug]

A server for the CPPcodeVisualizer web UI. C++ programs are compiled and run
in the browser (wasm engine); the server no longer runs gdb.
(--gdb-cmd, the positional debug_program and --args were removed.)

optional arguments:
  -h, --help            show this help message and exit

gdbgui network settings:
  -p PORT, --port PORT  The port on which gdbgui will be hosted (default:
                        5000)
  --host HOST           The host ip address on which gdbgui serve (default:
                        127.0.0.1)
  -r, --remote          Shortcut to set host to 0.0.0.0 and suppress browser
                        from opening. This allows remote access to gdbgui
                        and is useful when running on a remote machine that
                        you want to view/debug from your local browser, or
                        let someone else debug your application remotely.
                        (default: False)

security settings:
  --auth-file AUTH_FILE
                        Require authentication before accessing gdbgui in
                        the browser. Specify a file that contains the HTTP
                        Basic auth username and password separate by
                        newline. (default: None)
  --user USER           Username when authenticating (default: None)
  --password PASSWORD   Password when authenticating (default: None)
  --key KEY             SSL private key. Generate with:openssl req -newkey
                        rsa:2048 -nodes -keyout host.key -x509 -days 365
                        -out host.cert (default: None)
  --cert CERT           SSL certificate. Generate with:openssl req -newkey
                        rsa:2048 -nodes -keyout host.key -x509 -days 365
                        -out host.cert (default: None)

other settings:
  --remap-sources REMAP_SOURCES, -m REMAP_SOURCES
                        Replace compile-time source paths to local source
                        paths. Pass valid JSON key/value pairs.i.e. --remap-
                        sources='{"/buildmachine": "/current/machine"}'
                        (default: None)
  --project PROJECT     Set the project directory. When viewing the
                        "folders" pane, paths are shown relative to this
                        directory. (default: None)
  -v, --version         Print version (default: False)
  -n, --no-browser      By default, the browser will open with gdbgui. Pass
                        this flag so the browser does not open. (default:
                        False)
  -b BROWSER, --browser BROWSER
                        Use the given browser executable instead of the
                        system default. (default: None)
  --debug               The debug flag of this Flask application. Pass this
                        flag when debugging gdbgui itself to automatically
                        reload the server when changes are detected
                        (default: False)
```
