"""編譯的排隊與優先權。

這兩件事都只在尖峰時才看得出來（一堂課同時開始），而尖峰是最不適合發現 bug 的
時機，所以在這裡把三件事釘住：名額是有上限的、名額一定會被還回去、送出去的命令
真的帶著 nice。
"""

import pytest

from gdbgui.server import http_routes as hr


def test_slot_count_is_bounded(monkeypatch):
    """拿滿名額之後，下一個要排隊——排不到就逾時，而不是偷偷放行。"""
    monkeypatch.setattr(hr, "COMPILE_QUEUE_TIMEOUT_SECONDS", 0.2)

    held = [hr._compile_slot() for _ in range(hr.COMPILE_MAX_CONCURRENT)]
    for slot in held:
        slot.__enter__()
    try:
        with pytest.raises(RuntimeError):
            with hr._compile_slot():
                pytest.fail("名額已滿還拿得到，記憶體峰值就不再有上限")
    finally:
        for slot in held:
            slot.__exit__(None, None, None)


def test_slot_is_released_when_the_compile_raises():
    """編譯逾時/失敗會往外丟例外，名額不還就會一次一次漏光。"""
    for _ in range(hr.COMPILE_MAX_CONCURRENT + 2):
        with pytest.raises(ValueError):
            with hr._compile_slot():
                raise ValueError("compile blew up")

    # 還拿得到名額，代表前面每一次都還回去了
    with hr._compile_slot():
        pass


def test_compile_runs_at_lowest_priority(monkeypatch):
    """nice 掉了的話，編譯尖峰會讓正在單步的人從 17ms 掉到 77ms。"""
    seen = {}

    def fake_run_confined(jail, argv, **kwargs):
        seen["argv"] = argv
        return None

    monkeypatch.setattr(hr, "_run_confined", fake_run_confined)
    hr._run_compile("jail", ["g++", "-g", "x.cpp"])

    assert seen["argv"][:3] == ["nice", "-n", "19"]
    assert seen["argv"][3:] == ["g++", "-g", "x.cpp"]
