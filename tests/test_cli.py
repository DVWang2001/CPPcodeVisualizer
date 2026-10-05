import sys
from typing import List
from unittest import mock

import gdbgui.cli  # noqa: F401  (讓 gdbgui.cli 這個屬性一定存在，不靠別的測試檔先 import)
import gdbgui
import pytest  # type: ignore


def run_gdbgui_cli(gdbgui_args: List[str]):
    with mock.patch.object(sys, "argv", ["gdbgui"] + gdbgui_args):
        return gdbgui.cli.main()  # type: ignore


# 一定要 patch **cli 模組裡的名字**：cli.py 是 `from ...server import run_server`，
# patch gdbgui.server.server.run_server 擋不到它。萬一參數解析意外成功，
# 沒擋到的話測試會真的把伺服器跑起來並卡住。
@mock.patch("gdbgui.cli.run_server")
@pytest.mark.parametrize(
    "argv",
    (
        # 伺服器 GDB 已移除：舊的 GDB 旗標與「要除錯的執行檔」位置參數一律是錯誤，
        # 而不是被安靜地忽略。
        ["--gdb-cmd", "gdb"],
        ["-g", "gdb"],
        ["myprogram"],
        ["--args", "./myprogram", "arg"],
        ["myprogram", "cannot pass second arg"],
    ),
)
def test_cli_fails(mock_run_server, argv):
    mock_exit = mock.Mock(side_effect=ValueError("raised in test to exit early"))
    with mock.patch.object(sys, "exit", mock_exit), pytest.raises(
        ValueError, match="raised in test to exit early"
    ):
        run_gdbgui_cli(argv)
    mock_exit.assert_called_once_with(2)
    mock_run_server.assert_not_called()


@mock.patch("gdbgui.cli.run_server")
def test_cli_help(mock_run_server, capsys):
    mock_exit = mock.Mock(side_effect=ValueError("raised in test to exit early"))
    with mock.patch.object(sys, "exit", mock_exit), pytest.raises(
        ValueError, match="raised in test to exit early"
    ):
        run_gdbgui_cli(["--help"])
    mock_exit.assert_called_once_with(0)

    help_text = capsys.readouterr().out
    assert "--port" in help_text, "sanity: the help text was actually printed"
    assert "gdb-cmd" not in help_text
    assert "--args" not in help_text


@pytest.mark.parametrize(
    "auth_file,user,password",
    (("/etc/htpasswd", None, None), (None, "admin", None), (None, None, "secret")),
)
def test_removed_basic_auth_flags_refuse_to_start(auth_file, user, password):
    """舊的 HTTP Basic Auth 旗標必須讓啟動失敗，不能被安靜地忽略。

    reject_removed_basic_auth_flags 用的是 builtin `exit`，不是 sys.exit，
    所以 mock sys.exit 擋不到；直接看 SystemExit。
    """
    with pytest.raises(SystemExit):
        gdbgui.cli.reject_removed_basic_auth_flags(auth_file, user, password)


def test_no_basic_auth_flags_is_fine():
    assert gdbgui.cli.reject_removed_basic_auth_flags(None, None, None) is None


@mock.patch("gdbgui.cli.run_server")
@pytest.mark.parametrize(
    "argv", (["--auth-file", "/etc/htpasswd"], ["--user", "admin"], ["--password", "x"])
)
def test_main_refuses_to_start_with_removed_basic_auth_flags(mock_run_server, argv):
    with pytest.raises(SystemExit):
        run_gdbgui_cli(argv)
    mock_run_server.assert_not_called()
