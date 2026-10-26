"""AI 教案生成的實驗跑台：固定考題 × 提示詞變體 × 重複次數，逐份用 score_lesson 評分。

在正式機容器裡跑（金鑰只在那裡，不用抄到本機）：

    docker cp scripts/score_lesson.py <容器>:/app/scripts/
    docker cp experiments/lesson-gen-eval/run_eval.py <容器>:/app/experiments_eval/
    docker exec -d <容器> sh -c 'cd /app && python experiments_eval/run_eval.py nothink --reps 2 \
        --model deepseek-ai/deepseek-v4.1-flash > /tmp/eval.log 2>&1'
    docker exec <容器> cat /tmp/eval/summary_nothink.json

考題是現成人工教案的 bundle：去掉 //@ 當輸入，program_input 照用。
變體在 VARIANTS 裡加；一次只改一個變數，才知道是哪個改動有效。
"""

import argparse
import json
import os
import re
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

APP = Path("/app")
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / "scripts"))
from gdbgui.server import lesson_gen  # noqa: E402
import score_lesson as sl  # noqa: E402

LESSONS = APP / "examples" / "lessons"
TASKS = {  # 名稱 → bundle 路徑（各類一份）
    "for": "for迴圈_因數抽血/factor_sum.json",
    "while": "while迴圈_考拉斯猜想/collatz.json",
    "recursion": "遞迴_費氏數列_記憶化TopDown/fib_memo.json",
    "vector": "vector經典_排序/bubble_sort.json",
    "dp": "DP課2_雙層迴圈填表/dp2_grid.json",
    "string": "string經典_迴文判斷/palindrome.json",
}
OUT = Path("/tmp/eval")
_ANNOT = re.compile(r"\s*//@.*$")


def load_task(name):
    b = json.loads((LESSONS / TASKS[name]).read_text(encoding="utf-8"))
    src = "\n".join(_ANNOT.sub("", ln) for ln in b["source_code"].split("\n"))
    return src, b.get("program_input", "")


# --- 變體 -----------------------------------------------------------------------------

def v_baseline(guide, source):
    return lesson_gen.build_messages(guide, source)


#: 「常見錯誤」附在系統提示最後。不思考時模型最常犯的三件事（見 nothink 的 12 份實測）。
#: 系統提示後面不會再 .format，所以大括號直接寫單個。
PITFALLS = (
    "\n常見錯誤（逐條自我檢查後再輸出）：\n"
    "A. 宣告行不得引用該行才宣告的變數。錯：`int n = 10;  //@ @guide n={n}`（此刻 n 還沒值）。"
    "正確：把 {n} 移到下一行的註解。for 行不引用自己宣告的迴圈變數；"
    "`int sum = 0;`、`int left = 0;` 這類宣告行的 guide／tts 都不可寫 {sum}、{left}。\n"
    "B. 每一個會停駐的行都要有 @tts：包括 if／else if 條件行、`result = ...;` 賦值行、return 行、"
    "迴圈內每一行；不可只標「重要」的行。\n"
    "C. 原始碼的每一行都要原樣保留，包括開頭的 // 說明註解與空行，一行都不能少、不能合併。\n"
)


def v_pitfalls(guide, source):
    msgs = lesson_gen.build_messages(guide, source)
    msgs[0]["content"] += PITFALLS
    return msgs


NOTHINK = {"chat_template_kwargs": {"thinking": False}}
#: 變體 → (提示詞函式, 額外請求參數, 是否做修正回合)
VARIANTS = {
    "baseline": (v_baseline, None, False),
    "diag": (v_baseline, None, False),
    "nothink": (v_baseline, NOTHINK, False),
    "np": (v_pitfalls, NOTHINK, False),   # nothink + 常見錯誤清單
    "nr": (v_baseline, NOTHINK, True),    # nothink + 修正回合（貼回檢查器輸出）
    "npr": (v_pitfalls, NOTHINK, True),   # 兩者都加
}


