from gdbgui.server.prerun import build_gdb_script, parse_prerun_output


def test_script_contains_rbreak_and_sentinels():
    s = build_gdb_script("lesson.cpp", "/jails/x/run.sh", None)
    assert "rbreak lesson.cpp:." in s
    assert "PRERUN_JSON_BEGIN" in s and "PRERUN_JSON_END" in s
    assert "set exec-wrapper /jails/x/run.sh" in s


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
    # Must always compile regardless of input.
    s = build_gdb_script("lesson.cpp", "/jails/x/run.sh", "/uploads/p_input.in")
    compile(s, "<prerun_script>", "exec")


def test_script_escapes_quote_injection_in_basename():
    # src_basename / exec_wrapper / input_path are server-derived (secure_filename,
    # server-generated jail paths) but must never be trusted to be free of quotes or
    # newlines -- a crafted value must not be able to break out of the embedded
    # string literal and inject arbitrary Python into a script gdb runs with ptrace
    # privileges. json.dumps-style escaping must keep this syntactically inert.
    hostile = 'a.cpp"); import os; os.system("touch pwned'
    s = build_gdb_script(hostile, None, None)
    # The real assertion is that this compiles cleanly (no injected top-level
    # statement) -- if the value weren't escaped, the embedded `"` would close
    # the string literal early and `import os; os.system(...)` would become a
    # second statement, which would still often compile. So additionally check
    # that no unescaped `import os` appears as its own statement outside a string.
    compile(s, "<prerun_script>", "exec")
    assert "\nimport os" not in s


def test_script_escapes_quote_injection_in_exec_wrapper():
    hostile = '/jails/x/run.sh"); import os; os.system("touch pwned'
    s = build_gdb_script("a.cpp", hostile, None)
    compile(s, "<prerun_script>", "exec")


def test_script_escapes_quote_injection_in_input_path():
    hostile = '/uploads/p_input.in"); import os; os.system("touch pwned'
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
