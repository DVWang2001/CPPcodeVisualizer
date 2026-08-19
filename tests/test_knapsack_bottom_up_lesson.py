import json
import subprocess
from pathlib import Path

from gdbgui.server.live_quiz import validate_quiz_bundle


LESSON_DIR = Path(__file__).parents[1] / "examples" / "lessons" / "DP經典_01背包BottomUp"


def test_knapsack_bundle_is_a_valid_qr_table_lesson():
    bundle = json.loads((LESSON_DIR / "knapsack_bottom_up.json").read_text(encoding="utf-8"))

    quiz = validate_quiz_bundle(bundle)

    assert [question["kind"] for question in quiz["questions"]] == [
        "choice",
        "choice",
        "table",
    ]
    assert quiz["questions"][2]["table_spec"] == {"var_hint": "dp", "max_cells": 40}
    assert bundle["source_code"] == (LESSON_DIR / "knapsack_bottom_up.cpp").read_text(
        encoding="utf-8"
    )


def test_knapsack_source_computes_the_hand_checked_optimum(tmp_path):
    source = LESSON_DIR / "knapsack_bottom_up.cpp"
    binary = tmp_path / "knapsack"

    compiled = subprocess.run(
        ["g++", "-std=c++17", "-O0", "-g", str(source), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compiled.returncode == 0, compiled.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, check=True)

    assert result.stdout == "最大價值：9\n"
