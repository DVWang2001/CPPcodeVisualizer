"""AI 教案生成的實驗跑台：固定考題 × 提示詞變體 × 重複次數，逐份用 score_lesson 評分。

在正式機容器裡跑（金鑰只在那裡，不用抄到本機）：

    docker cp scripts/score_lesson.py <容器>:/app/scripts/
    docker cp experiments/lesson-gen-eval <容器>:/app/experiments_eval
    docker exec -d <容器> python /app/experiments_eval/run_eval.py baseline --reps 2
    docker exec <容器> cat /tmp/eval/summary.json

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


# --- 變體：(guide_md, source) -> messages -------------------------------------------

def v_baseline(guide, source):
    return lesson_gen.build_messages(guide, source)


VARIANTS = {"baseline": v_baseline}


def generate(messages, model, temperature):
    resp = requests.post(
        lesson_gen.DEFAULT_BASE_URL + "/chat/completions",
        headers={"Authorization": "Bearer " + (os.environ.get("LESSON_AI_API_KEY") or os.environ["NVIDIA_API_KEY"]),
                 "Content-Type": "application/json", "Accept": "text/event-stream"},
        json={"model": model, "messages": messages, "max_tokens": 16384,
              "temperature": temperature, "stream": True},
        stream=True, timeout=(30, 600))
    resp.raise_for_status()
    pieces = []
    for line in resp.iter_lines():
        parsed = lesson_gen.sse_delta(line)
        if parsed and parsed[0] == "content":
            pieces.append(parsed[1])
    return lesson_gen.strip_code_fences("".join(pieces))


def one(variant, task, rep, guide, model, temperature):
    src, program_input = load_task(task)
    d = OUT / variant
    d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rec = {"variant": variant, "task": task, "rep": rep}
    try:
        code = generate(VARIANTS[variant](guide, src), model, temperature)
        (d / f"{task}_{rep}.cpp").write_text(code, encoding="utf-8")
        rec["seconds"] = round(time.time() - t0)
        # 伺服器端也會做 G1；這裡一樣擋，失敗就記 0 分
        rec["score"] = sl.score(code, program_input, original=src)
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
            "S_mean": round(statistics.mean(pcts), 1) if pcts else None,
            "S_stdev": round(statistics.pstdev(pcts), 1) if len(pcts) > 1 else None,
            "by_task": {r["task"] + "_" + str(r["rep"]): (r["score"]["S_percent"] if "score" in r else r.get("error"))
                        for r in rs},
            "gates_failed": {r["task"] + "_" + str(r["rep"]): list(r["score"]["gates_failed"])
                             for r in ok if r["score"]["gates_failed"]},
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("variants", nargs="+")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--tasks", nargs="*", default=list(TASKS))
    ap.add_argument("--workers", type=int, default=4)
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
