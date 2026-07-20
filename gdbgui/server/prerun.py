"""Pure functions for the "ghost pre-run" batch-gdb call-tree endpoint.

``build_gdb_script`` renders a self-contained GDB Python script (meant to be
executed via ``gdb --batch -nx -x <script>.py <binary>``) that:

  - disables pagination/confirmation prompts,
  - optionally installs the session's exec-wrapper jail
    (``set exec-wrapper <wrapper>``) so the pre-run inherits the same
    resource limits / privilege drop as an interactive debug session,
  - sets a breakpoint on every function defined in the user's own source
    file (``rbreak <src_basename>:.``) -- library/runtime code is never
    instrumented,
  - runs the program (optionally piping stdin from ``input_path``),
  - on every stop, records a full stack snapshot (innermost frame first)
    with function name, pc, source line and arguments,
  - repeats via ``continue`` until the process exits, gdb errors out, or
    ``max_snapshots`` is reached (hard cap -- this runs unattended, so it
    must never be able to spin forever or produce unbounded output),
  - prints the collected snapshots as JSON between ``PRERUN_JSON_BEGIN`` /
    ``PRERUN_JSON_END`` sentinel lines so the caller can reliably extract
    them from otherwise-noisy gdb stdout.

``parse_prerun_output`` is the inverse: given raw process stdout, it
extracts and validates the JSON between the sentinels.

Security note on script construction
-------------------------------------
``src_basename``, ``exec_wrapper`` and ``input_path`` are normally
server-derived (``secure_filename`` output, server-generated jail paths,
a session-prefixed upload path) -- but this module treats them as
untrusted input regardless, because they ultimately trace back to
attacker-influenced data (an uploaded filename) validated by *other*
code that could change independently of this one. Two independent
layers defend against script/command injection here:

  1. An allowlist/denylist character check (see ``_validate_src_basename``
     and ``_validate_path_like`` below) rejects anything containing
     whitespace, newlines, or shell metacharacters (``; < > & |``) --
     and, for ``src_basename`` specifically, anything outside
     ``[A-Za-z0-9._-]`` -- before a script is ever built. This is
     "self-defending": ``build_gdb_script`` raises ``ValueError`` rather
     than silently emitting a script built from garbage session state.
  2. Every such value is additionally embedded into the generated script
     text via ``json.dumps``, which produces a properly
     quote/backslash/control-character-escaped Python string literal.
     This remains necessary defense-in-depth even after layer 1, because
     the denylist for ``exec_wrapper``/``input_path`` does not forbid
     quote characters (paths may legitimately need to be embedded
     as-is) -- without escaping, a value containing an unescaped ``"``
     could terminate the string literal early and inject arbitrary
     Python into a script that GDB executes with ptrace privileges over
     the debuggee, i.e. a script-injection-to-RCE escalation.

Numeric values (``max_snapshots``) are coerced with ``int()`` and never
interpolated as strings, so they cannot carry a similar payload either.
"""

import json
import re

PRERUN_JSON_BEGIN = "PRERUN_JSON_BEGIN"
PRERUN_JSON_END = "PRERUN_JSON_END"

DEFAULT_MAX_SNAPSHOTS = 300

_SRC_BASENAME_RE = re.compile(r"[A-Za-z0-9._-]+")
_SHELL_METACHARACTERS = frozenset(";<>&|")


def _validate_src_basename(value: str) -> None:
    if not isinstance(value, str) or not _SRC_BASENAME_RE.fullmatch(value):
        raise ValueError("invalid src_basename")


def _validate_path_like(value: str, label: str) -> None:
    """Reject exec_wrapper / input_path values containing whitespace,
    newlines, or shell metacharacters. Paths may still contain slashes,
    dots, quotes etc. -- those are handled by json.dumps escaping at the
    point of embedding, not by this allowlist."""
    if not isinstance(value, str):
        raise ValueError(f"invalid {label}")
    if any(ch.isspace() for ch in value) or any(
        ch in _SHELL_METACHARACTERS for ch in value
    ):
        raise ValueError(f"invalid {label}")


