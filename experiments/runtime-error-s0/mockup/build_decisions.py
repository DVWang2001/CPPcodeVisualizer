# Build decisions-v1.html: the three open decisions of the runtime-error plan (§0), drawn from the S0 results.
# Numbers come from results-20261123/*.json (lab-david); wording is hand-written. Run: python build_decisions.py
# Choices the user has made go in decisions-choices.json ({"1": "A", ...}); the page marks them.
import json, os, re, html, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
S0 = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(S0))
RES = os.path.join(S0, "results-20261123")
OUT = os.path.join(HERE, "decisions-v1.html")


def load(name):
    return json.load(open(os.path.join(RES, name), encoding="utf-8"))


def rows(c):
    return {r["id"]: r for r in load(f"results-{c}.json")["rows"]}


cur, san, rec, plain, ppch, spch = rows("cur"), rows("san"), rows("sanrec"), rows("plain"), rows("plainpch"), rows("sanpch")
# The full "cur" run compiled div0_input first: its cold PCH build overlapped the traces job and hit the compile
# budget (compile-timeout). The smoke run of the same config and commit (results-cur-part.json) has the real result.
part = rows("cur-part")
COLD = [c for c, r in part.items() if c in cur and not r.get("errors")
        and any(e.get("kind") == "compile-timeout" for e in (cur[c].get("errors") or []))]
for c in COLD:
    cur[c] = part[c]

# labels and families: the experiment table of the mock-up (same wording as the mock-up)
M = open(os.path.join(HERE, "runtime-error-viz-v1.html"), encoding="utf-8").read().replace('\\"', '"')
pairs = re.findall(r'<tr class="fam"><td colspan="5">([^<]+)</td></tr>|<tr><td>([^<]+)<span class="case">([^<]+)</span>', M)
labels, fam_of, order, fam = {}, {}, [], None
for fname, lab, cid in pairs:
    if fname:
        fam = fname
        continue
    labels[cid], fam_of[cid] = html.unescape(lab), fam
    order.append(cid)
assert len(order) == 48, len(order)
NOT_ERRORS = {"float_div_zero", "sort_user_cmp", "deep_recursion", "cin_fail"}  # reference programs, engine limit, a warning
ids = [c for c in order if c not in NOT_ERRORS]
assert len(ids) == 44

TRAP_SIG = {"div-zero": "SIGFPE", "other": "SIGSEGV", "memory": "SIGSEGV", "abort": "SIGABRT"}


def fmt(n):
    return f"{n:,}" if isinstance(n, int) else str(n)


def vg_text(v):
    k = v.get("vgerr", "")
    if k == "div-by-zero":
        return f"{v.get('lhs')} / {v.get('rhs')}" if "lhs" in v else "除以 0"
    if k == "div-overflow":
        return f"{v.get('lhs')} / {v.get('rhs')}"
    if k.startswith("signed-overflow"):
        op = {"+": "+", "-": "−", "*": "×"}.get(k.split(":")[-1], k.split(":")[-1])
        return f"{fmt(v.get('lhs'))} {op} {fmt(v.get('rhs'))}"
    if k == "array-bounds":
        return f"{v.get('array', '').strip(chr(39))} 的索引 {v.get('index')}"
    if k == "shift":
        return f"{v.get('lhs')} << {v.get('rhs')}"
    if k == "float-cast-overflow":
        return f"值 {v.get('value')}"
    if k == "null-deref":
        return "空指標"
    if k == "missing-return":
        return "沒有回傳值"
    if k == "assert":
        return f"assert({v.get('expr', '')})"
    if k == "libcxx":
        m = v.get("msg") or v.get("message") or ""
        m = m.split("failed:")[-1].strip() if "failed:" in m else m
        return m[:70]
    return k


