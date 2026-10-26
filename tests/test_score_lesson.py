import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import score_lesson as sl  # noqa: E402

# 這份就是正式機 lesson #52 的縮影：標在不會停的行、program_input 殘留
BAD = """#include <iostream>  //@ @tts [next] 引入函式庫
int main() {
   int sum = 0;  //@ @tts [next] 開始
   for (int i = 1; i <= 3; i++) {  //@ @tts [next] 迴圈 | @9 [next] 九
      sum += i;  //@ @guide {sum} @tts [next] 加
   }  //@ @tts [next] 迴圈結束
}  //@ @tts [continue] 結束
"""

GOOD = """#include <iostream>
int main() {
   int sum = 0;  //@ @tts [next] 開始
   for (int i = 1; i <= 3; i++) {  //@ @tts [next] 開始 | @2 [next] 下一圈
      sum += i;  //@ @guide {sum} @tts [next] 加 {i}
   }
}  //@ @tts [continue] 結束
"""


def test_good_lesson_scores_full():
    r = sl.score(GOOD)
    assert r["gates_passed"], r["gates_failed"]
    assert r["S_percent"] == 100, r["S"]


def test_bad_lesson_is_penalised_on_s1_s4():
    r = sl.score(BAD, program_input="4 56 +")
    assert r["S"]["S1"]["score"] < 2  # #include 行與縮排的單獨 } 都不會停
    assert r["S"]["S4"]["score"] == 0  # 沒有 cin 卻有 program_input
    assert r["S_percent"] < 80


def test_code_edit_fails_gate_g1():
    r = sl.score(GOOD.replace("i <= 3", "i <= 4"), original=GOOD)
    assert "G1" in r["gates_failed"] and r["S_percent"] == 0


def test_made_up_threshold_on_once_only_line():
    src = GOOD.replace("[next] 開始\n   for", "[next] 開始 | @5 [next] 五\n   for")
    assert sl.score(src)["S"]["S2"]["score"] < 2


def test_unknown_panel_id_fails_gate_g6():
    src = GOOD.replace("[next] 開始\n", "[next] 開始 @layout open:nonsense\n", 1)
    assert "G6" in sl.score(src)["gates_failed"]
