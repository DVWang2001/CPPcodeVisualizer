"""DP 課程五份教案的守門測試。

守的是三件會在課堂上炸掉、但在編輯器裡看不出來的事：
  1. bundle 的 source_code 和 .cpp 不同步（老師改了 .cpp 卻匯出舊的）。
  2. 程式算出來的答案變了（改了 weights 就換一張表，教案文字會對不上）。
  3. 某個停駐點漏掉自動播放指令 —— 症狀是教案播到一半停住，畫面上沒有任何提示
     （AUTHORING_GUIDE §1.3 硬性標準）。
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path

import pytest

from gdbgui.server.live_quiz import validate_quiz_bundle

LESSONS = Path(__file__).parents[1] / "examples" / "lessons"

#: (資料夾, 檔名, 預期 stdout)
COURSE = [
    ("DP課1_一維陣列與索引", "dp1_row", "30\n"),
    ("DP課2_雙層迴圈填表", "dp2_grid", "36\n"),
    ("DP課3_背包填表", "dp3_knapsack", "最大價值：9\n"),
    ("DP課4_同一題改用遞迴", "dp4_recursion", "最大價值：9\n"),
    ("DP課5_記憶化剪掉重複", "dp5_memo", "最大價值：9\n"),
]

AUTOPLAY = re.compile(r"^\[(next|step-in|step-out|continue|fast @[^\]]+)\]")
#: GDB 不會停駐的行：前置處理、註解、單獨的大括號、無初值的宣告，以及所有
#: 沒有縮排的行（檔案層級的全域宣告與函式簽名——全域在 main 之前就初始化完了，
#: 簽名行的中斷點會落到 prologue 之後的第一個敘述）。
NO_STOP = re.compile(r"^\s*(#|//|$)|^\S|^\s*[{}]\s*;?\s*$|^\s*int result;\s*$")


def annotation(line):
    """行尾 //@ 註解裡的 @tts 內容（沒有就回 None）。"""
    if "//@" not in line:
        return None
    fields = re.split(r"@(guide|tts|layout)\b", line.split("//@", 1)[1])
    for keyword, value in zip(fields[1::2], fields[2::2]):
        if keyword == "tts":
            return value.strip()
    return None


@pytest.mark.parametrize("folder, stem, expected_stdout", COURSE)
def test_bundle_matches_its_source(folder, stem, expected_stdout):
    bundle = json.loads((LESSONS / folder / f"{stem}.json").read_text(encoding="utf-8"))
    source = (LESSONS / folder / f"{stem}.cpp").read_text(encoding="utf-8")

    assert bundle["version"] == "2.0"
    assert bundle["source_code"] == source
    assert bundle["fullname_to_render"] == f"{stem}.cpp"
    breakpoint_line = int(bundle["breakpoints"][0]["line"])
    assert 0 < breakpoint_line <= len(source.split("\n"))


@pytest.mark.parametrize("folder, stem, expected_stdout", COURSE)
def test_source_computes_the_hand_checked_answer(folder, stem, expected_stdout):
    with tempfile.TemporaryDirectory() as workdir:
        binary = Path(workdir) / stem
        compiled = subprocess.run(
            ["g++", "-std=c++17", "-O0", "-g", str(LESSONS / folder / f"{stem}.cpp"), "-o", str(binary)],
            capture_output=True,
            text=True,
        )
        assert compiled.returncode == 0, compiled.stderr

        result = subprocess.run([str(binary)], capture_output=True, check=True)

    assert result.stdout.decode("utf-8").replace("\r\n", "\n") == expected_stdout


@pytest.mark.parametrize("folder, stem, expected_stdout", COURSE)
def test_every_stop_line_can_autoplay(folder, stem, expected_stdout):
    """每個 GDB 會停的行都要有 @tts，且每個 @N 段落都要以自動播放指令開頭。"""
    lines = (LESSONS / folder / f"{stem}.cpp").read_text(encoding="utf-8").split("\n")
    last_tts = None

    for number, line in enumerate(lines, start=1):
        tts = annotation(line)
        code = line.split("//@", 1)[0]
        if tts is None:
            assert NO_STOP.match(code), f"{stem}.cpp:{number} 是停駐點卻沒有 @tts：{code.strip()}"
            continue
        for segment in tts.split("|"):
            segment = re.sub(r"^\s*@\d+\s*", "", segment.strip())
            assert AUTOPLAY.match(segment), f"{stem}.cpp:{number} 的段落缺自動播放指令：{segment[:40]}"
        last_tts = tts

    assert "[continue]" in last_tts, f"{stem}.cpp 最後一個停駐點必須以 [continue] 收尾"


def test_knapsack_lesson_carries_the_live_quiz():
    folder = LESSONS / "DP課3_背包填表"
    bundle = json.loads((folder / "dp3_knapsack.json").read_text(encoding="utf-8"))

    quiz = validate_quiz_bundle(bundle)

    assert [question["kind"] for question in quiz["questions"]] == ["choice", "choice", "table"]
    assert quiz["questions"][2]["table_spec"] == {"var_hint": "dp", "max_cells": 40}


def test_the_other_lessons_carry_no_quiz():
    for folder, stem, _ in COURSE:
        if stem == "dp3_knapsack":
            continue
        bundle = json.loads((LESSONS / folder / f"{stem}.json").read_text(encoding="utf-8"))
        assert validate_quiz_bundle(bundle) is None
