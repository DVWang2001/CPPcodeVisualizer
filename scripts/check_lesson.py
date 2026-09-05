"""教案靜態驗收：把 AUTHORING_GUIDE 裡「看不出來但會在課堂上炸掉」的規則跑成檢查。

    python scripts/check_lesson.py examples/lessons/DP課3_背包填表/dp3_knapsack.cpp
    python scripts/check_lesson.py 某教案.gdbgui.json        # bundle 也吃，會取出 source_code

判錯的有四條。它們的共同點是：在編輯器裡看起來完全正常，要等到課堂上按下 Run
才會發現，而且失敗時畫面上不會有任何錯誤訊息。

  1. 停駐點缺 @tts —— 教案播到那一行就無聲停住（§1.3）
  2. @N 段落缺自動播放指令 —— 同上，而且只在「第 N 次進入」才發作（§1.3）
  3. 最後一站不是 [continue] —— 程式停在半路不結束（§1.3）
  4. 註解引用了該行才「建構」的變數 —— 讀到未初始化的垃圾值（§2.2）

另有一條只提醒不判錯：註解引用了該行才「重新賦值」的變數。那顯示的是上一步的
舊值，不是垃圾——先看舊值再看新值常常正是要教的東西，只要文字有說清楚。

不守的：語意對不對、話講得好不好、TTS 唸起來順不順。那些只能靠人看。
真正的驗收仍然是「Import 後按 Run，全程不碰鍵盤滑鼠」，見 AUTHORING_GUIDE 第九章。
"""

import json
import re
import sys
from pathlib import Path

AUTOPLAY = re.compile(r"^\[(next|step-in|step-out|continue|fast @[^\]]+)\]")
#: GDB 不會停駐的行：前置處理、註解、單獨的大括號、無初值的宣告，以及所有沒有縮排
#: 的行（檔案層級的全域宣告與函式簽名——全域在 main 之前就初始化完了，簽名行的
#: 中斷點會落到 prologue 之後的第一個敘述）。
NO_STOP = re.compile(r"^\s*(#|//|$)|^\S|^\s*[{}]\s*;?\s*$|^\s*[A-Za-z_][\w:<>, ]*\s+\w+;\s*$")
#: 這一行讓哪個名字「第一次有值」：`int x = ...`、`x = ...`、`std::vector<int> v(7, 0);`。
#: 刻意不含 `v[i] = ...`——寫進某一格不會讓整個容器變成未初始化，那時候顯示 {v}
#: 正是要讓學生看到「寫入前長什麼樣」，是對的寫法。
FIRST_VALUE = re.compile(
    r"^\s*(?:[A-Za-z_][\w:<>, *&]*\s+)?([A-Za-z_]\w*)\s*(?:=[^=]|\()"
)
#: 型別關鍵字開頭才算宣告；`f(x);` 這種純呼叫不是。
DECL_START = re.compile(r"^\s*(?:const\s+|static\s+)*(?:[A-Za-z_][\w:]*\s*(?:<[^;]*>)?\s+)[A-Za-z_]\w*\s*[=(]")


def fields(line):
    """行尾 //@ 註解拆成 {guide, tts, layout}；沒有註解回 None。"""
    if "//@" not in line:
        return None
    parts = re.split(r"@(guide|tts|layout)\b", line.split("//@", 1)[1])
    out = {}
    for keyword, value in zip(parts[1::2], parts[2::2]):
        out[keyword] = value.strip()
    return out