def outcome(r):
    """(class, detail) for one result row"""
    if r is None:
        return "oth", "沒有資料"
    if r.get("fail"):
        return "oth", f"編譯失敗（{r['fail']}）"
    if r.get("vgerr"):
        v = r["vgerr"][0]
        line = v.get("line") or (r.get("last") or {}).get("line")
        return "ok", f"停在第 {line} 行：{vg_text(v)}"
    errs = [e for e in (r.get("errors") or []) if e.get("kind") not in ("width-warning", "trace-truncated")]
    if errs:
        return "oth", {"compile-timeout": "編譯逾時", "instrumentation-failed": "插樁失敗"}.get(errs[0]["kind"], errs[0]["kind"])
    ex = r.get("exit") or {}
    line = (r.get("last") or {}).get("line")
    if ex.get("reason") == "trap":
        return "sig", f"停在第 {line} 行，只有訊號 {TRAP_SIG.get(ex.get('trap'), ex.get('trap'))}"
    if ex.get("reason") == "exit":
        out = (r.get("stdout") or "").strip().replace("\n", " ⏎ ")
        return "none", "正常結束，沒有提示" + (f"；輸出 {out[:48]}" if out else "")
    return "oth", {"stack-overflow": "堆疊用完", "step-limit": "步數超過上限", "timeout": "逾時"}.get(ex.get("reason"), str(ex.get("reason")))


cases, tally = [], {"cur": {"ok": 0, "sig": 0, "none": 0, "oth": 0}, "san": {"ok": 0, "sig": 0, "none": 0, "oth": 0}}
for c in ids:
    a, b = outcome(cur.get(c)), outcome(san.get(c))
    tally["cur"][a[0]] += 1
    tally["san"][b[0]] += 1
    if c in COLD:
        a = (a[0], a[1] + "（取自 smoke 那一輪；全量那一輪是冷啟動編譯逾時）")
    cases.append({"id": c, "label": labels[c], "fam": fam_of[c], "cur": a, "san": b, "curNote": c in COLD})
# the template's hand-written breakdown of the programs the checks did not catch assumes exactly these 12
EXPECT_MISSED = {"uninit_read", "ex_err_uninit", "double_delete", "ex_err_double_free", "abort_call", "huge_vector", "inf_recursion",
                 "use_after_free", "ex_err_dangling_ptr", "iter_invalid", "ex_err_iterator_invalidation", "vla_neg"}
assert {c["id"] for c in cases if c["san"][0] != "ok"} == EXPECT_MISSED, sorted({c["id"] for c in cases if c["san"][0] != "ok"} ^ EXPECT_MISSED)


def med(d, key):
    return statistics.median([r[key] for r in d.values() if isinstance(r.get(key), (int, float))])


cost = {
    "pchPlain": round(med(ppch, "tCompileLink") / 1000, 2), "pchSan": round(med(spch, "tCompileLink") / 1000, 2),
    "pchSanMax": round(max(r["tCompileLink"] for r in spch.values() if isinstance(r.get("tCompileLink"), (int, float))) / 1000, 1),
    "plain": round(med(plain, "tCompileLink") / 1000, 2), "san": round(med(san, "tCompileLink") / 1000, 2),
    "execPlain": round(med(plain, "tExec")), "execSan": round(med(san, "tExec")),
}
common = [c for c in plain if plain[c].get("wasmBytes") and san.get(c, {}).get("wasmBytes")]
cost["wasmPct"] = round((statistics.median([san[c]["wasmBytes"] / plain[c]["wasmBytes"] for c in common]) - 1) * 100, 1)
depth = {(r["name"], r["stackSizeMb"]): r["result"] for r in load("results-depth.json")["rows"]}
cost["depthPlain1"], cost["depthSan1"] = depth[("plain", 1)]["maxOk"], depth[("san", 1)]["maxOk"]

F = load("results-fidelity.json")["rows"]
G = load("results-fid2.json")
ran = [r for r in F if "sameSteps" in r]
explained = [c for c in G["cmp"] if c.get("skelDiffAt") == -1 and c.get("stdoutSame")]
flagged = [r for r in ran if r.get("vgerr")]
hung = [r for r in flagged if ((r.get("exit") or [{}])[0] or {}).get("reason") == "timeout"]
fid = {"total": len(F), "ran": len(ran), "identical": sum(1 for r in ran if r["sameSteps"]), "valuesOnly": len(explained),
       "intended": len(flagged) - len(hung), "bug": len(hung), "layout": sum(c["nLayout"] for c in explained),
       "members": sum(c["nOther"] for c in explained)}
