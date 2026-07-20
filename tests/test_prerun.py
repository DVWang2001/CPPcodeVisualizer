import pytest

from gdbgui.server.prerun import build_gdb_script, parse_prerun_output


def test_script_contains_rbreak_and_sentinels():
    s = build_gdb_script("lesson.cpp", "/jails/x/run.sh", None)
    assert "rbreak lesson.cpp:." in s
    assert "PRERUN_JSON_BEGIN" in s and "PRERUN_JSON_END" in s
    assert "set exec-wrapper /jails/x/run.sh" in s
    assert "set disable-randomization on" in s  # load-bearing: ghost/live sigs must share addresses


def test_script_feeds_input_when_present():
    s = build_gdb_script("a.cpp", None, "/uploads/p_input.in")
    assert "run < /uploads/p_input.in" in s


def test_script_plain_run_without_input():
    s = build_gdb_script("a.cpp", None, None)
    assert 'gdb.execute("run"' in s or "\nrun\n" in s


def test_script_omits_exec_wrapper_when_none():
    s = build_gdb_script("a.cpp", None, None)
    assert "exec-wrapper" not in s


def test_script_respects_max_snapshots():
    s = build_gdb_script("a.cpp", None, None, max_snapshots=7)
    assert "7" in s


def test_script_is_syntactically_valid_python():
    # The generated text is executed by gdb as a Python script (gdb --batch -x file.py).
    # Must always compile for legitimate inputs.
    s = build_gdb_script("lesson.cpp", "/jails/x/run.sh", "/uploads/p_input.in")
    compile(s, "<prerun_script>", "exec")


# ── F3: character-allowlist / denylist hardening ─────────────────────────────
# build_gdb_script is "self-defending": it must refuse to build a script at all
# from session state containing whitespace, newlines, or shell metacharacters,
# rather than relying solely on json.dumps escaping (defense-in-depth, not a
# replacement for it -- see the two-layer note in prerun.py's module docstring).

@pytest.mark.parametrize("hostile_basename", ["a b.cpp", "x\ny.cpp", "a;b.cpp"])
def test_build_script_rejects_hostile_basenames(hostile_basename):
    with pytest.raises(ValueError):
        build_gdb_script(hostile_basename, None, None)


def test_build_script_rejects_basename_with_quote():
    with pytest.raises(ValueError):
        build_gdb_script('a.cpp"); import os#', None, None)


@pytest.mark.parametrize(
    "hostile_path",
    [
        "/jails/x/run.sh; rm -rf /",
        "/jails/x/run sh",
        "/jails/x/run.sh\nrm -rf /",
        "/jails/x/run.sh|cat /etc/passwd",
        "/jails/x/run.sh&whoami",
        "/jails/x/run.sh<in>out",
    ],
)
def test_build_script_rejects_hostile_exec_wrapper(hostile_path):
    with pytest.raises(ValueError):
        build_gdb_script("a.cpp", hostile_path, None)


@pytest.mark.parametrize(
    "hostile_path",
    [
        "/uploads/p input.in",
        "/uploads/p;input.in",
        "/uploads/p\ninput.in",
        "/uploads/p|input.in",
    ],
)
def test_build_script_rejects_hostile_input_path(hostile_path):
    with pytest.raises(ValueError):
        build_gdb_script("a.cpp", None, hostile_path)


def test_build_script_accepts_legitimate_paths_with_slashes_and_dots():
    # Sanity check that the denylist doesn't over-reject ordinary paths.
    s = build_gdb_script("lesson.cpp", "/jails/x-1/run.sh", "/uploads/p_input.in")
    assert "rbreak lesson.cpp:." in s
    assert "set exec-wrapper /jails/x-1/run.sh" in s
    assert "run < /uploads/p_input.in" in s


def test_script_escapes_quote_injection_in_exec_wrapper():
    # This value has no whitespace/newline/shell-metacharacters, so it passes
    # the F3 allowlist check -- it still must not be able to break out of the
    # generated Python string literal (defense-in-depth via json.dumps).
    hostile = '/jails/x/run.sh"+__import__("os").system("touch/pwned")+"'
    s = build_gdb_script("a.cpp", hostile, None)
    compile(s, "<prerun_script>", "exec")


def test_script_escapes_quote_injection_in_input_path():
    hostile = '/uploads/p"+__import__("os").system("touch/pwned")+"'
    s = build_gdb_script("a.cpp", None, hostile)
    compile(s, "<prerun_script>", "exec")


def test_parse_extracts_json_between_sentinels():
    out = "noise\nPRERUN_JSON_BEGIN\n[[{\"func\":\"main\",\"addr\":\"0x1\",\"line\":16,\"args\":[]}]]\nPRERUN_JSON_END\ntail"
    snaps = parse_prerun_output(out)
    assert snaps and snaps[0][0]["func"] == "main"


def test_parse_returns_none_on_missing_sentinel_or_bad_json():
    assert parse_prerun_output("no sentinels") is None
    assert parse_prerun_output("PRERUN_JSON_BEGIN\n{oops\nPRERUN_JSON_END") is None


def test_parse_returns_none_on_non_list_shape():
    out = "PRERUN_JSON_BEGIN\n{\"not\": \"a list\"}\nPRERUN_JSON_END"
    assert parse_prerun_output(out) is None


def test_parse_returns_none_when_frame_missing_required_keys():
    out = "PRERUN_JSON_BEGIN\n[[{\"line\": 1}]]\nPRERUN_JSON_END"
    assert parse_prerun_output(out) is None


def test_parse_accepts_empty_snapshot_list():
    out = "PRERUN_JSON_BEGIN\n[]\nPRERUN_JSON_END"
    assert parse_prerun_output(out) == []