def generate(messages, model, temperature, extra=None):
    resp = requests.post(
        lesson_gen.DEFAULT_BASE_URL + "/chat/completions",
        headers={"Authorization": "Bearer " + (os.environ.get("LESSON_AI_API_KEY") or os.environ["NVIDIA_API_KEY"]),
                 "Content-Type": "application/json", "Accept": "text/event-stream"},
        json={"model": model, "messages": messages, "max_tokens": 16384,
              "temperature": temperature, "stream": True, **(extra or {})},
        stream=True, timeout=(30, 600))
    resp.raise_for_status()
    pieces, stats = [], {"reasoning_chars": 0, "content_chars": 0, "finish": None, "tail": []}
    for line in resp.iter_lines():
        text = line.decode("utf-8", "replace") if isinstance(line, bytes) else line
        if text.strip():
            stats["tail"] = (stats["tail"] + [text[:300]])[-3:]
        parsed = lesson_gen.sse_delta(line)
        if parsed:
            stats["reasoning_chars" if parsed[0] == "reasoning" else "content_chars"] += len(parsed[1])
            if parsed[0] == "content":
                pieces.append(parsed[1])
        m = re.search(r'"finish_reason"\s*:\s*"(\w+)"', text)
        if m:
            stats["finish"] = m.group(1)
    return lesson_gen.strip_code_fences("".join(pieces)), stats


def repair_message(failed):
    lines = "\n".join(f"- {k}：{v}" for k, v in failed.items())
    return ("你的輸出沒通過檢查器：\n" + lines +
            "\n請修正這些問題後，重新輸出完整的 C++ 原始碼（只輸出程式碼，其餘規則不變，"
            "原始碼每一行都要保留）。")


def one(variant, task, rep, guide, model, temperature):
    src, program_input = load_task(task)
    prompt, extra, repair = VARIANTS[variant]
    d = OUT / variant
    d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rec = {"variant": variant, "task": task, "rep": rep}
    try:
        msgs = prompt(guide, src)
        code, rec["stats"] = generate(msgs, model, temperature, extra)
        rec["score"] = sl.score(code, program_input, original=src)
        if repair and not rec["score"]["gates_passed"] and code.strip():
            rec["first_pass"] = {"S_percent": rec["score"]["S_percent"],
                                 "gates_failed": rec["score"]["gates_failed"]}
            msgs = msgs + [{"role": "assistant", "content": code},
                           {"role": "user", "content": repair_message(rec["score"]["gates_failed"])}]
            code, rec["repair_stats"] = generate(msgs, model, temperature, extra)
            rec["score"] = sl.score(code, program_input, original=src)
        (d / f"{task}_{rep}.cpp").write_text(code, encoding="utf-8")
        rec["seconds"] = round(time.time() - t0)
    except Exception as e:  # 一份失敗不能拖垮整批
        rec["error"] = repr(e)
    (d / f"{task}_{rep}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def summarize(recs):
    by = {}
    for r in recs:
        by.setdefault(r["variant"], []).append(r)
    out = {}
    for v, rs in by.items():
        ok = [r for r in rs if "score" in r]
        pcts = [r["score"]["S_percent"] for r in ok]
        out[v] = {
            "runs": len(rs), "errors": len(rs) - len(ok),
            "gate_pass_rate": round(sum(r["score"]["gates_passed"] for r in ok) / len(rs), 2) if rs else 0,
            "first_pass_gate_rate": round(sum(1 for r in ok if "first_pass" not in r and r["score"]["gates_passed"])
                                          / len(rs), 2) if rs else 0,
            "S_mean": round(statistics.mean(pcts), 1) if pcts else None,
            "S_stdev": round(statistics.pstdev(pcts), 1) if len(pcts) > 1 else None,
            "by_task": {r["task"] + "_" + str(r["rep"]): (r["score"]["S_percent"] if "score" in r else r.get("error"))
                        for r in rs},
            "gates_failed": {r["task"] + "_" + str(r["rep"]): {k: v2[:160] for k, v2 in r["score"]["gates_failed"].items()}
                             for r in ok if r["score"]["gates_failed"]},
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("variants", nargs="+")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--tasks", nargs="*", default=list(TASKS))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--model", default=lesson_gen.DEFAULT_MODEL)
    ap.add_argument("--temperature", type=float, default=0.3)
    a = ap.parse_args()

    guide = (APP / "AUTHORING_GUIDE.md").read_text(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(v, t, r) for v in a.variants for t in a.tasks for r in range(1, a.reps + 1)]
    recs, lock = [], threading.Lock()

    def run(job):
        rec = one(*job, guide, a.model, a.temperature)
        with lock:
            recs.append(rec)
            (OUT / f"summary_{'_'.join(a.variants)}.json").write_text(
                json.dumps(summarize(recs), ensure_ascii=False, indent=1), encoding="utf-8")

    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, jobs))
    print("done", len(recs))


if __name__ == "__main__":
    main()
