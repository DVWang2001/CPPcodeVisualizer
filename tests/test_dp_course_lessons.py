"""DP 課程五份教案的守門測試。

守的是三件會在課堂上炸掉、但在編輯器裡看不出來的事：
  1. bundle 的 source_code 和 .cpp 不同步（老師改了 .cpp 卻匯出舊的）。
  2. 程式算出來的答案變了（改了 weights 就換一張表，教案文字會對不上）。
  3. 某個停駐點漏掉自動播放指令 —— 症狀是教案播到一半停住，畫面上沒有任何提示
     （AUTHORING_GUIDE §1.3 硬性標準）。
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from gdbgui.server.live_quiz import validate_quiz_bundle

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import check_lesson

LESSONS = Path(__file__).parents[1] / "examples" / "lessons"

#: (資料夾, 檔名, 預期 stdout)
COURSE = [
    ("DP課1_一維陣列與索引", "dp1_row", "30\n"),
    ("DP課2_雙層迴圈填表", "dp2_grid", "36\n"),
    ("DP課3_背包填表", "dp3_knapsack", "最大價值：9\n"),
    ("DP課4_同一題改用遞迴", "dp4_recursion", "最大價值：9\n"),
    ("DP課5_記憶化剪掉重複", "dp5_memo", "最大價值：9\n"),
]

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
def test_lesson_passes_the_static_checker(folder, stem, expected_stdout):
    """規則本體在 scripts/check_lesson.py——老師也是跑那一支，這裡只是把它綁進 CI。"""
    problems, _ = check_lesson.check((LESSONS / folder / f"{stem}.cpp").read_text(encoding="utf-8"))

    assert problems == [], "; ".join(f"{stem}.cpp:{n}  {m}" for n, m in problems)


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
