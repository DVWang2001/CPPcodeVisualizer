"""端到端驗證：用 Flask test client 直接打真正的 /api/generate_lesson（真模型、上線版流程）。

和 run_eval.py 的差別：run_eval 自己組提示詞呼叫模型，測的是「變體」；這支測的是
**路由本身**（關閉思考、修一輪、確定性移除、G1 退回），也就是使用者按下按鈕時實際發生的事。

資料庫指到拋棄式目錄，註冊的是測試帳號，不碰正式資料。在容器裡跑：

    docker exec -d <容器> sh -c 'cd /app && python experiments_eval/run_route_eval.py --reps 3 > /tmp/route.log 2>&1'
    docker exec <容器> cat /tmp/route_eval/summary.json
"""

import argparse
import json
import os
import statistics
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["GDBGUI_DATA_DIR"] = tempfile.mkdtemp(prefix="route-eval-")  # 必須在 import app 之前
APP = Path("/app")
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_eval as ev  # noqa: E402  (只借它的考題與 load_task)
import score_lesson as sl  # noqa: E402
from gdbgui.server.app import app  # noqa: E402

OUT = Path(os.environ.get("EVAL_OUT", "/tmp/route_eval"))


def new_user(i):
    client = app.test_client()
    client.get("/register")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    r = client.post("/register", data={"csrf_token": csrf, "username": f"routeeval{i}_{os.getpid()}",
                                       "display_name": f"eval {i}", "password": "Eval-pass-123456"})
    assert r.status_code == 302, r.data[:200]
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]
    return client, csrf


def one(i, task, rep, model):
    src, program_input = ev.load_task(task)
    client, csrf = new_user(i)
    t0 = time.time()
    rec = {"task": task, "rep": rep}
    body = {"source": src, "model": model}
    resp = client.post("/api/generate_lesson", data=json.dumps(body), content_type="application/json",
                       headers={"x-csrftoken": csrf})
    events = [json.loads(ln) for ln in resp.get_data(as_text=True).splitlines() if ln.strip()]
    rec["seconds"] = round(time.time() - t0)
    rec["http"] = resp.status_code
    last = events[-1] if events else {}
    rec["saw_repair"] = any("status" in e for e in events)
    # 完整原始事件流（含每個 delta／status／done）逐份存下來，論文要用
    (OUT / f"{task}_{rep}.events.ndjson").write_text(
        "\n".join(json.dumps(e, ensure_ascii=False) for e in events), encoding="utf-8")
    rec["prose_guides_dropped"] = last.get("prose_guides_dropped")
    rec["comments_restored"] = last.get("comments_restored")
    if last.get("done"):
        rec["repaired"] = last.get("repaired")
        rec["warnings"] = last.get("warnings", [])
        rec["breakpoints"] = last.get("breakpoints", [])
        rec["score"] = sl.score(last["code"], program_input, {b["line"] for b in rec["breakpoints"]}, original=src)
        (OUT / f"{task}_{rep}.cpp").write_text(last["code"], encoding="utf-8")
    else:
        rec["error"] = last.get("error") or last.get("message") or repr(last)[:300]
    (OUT / f"{task}_{rep}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def summarize(recs):
    ok = [r for r in recs if "score" in r]
    pcts = [r["score"]["S_percent"] for r in ok]
    clean = [r for r in ok if r["score"]["gates_passed"]]
    return {
        "runs": len(recs),
        "returned_a_lesson": len(ok),
        "errors": {f'{r["task"]}_{r["rep"]}': r["error"] for r in recs if "error" in r},
        "gates_pass": len(clean),
        "gates_pass_rate": round(len(clean) / len(recs), 2) if recs else 0,
        "first_pass_clean": sum(1 for r in clean if not r.get("saw_repair")),
        "needed_repair": sum(1 for r in ok if r.get("saw_repair")),
        "with_warnings": sum(1 for r in ok if r.get("warnings")),
        "prose_guides_dropped_total": sum(r.get("prose_guides_dropped") or 0 for r in ok),
        "runs_with_prose_dropped": sum(1 for r in ok if r.get("prose_guides_dropped")),
        "S_mean_all": round(statistics.mean(r["score"]["S_percent"] for r in ok), 1) if ok else None,
        "S_mean_of_gate_passers": round(statistics.mean(r["score"]["S_percent"] for r in clean), 1) if clean else None,
        "S_stdev_all": round(statistics.pstdev(pcts), 1) if len(pcts) > 1 else None,
        "seconds_mean": round(statistics.mean(r["seconds"] for r in recs)) if recs else None,
        "by_run": {f'{r["task"]}_{r["rep"]}': {
            "S": r["score"]["S_percent"] if "score" in r else None,
            "repair": r.get("saw_repair"), "warn": r.get("warnings"),
            "gates_failed": list(r["score"]["gates_failed"]) if "score" in r else None,
        } for r in recs},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--tasks", nargs="*", default=list(ev.TASKS))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--model", default="deepseek-ai/deepseek-v4.1-flash")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(n, t, r) for n, (t, r) in enumerate((t, r) for t in a.tasks for r in range(1, a.reps + 1))]
    recs, lock = [], threading.Lock()

    def run(job):
        n, t, r = job
        try:
            rec = one(n, t, r, a.model)
        except Exception as e:  # 一份失敗不能拖垮整批
            rec = {"task": t, "rep": r, "error": repr(e), "seconds": 0}
        with lock:
            recs.append(rec)
            (OUT / "summary.json").write_text(json.dumps(summarize(recs), ensure_ascii=False, indent=1),
                                              encoding="utf-8")

    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, jobs))
    print("done", len(recs))


if __name__ == "__main__":
    main()