def build_gdb_script(
    src_basename: str,
    exec_wrapper: "str | None",
    input_path: "str | None",
    max_snapshots: int = DEFAULT_MAX_SNAPSHOTS,
) -> str:
    """Raises ValueError if src_basename / exec_wrapper / input_path fail
    the character validation described in the module docstring. Callers
    (the Flask route) must treat ValueError as a rejected/invalid session
    state, not a 500 -- these values come from session state that this
    function does not trust to have been validated correctly upstream."""
    _validate_src_basename(src_basename)
    if exec_wrapper:
        _validate_path_like(exec_wrapper, "exec_wrapper")
    if input_path:
        _validate_path_like(input_path, "input_path")

    max_snapshots = int(max_snapshots)

    lines = [
        "import gdb, json",
        "",
        'gdb.execute("set pagination off")',
        'gdb.execute("set confirm off")',
        # Ghost sigs only match live sigs if both runs share absolute addresses.
        # This is GDB's default, but assert it explicitly — it's the load-bearing
        # assumption of the whole pre-run feature (spec F7).
        'gdb.execute("set disable-randomization on")',
    ]

    if exec_wrapper:
        wrapper_cmd = "set exec-wrapper " + exec_wrapper
        lines.append(f"gdb.execute({json.dumps(wrapper_cmd)})")

    rbreak_cmd = "rbreak " + src_basename + ":."
    lines.append(f"gdb.execute({json.dumps(rbreak_cmd)})")

    if input_path:
        run_cmd_literal = json.dumps("run < " + input_path)
    else:
        run_cmd_literal = json.dumps("run")

    lines += [
        "",
        "snaps = []",
        f"MAX_SNAPSHOTS = {max_snapshots}",
        "try:",
        f"    gdb.execute({run_cmd_literal}, to_string=True)",
        "    while len(snaps) < MAX_SNAPSHOTS:",
        "        inf = gdb.selected_inferior()",
        "        if not inf or not inf.threads():",
        "            break",
        "        frames = []",
        "        f = gdb.newest_frame()",
        "        while f is not None:",
        "            args = []",
        "            try:",
        "                blk = f.block()",
        "                for sym in blk:",
        "                    if sym.is_argument:",
        "                        try:",
        '                            args.append({"name": sym.name, "value": str(f.read_var(sym))})',
        "                        except Exception:",
        "                            pass",
        "            except Exception:",
        "                pass",
        "            sal = f.find_sal()",
        "            frames.append({",
        '                "func": f.name() or "??",',
        '                "addr": hex(f.pc()),',
        '                "line": (sal.line if sal and sal.line else ""),',
        '                "args": args,',
        "            })",
        "            f = f.older()",
        "        snaps.append(frames)",
        "        if len(snaps) >= MAX_SNAPSHOTS:",
        "            break",
        "        try:",
        '            gdb.execute("continue", to_string=True)',
        "        except gdb.error:",
        "            break",
        "except gdb.error:",
        "    pass",
        "",
        f'print({json.dumps(PRERUN_JSON_BEGIN)})',
        "print(json.dumps(snaps))",
        f'print({json.dumps(PRERUN_JSON_END)})',
        "",
    ]

    return "\n".join(lines)


def _valid_snapshot_shape(data) -> bool:
    """list of list of {func, addr, ...} -- reject anything else."""
    if not isinstance(data, list):
        return False
    for snapshot in data:
        if not isinstance(snapshot, list):
            return False
        for frame in snapshot:
            if not isinstance(frame, dict):
                return False
            if "func" not in frame or "addr" not in frame:
                return False
    return True


def parse_prerun_output(stdout: "str | None") -> "list | None":
    if not stdout:
        return None

    begin = stdout.find(PRERUN_JSON_BEGIN)
    end = stdout.find(PRERUN_JSON_END)
    if begin == -1 or end == -1 or end < begin:
        return None

    json_text = stdout[begin + len(PRERUN_JSON_BEGIN):end]
    try:
        data = json.loads(json_text)
    except (ValueError, TypeError):
        return None

    if not _valid_snapshot_shape(data):
        return None

    return data