def source_of(path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(text)["source_code"]
    return text


def mode_of(source):
    """這份原始碼想當哪一種教案。決定要套哪些規則。

    `plain`    —— 完全沒有 //@。就是一支範例程式，老師自己按步驟帶。沒有東西可檢查。
    `manual`   —— 有註解但沒有任何自動播放指令。老師手動推進、註解只負責解說。
                  §1.3 的自動播放標準不適用，但 §2.2 的取值時機照樣會出錯。
    `autoplay` —— 有註解也有自動播放指令。它宣稱自己按下 Run 就會播完，
                  那就必須每個停駐點都接得上，否則會在課堂上停在半路。
    """
    if "//@" not in source:
        return "plain"
    for line in source.split("\n"):
        found = fields(line)
        if found and any(AUTOPLAY.match(re.sub(r"^\s*@\d+\s*", "", seg.strip()))
                         for seg in found.get("tts", "").split("|")):
            return "autoplay"
    return "manual"


def check(source):
    """回傳 (problems, notes)。problems 非空代表不合格；notes 只是要作者確認一下。"""
    problems = []
    notes = []
    lines = source.split("\n")
    mode = mode_of(source)
    if mode == "plain":
        return problems, notes
    autoplay = mode == "autoplay"
    last_tts_line = last_tts = None

    for number, line in enumerate(lines, start=1):
        code = line.split("//@", 1)[0]
        if line.count("//@") > 1:
            problems.append((number, "一行只能有一個 //@ 註解"))
        found = fields(line)

        if found is None:
            if autoplay and not NO_STOP.match(code):
                problems.append((number, f"這是停駐點卻沒有 @tts：{code.strip()}"))
            continue

        tts = found.get("tts", "")
        if not tts:
            if autoplay and not NO_STOP.match(code):
                problems.append((number, f"有 //@ 但沒有 @tts，停在這一行會無聲卡住：{code.strip()}"))
        else:
            if autoplay:
                for segment in tts.split("|"):
                    bare = re.sub(r"^\s*@\d+\s*", "", segment.strip())
                    if not AUTOPLAY.match(bare):
                        problems.append((number, f"這個段落缺自動播放指令：{bare[:40] or '(空白)'}"))
            last_tts_line, last_tts = number, tts

        # `x = ...` 或 `T x(...)`：這一行執行完 x 才有值，而註解是在執行「之前」觸發的。
        # 括號形式只在確實是宣告時才算，否則 `f(a);` 會被誤判成給 f 賦值。
        first_value = FIRST_VALUE.match(code)
        if first_value and ("=" in code.split("(")[0] or DECL_START.match(code)):
            name = first_value.group(1)
            # 宣告（型別在前）＝這一刻變數還沒建構，讀到的是垃圾；
            # 單純再賦值＝讀到的是上一步的舊值，不是垃圾，但文字通常在說謊。
            declaring = bool(DECL_START.match(code))
            for value in found.values():
                if re.search(r"\{" + re.escape(name) + r"[}\[]", value):
                    if declaring:
                        problems.append((number, (
                            f"註解引用了這一行才會建構的 {{{name}}}——停在這裡時它還沒有值，"
                            "實測會顯示 length -1177 之類的垃圾。把它移到下一行的註解"
                        )))
                    else:
                        # 顯示「寫入前的舊值」常常是刻意的教學手法（先看舊的、再看新的），
                        # 所以只提醒不判錯——但文字要說清楚那是舊值，否則學生會以為是結果。
                        notes.append((number, (
                            f"這裡的 {{{name}}} 是「這一行執行前」的舊值，不是它算出來的結果。"
                            "刻意要顯示舊值就沒問題，文字記得說清楚"
                        )))
                    break

    if not autoplay:
        return problems, notes
    if last_tts is None:
        problems.append((0, "整份教案沒有任何 @tts，按 Run 不會播放"))
    elif "[continue]" not in last_tts:
        problems.append((last_tts_line, "最後一個停駐點必須以 [continue] 收尾，否則程式停在半路"))

    return problems, notes


def main(argv):
    if len(argv) != 2:
        sys.exit(f"用法：{argv[0]} <教案.cpp 或 教案.gdbgui.json>")
    path = Path(argv[1])
    if not path.exists():
        sys.exit(f"找不到 {path}")

    source = source_of(path)
    mode = mode_of(source)
    if mode == "plain":
        print(f"{path.name}  沒有任何 //@ 註解——這是一支範例程式，不是自動播放教案，沒有東西可檢查。")
        return 0

    problems, notes = check(source)
    for number, message in problems:
        where = f"{path.name}:{number}" if number else path.name
        print(f"{where}  {message}")
    for number, message in notes:
        print(f"{path.name}:{number}  提醒：{message}")

    if problems:
        print(f"\n{len(problems)} 個問題。修好之後仍要 Import 按 Run 實跑一次（見 AUTHORING_GUIDE 第九章）。")
        return 1
    if mode == "manual":
        print(f"{path.name}  靜態檢查通過（手動推進的教案，不套用自動播放標準）。")
    else:
        print(f"{path.name}  靜態檢查通過。接著 Import 按 Run，全程不碰鍵盤滑鼠，確認它自己播到結束。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