fid["sameStops"] = fid["identical"] + fid["valuesOnly"]
quiet_ok = [r for r in ran if not r.get("vgerr")]
fid["sameOut"] = sum(1 for r in quiet_ok if r["sameStdout"])
fid["quiet"] = len(quiet_ok)
fid["outDiff"] = [os.path.basename(os.path.dirname(r["id"])) for r in quiet_ok if not r["sameStdout"]]

# the errors that keep running in the "split" option, and what recover mode did with them (S0 sanrec)
REC_KINDS = ("signed-overflow", "shift", "array-bounds", "float-cast-overflow", "pointer-overflow")
cont_ids = [c for c in ids if san.get(c, {}).get("vgerr") and san[c]["vgerr"][0].get("vgerr", "").startswith(REC_KINDS)]
split = {"stop": tally["san"]["ok"] - len(cont_ids), "cont": len(cont_ids),
         "contSameOut": sum(1 for c in cont_ids if rec[c]["exit"].get("reason") == "exit" and rec[c].get("stdout") == plain[c].get("stdout"))}

# step strip: examples/cpp/errors/err_array_oob.cpp in recover mode (traces-sanrec.json)
T = next(r for r in load("traces-sanrec.json")["rows"] if r["id"] == "ex_err_array_oob")
rep = T["vgerr"][0]
steps = [{"line": s["line"], "guard": ((s.get("vars") or {}).get("b") or {}).get("guard"), "i": (s.get("vars") or {}).get("i")} for s in T["steps"]]
err_step = max(k for k, s in enumerate(steps) if s["line"] == rep["line"] and s["i"] == rep["index"])
change = next(k for k in range(err_step + 1, len(steps)) if steps[k]["guard"] != steps[err_step]["guard"])
first42 = next(k for k, st in enumerate(steps) if st["guard"] == steps[err_step]["guard"])
for k, st in enumerate(steps):  # before `b.guard = 42` runs, guard holds whatever was in memory: show "?"
    st["g"] = "" if st["guard"] is None else ("?" if k < first42 else str(st["guard"]))
src_lines = T["src"].split("\n")
strip = {"steps": steps, "errStep": err_step, "change": change, "before": steps[err_step]["guard"], "after": steps[change]["guard"],
         "out": T["stdout"].strip(), "report": {"line": rep["line"], "array": rep["array"].strip("'"), "index": rep["index"]},
         "code": [[n, src_lines[n - 1]] for n in range(13, 21)]}
san_row = san["ex_err_array_oob"]
strip["stopOut"] = (san_row.get("stdout") or "").strip()

choices = {}
cp = os.path.join(HERE, "decisions-choices.json")
if os.path.exists(cp):
    choices = json.load(open(cp, encoding="utf-8"))

DATA = {"cases": cases, "tally": tally, "cost": cost, "fid": fid, "split": split, "strip": strip, "choices": choices,
        "cold": [labels[c] for c in COLD],
        "notCaught": {k: [c["label"] for c in cases if c["san"][0] != "ok" and c["fam"] == k] for k in sorted({c["fam"] for c in cases})}}

tpl = open(os.path.join(HERE, "decisions-template.html"), encoding="utf-8").read()
assert tpl.count("/*ONLY*/0") == 1
out = tpl.replace("/*DATA*/null", json.dumps(DATA, ensure_ascii=False))
open(OUT, "w", encoding="utf-8", newline="\n").write(out)
# one file per decision (no tab bar), so each can be shown on its own in the chat
for only in (1, 2, 3):
    open(os.path.join(HERE, f"decisions-{only}.html"), "w", encoding="utf-8", newline="\n").write(out.replace("/*ONLY*/0", str(only)))
print("wrote", OUT, "and decisions-1/2/3.html", len(out), "bytes; tally", tally, "split", split, "fid", fid, "cost", cost, "errStep", err_step, "change", change)
