# Build the runtime-error visualisation mock-up (runtime-error-viz-v1.html) from the S0 results.
# Every number shown in the mock-up comes from results-20261123/*.json (lab-david runs) or from the
# program text; the explanations are hand-written. Run: python build_mockup.py
import json, os, re, html, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
S0 = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(S0))
RES = os.path.join(S0, "results-20261123")
OUT = os.path.join(HERE, "runtime-error-viz-v1.html")


def load(name):
    p = os.path.join(RES, name)
    if not os.path.exists(p):
        return None
    return json.load(open(p, encoding="utf-8"))


RESULTS = {c: load(f"results-{c}.json") for c in ["cur", "o0", "plain", "san", "sanrec", "sandebug", "plainpch", "sanpch", "depth", "fidelity"]}
TRACES = {c: load(f"traces-{c}.json") for c in ["san", "sanrec"]}
ROWS = {c: {r.get("id"): r for r in (d or {}).get("rows", []) if r.get("id")} for c, d in RESULTS.items()}
TROWS = {c: {r["id"]: r for r in (d or {}).get("rows", [])} for c, d in TRACES.items()}

# program sources (cases.mjs / cases_v2.mjs / examples/cpp/errors)
H = "#include <bits/stdc++.h>\nusing namespace std;\n"
SRC = {}
for f in ["cases.mjs", "cases_v2.mjs"]:
    txt = open(os.path.join(S0, f), encoding="utf-8").read()
    for m in re.finditer(r'\{ id: "([^"]+)", label: "([^"]*)", stdin: "([^"]*)", src: H \+ `(.*?)` \}', txt, re.S):
        SRC[m.group(1)] = {"label": m.group(2), "stdin": m.group(3), "src": H + m.group(4)}
EXD = os.path.join(REPO, "examples", "cpp", "errors")
for f in sorted(os.listdir(EXD)):
    if f.endswith(".cpp"):
        SRC["ex_" + f[:-4]] = {"label": "examples/cpp/errors/" + f, "stdin": "", "src": open(os.path.join(EXD, f), encoding="utf-8").read().replace("\r\n", "\n").rstrip("\n")}


def trace(cid):
    for c in ["san", "sanrec"]:
        if cid in TROWS[c]:
            return TROWS[c][cid]
    return None


def vg(cid, cfg="san"):
    r = ROWS[cfg].get(cid) or {}
    v = r.get("vgerr") or []
    return v[0] if v else None


def nsteps(cid, cfg):
    r = ROWS[cfg].get(cid) or {}
    return r.get("steps")


def step_at(cid, line, before=None, pred=None):
    """1-based number of the last step at `line` before step `before` (1-based, exclusive) that satisfies pred(vars)."""
    t = trace(cid)
    if not t:
        return None
    best = None
    for s in t["steps"]:
        if "gap" in s:
            continue
        n = s["i"] + 1
        if before is not None and n >= before:
            break
        if s["line"] == line and (pred is None or pred(s.get("vars") or {})):
            best = n
    return best


def vars_at(cid, n):
    t = trace(cid)
    for s in t["steps"]:
        if s.get("i") == n - 1:
            return s.get("vars") or {}
    return {}


def raw_of(cid, cfg, how):
    r = ROWS[cfg].get(cid) or {}
    v = r.get("vgerr") or []
    parts = []
    if v:
        parts.append("錯誤紀錄（vgerr.h 寫出）：\n" + "\n".join(json.dumps(x, ensure_ascii=False) for x in v))
    else:
        parts.append("錯誤紀錄：無（這次執行沒有任何檢查觸發）")
    ex = r.get("exit")
    parts.append("結束狀態：" + json.dumps(ex, ensure_ascii=False))
    parts.append("偵測方式：" + how)
    parts.append(f"資料：lab-david S0，設定 {cfg}，案例 {cid}（{SRC[cid]['label']}）")
    return "\n\n".join(parts)


fmt = lambda n: f"{n:,}"
M = lambda s: f'<span class="mono">{html.escape(str(s))}</span>'

KINDS = []


def kind(**k):
    cid = k["case"]
    k.setdefault("src", SRC[cid]["src"])
    k.setdefault("stdin", SRC[cid]["stdin"])
    cfg = "sanrec" if k["status"] == "cont" else "san"
    fatal = ROWS["san"].get(cid) or {}
    if k["status"] in ("design", "none"):
        k.setdefault("errStep", step_at(cid, k["errLine"]))
    k.setdefault("errStep", fatal.get("steps") or None)
    k.setdefault("stepCount", (ROWS[cfg].get(cid) or {}).get("steps") or k["errStep"])
    k.setdefault("stdout", (fatal.get("stdout") or "").rstrip("\n"))
    k.setdefault("origins", [])
    k.setdefault("tag", "")
    KINDS.append(k)


UB = "clang UBSan（-fsanitize=undefined），處理函式寫在 vgerr.h"
LIBCXX = "libc++ 的檢查（_LIBCPP_HARDENING_MODE_EXTENSIVE），訊息經替換的 __assertion_handler 或 __libcpp_verbose_abort 交給 vgerr.h"

# ── 數值 ───────────────────────────────────────────────────────────────────
v = vg("div0_input")
kind(id="div-zero", family="num", chip="整數除以零", title="整數除以零", term="integer division by zero", case="div0_input", status="stop",
     errLine=6, span="a / b", badge="✕ 除以 0",
     headline=f"第 6 行算 {M('a / b')}，這時 a = {v['lhs']}、b = {v['rhs']}。",
     diagram={"type": "expr", "tokens": [{"name": "a", "value": str(v["lhs"])}, {"op": "/"}, {"name": "b", "value": str(v["rhs"]), "bad": True, "note": "除數是 0"}],
              "eq": "7 ÷ 0 沒有答案：找不到一個整數乘以 0 會等於 7。整數除法遇到 0，程式就在這裡停止。"},
     env="原生 Linux 也會在這一行停止（SIGFPE，Arithmetic exception）。",
     origins=[{"name": "b", "value": "0", "line": 5, "code": "cin >> a >> b;", "span": "b", "step": step_at("div0_input", 5), "note": "程式輸入「7 0」的第 2 個數"}],
     fix={"text": "先檢查除數，再做除法。", "diff": [[" ", "  cin >> a >> b;"], ["+", "  if (b == 0) {"], ["+", "    cout << \"除數不能是 0\" << endl;"], ["+", "    return 0;"], ["+", "  }"], [" ", "  int c = a / b;"]]},
     raw=raw_of("div0_input", "san", UB + "：integer-divide-by-zero"))

v = vg("mod0_loop")
cur_mod = (ROWS["cur"].get("mod0_loop") or ROWS["cur"].get("mod0_input") or {}).get("exit") if ROWS["cur"] else None
kind(id="mod-zero", family="num", chip="取餘數 % 0", title="取餘數時除以零", term="remainder by zero", case="mod0_loop", status="stop",
     errLine=5, span="10 % i", badge="✕ % 0",
     headline=f"第 5 行算 {M('10 % i')}，這時 i = {v['rhs']}（迴圈的第一圈）。",
     diagram={"type": "expr", "tokens": [{"name": "10", "lit": True}, {"op": "%"}, {"name": "i", "value": str(v["rhs"]), "bad": True, "note": "除數是 0"}],
              "eq": "% 是「除完以後剩多少」。除數是 0，就沒有「除完」這件事，所以和 ÷ 0 一樣會停止。"},
     env="原生 Linux 也會停止（SIGFPE）。現在的 IRIS 把這個錯誤稱為 SIGSEGV（記憶體錯誤），名稱是錯的（實測，見「實驗結果」）；加了檢查以後會正確顯示。",
     origins=[{"name": "i", "value": "0", "line": 4, "code": "for (int i = 0; i < 3; i++) {", "span": "int i = 0", "step": step_at("mod0_loop", 4), "note": "迴圈從 0 開始"}],
     fix={"text": "迴圈從 1 開始，或在取餘數前先確認除數不是 0。", "diff": [["-", "  for (int i = 0; i < 3; i++) {"], ["+", "  for (int i = 1; i < 3; i++) {"], [" ", "    cout << 10 % i << endl;"]]},
     raw=raw_of("mod0_loop", "san", UB + "：integer-divide-by-zero（% 與 / 用同一個檢查，由欄號分辨運算子）"))

v = vg("intmin_div")
kind(id="int-min-div", family="num", chip="INT_MIN ÷ (−1)", title="整數除法的答案超出 int", term="division overflow", case="intmin_div", status="stop",
     errLine=6, span="a / b", badge="✕ 答案放不下",
     headline=f"第 6 行算 {M('a / b')}，這時 a = {fmt(v['lhs'])}、b = {v['rhs']}。",
     diagram={"type": "edge", "expr": {"tokens": [{"name": "a", "value": fmt(v["lhs"])}, {"op": "/"}, {"name": "b", "value": str(v["rhs"])}]},
              "caption": "int 能存的最大的兩個數，和這次的答案：",
              "cells": [{"v": 2147483646}, {"v": 2147483647, "label": "最大值 INT_MAX"}, {"v": 2147483648, "bad": True, "label": "答案：放不下"}],
              "eq": "−2,147,483,648 ÷ (−1) = 2,147,483,648，比 int 的最大值多 1。"},
     env="原生 Linux（x86）也會停止（SIGFPE）。這個錯誤即使選擇繼續也繼續不了：wasm 遇到它一定中止（實測）。",
     origins=[{"name": "a", "value": fmt(v["lhs"]), "line": 5, "code": "cin >> a >> b;", "span": "a", "step": step_at("intmin_div", 5), "note": "程式輸入「-2147483648 -1」"}],
     fix={"text": "改用 long long 計算。", "diff": [["-", "  cout << a / b << endl;"], ["+", "  cout << (long long)a / b << endl;"]]},
     raw=raw_of("intmin_div", "san", UB + "：signed-integer-overflow（除法）"))

v = vg("ex_err_int_overflow")
cid = "ex_err_int_overflow"
err_n = ROWS["san"][cid]["steps"]
kind(id="ovf-mul", family="num", chip="有號溢位（乘法）", title="有號整數溢位", term="signed integer overflow", case=cid, status="cont",
     errLine=10, span="result * i", badge="✕ 溢位", codeFrom=7, codeTo=19,
     headline=f"第 10 行算 {M('result * i')}，這時 result = {fmt(v['lhs'])}、i = {v['rhs']}。",
     diagram={"type": "bits", "rows": [
         {"label": "數學上的答案", "num": fmt(v["lhs"] * v["rhs"]), "value": v["lhs"] * v["rhs"], "width": 33, "lost": 1, "bad": True,
          "note": "最左邊那一位（第 33 位）放不進 int 的 32 格，<b class=\"r\">被丟掉</b>。"},
         {"label": "int 存進去的值", "num": fmt((v["lhs"] * v["rhs"]) & 0xFFFFFFFF), "value": (v["lhs"] * v["rhs"]) & 0xFFFFFFFF, "padLeft": 1, "sign": True,
          "note": "黃框是符號位元。它是 0，所以結果還是正數：<b>看起來正常，其實是錯的</b>。"}],
         "eq": f"{fmt(v['lhs'])} × {v['rhs']} = {fmt(v['lhs'] * v['rhs'])}，超過 int 的最大值 2,147,483,647（約 {v['lhs'] * v['rhs'] / 2147483647:.1f} 倍）。"},
     after={"button": "繼續執行，看後果", "text": f"程式印出 {M('13! = 1932053504')}（正確答案是 6227020800）。這是實測的輸出。"},
     env="原生 Linux 不會停，會像上面這樣默默算錯。IRIS 在發生的那一步先暫停。",
     origins=[{"name": "result", "value": fmt(v["lhs"]), "line": 10, "code": "result = result * i;", "span": "result = result * i", "step": step_at(cid, 10, before=err_n), "note": "上一圈（i = 12）算出 12!"},
              {"name": "i", "value": str(v["rhs"]), "line": 9, "code": "for (int i = 2; i <= n; i++) {", "span": "i++", "step": step_at(cid, 9, before=err_n), "note": "i++ 讓 i 變成 13"}],
     fix={"text": "改用 long long，它可以存到大約 9.2 × 10¹⁸。", "diff": [["-", "int factorial(int n) {"], ["+", "long long factorial(int n) {"], ["-", "    int result = 1;"], ["+", "    long long result = 1;"]]},
     raw=raw_of(cid, "san", UB + "：signed-integer-overflow（可繼續模式下回報一次後繼續）"))

v = vg("ovf_add")
kind(id="ovf-add", family="num", chip="有號溢位（加法）", title="有號整數溢位", term="signed integer overflow", case="ovf_add", status="cont",
     errLine=5, span="x + 1", badge="✕ 溢位",
     headline=f"第 5 行算 {M('x + 1')}，這時 x = {fmt(v['lhs'])}（int 的最大值）。",
     diagram={"type": "bits", "rows": [
         {"label": "x", "num": fmt(v["lhs"]), "value": v["lhs"], "sign": True},
         {"label": "+ 1", "num": "1", "value": 1},
         {"label": "結果", "num": "−2,147,483,648", "value": -2147483648, "signBad": True, "bad": True,
          "note": "進位一路往左，最後進到<b class=\"r\">符號位元</b>：最大的正數變成最小的負數。"}],
         "eq": "數學上 2,147,483,647 + 1 = 2,147,483,648，int 放不下。"},
     after={"button": "繼續執行，看後果", "text": f"程式印出 {M((ROWS['sanrec'].get('ovf_add') or {}).get('stdout', '').strip())}（實測輸出）。"},
     env="原生 Linux 不會停，結果通常也是負數；但這是未定義行為，編譯器最佳化之後不保證會這樣。",
     origins=[{"name": "x", "value": fmt(v["lhs"]), "line": 4, "code": "int x = 2147483647;", "span": "int x = 2147483647", "step": step_at("ovf_add", 4)}],
     fix={"text": "改用 long long。", "diff": [["-", "  int x = 2147483647;"], ["+", "  long long x = 2147483647;"]]},
     raw=raw_of("ovf_add", "san", UB + "：signed-integer-overflow"))

v = vg("ovf_loop")
err_n = ROWS["san"]["ovf_loop"]["steps"]
cur_loop = (ROWS["cur"].get("ovf_loop") or {}).get("exit") if ROWS["cur"] else None
loop_cur_txt = ""
if cur_loop:
    if cur_loop.get("reason") == "step-limit":
        loop_cur_txt = "實測：現在的 IRIS（-O1，沒有檢查）這個迴圈<b>沒有結束</b>，跑到步數上限才停。"
    elif cur_loop.get("reason") == "exit":
        loop_cur_txt = f"實測：現在的 IRIS（-O1）印出 {M((ROWS['cur']['ovf_loop'].get('stdout') or '').strip())}。"
kind(id="ovf-loop", family="num", chip="靠溢位結束迴圈", title="用溢位讓迴圈結束", term="signed integer overflow", case="ovf_loop", status="cont",
     errLine=5, span="i * 2", badge="✕ 溢位",
     headline=f"第 5 行算 {M('i * 2')}，這時 i = {fmt(v['lhs'])}（2 的 30 次方），迴圈已經跑了 30 圈。",
     diagram={"type": "bits", "rows": [
         {"label": "i", "num": fmt(v["lhs"]), "value": v["lhs"], "sign": True},
         {"label": "i * 2", "num": "放不下", "value": v["lhs"] * 2, "signBad": True, "bad": True,
          "note": "那個 1 移進了符號位元。程式想靠「i 變成負數」讓 i &gt; 0 不成立。"}],
         "eq": "有號整數溢位是未定義行為：編譯器可以假設 i 永遠是正數，把 i &gt; 0 當成永遠成立，迴圈就可能永遠不會結束。" + (("<br>" + loop_cur_txt) if loop_cur_txt else "")},
     after={"button": "繼續執行，看後果", "text": f"在這個引擎上，i 變成 −2,147,483,648，迴圈結束，印出 {M((ROWS['sanrec'].get('ovf_loop') or {}).get('stdout', '').strip())}（實測）。換一個編譯器或最佳化等級，結果可能不同。"},
     origins=[{"name": "i", "value": fmt(v["lhs"]), "line": 5, "code": "for (int i = 1; i > 0; i = i * 2) {", "span": "i = i * 2", "step": step_at("ovf_loop", 5, before=err_n), "note": "上一圈的 i = i * 2"}],
     fix={"text": "用明確的次數或上限結束迴圈，不要依賴溢位。", "diff": [["-", "  for (int i = 1; i > 0; i = i * 2) {"], ["+", "  for (long long i = 1; i <= INT_MAX; i = i * 2) {"]]},
     raw=raw_of("ovf_loop", "san", UB + "：signed-integer-overflow"))

v = vg("shift_big")
kind(id="shift", family="num", chip="位移量太大", title="位移量超過 int 的位元數", term="shift out of bounds", case="shift_big", status="cont",
     errLine=6, span="1 << s", badge=f"✕ 位移 {v['rhs']}",
     headline=f"第 6 行算 {M('1 << s')}，這時 s = {v['rhs']}。",
     diagram={"type": "shift", "lhs": v["lhs"], "rhs": v["rhs"], "lhsName": "1", "rhsName": "s"},
     after={"button": "繼續執行，看後果", "text": f"在這個引擎上印出 {M((ROWS['sanrec'].get('shift_big') or {}).get('stdout', '').strip())}（實測）：位移量 33 被當成 33 除以 32 的餘數 1。這不是 C++ 保證的結果。"},
     env="原生 Linux（x86）通常也是 2，同樣只取位移量的最低 5 個位元。",
     origins=[{"name": "s", "value": str(v["rhs"]), "line": 5, "code": "cin >> s;", "span": "s", "step": step_at("shift_big", 5), "note": "程式輸入「33」"}],
     fix={"text": "先確認位移量在 0～31；需要更大的數就用 long long（0～63）。", "diff": [["-", "  cout << (1 << s) << endl;"], ["+", "  if (s >= 0 && s < 32) cout << (1 << s) << endl;"]]},
     raw=raw_of("shift_big", "san", UB + "：shift-exponent"))

v = vg("float2int")
kind(id="float-cast", family="num", chip="浮點數轉 int 超出範圍", title="浮點數轉成 int 時超出範圍", term="float-cast overflow", case="float2int", status="cont",
     errLine=5, span="d", badge="✕ 放不下",
     headline=f"第 5 行把 {M('d')} 放進 int，這時 d = {fmt(int(v['value']))}。",
     diagram={"type": "numbar", "max": 2147483647, "value": int(v["value"]), "rangeLabel": "int 裝得下的正數：0 ～ 2,147,483,647",
              "valueLabel": f"d = {fmt(int(v['value']))}", "aria": "d 遠超過 int 的範圍",
              "eq": f"{fmt(int(v['value']))} 大約是 int 最大值的 {v['value'] / 2147483647:.1f} 倍。"},
     after={"button": "繼續執行，看後果", "text": f"在這個引擎上 x 變成 {M((ROWS['sanrec'].get('float2int') or {}).get('stdout', '').strip())}（最大值，實測）。原生 x86 通常得到 −2147483648。同一個錯誤，在不同環境的結果不同。"},
     origins=[{"name": "d", "value": "1e10", "line": 4, "code": "double d = 1e10;", "span": "double d = 1e10", "step": step_at("float2int", 4)}],
     fix={"text": "先確認範圍，或改用 long long。", "diff": [["-", "  int x = d;"], ["+", "  long long x = d;"]]},
     raw=raw_of("float2int", "san", UB + "：float-cast-overflow"))

# ── 陣列與容器 ──────────────────────────────────────────────────────────────
cid = "ex_err_array_oob"
v = vg(cid)
err_n = ROWS["san"][cid]["steps"]
st = vars_at(cid, err_n).get("b") or {}
kind(id="arr-oob", family="arr", chip="C 陣列越界", title="陣列越界", term="array index out of bounds", case=cid, status="cont",
     errLine=17, span="b.data[i]", badge=f"✕ 索引 {v['index']}", codeFrom=8, codeTo=21,
     headline=f"第 17 行寫入 {M('b.data[i]')}，這時 i = {v['index']}，但 data 只有 4 格（0～3）。",
     diagram={"type": "structrow",
              "arr": {"name": "b.data", "type": "int[4]", "values": st.get("data", []), "ghost": {"index": v["index"], "chip": f"i = {v['index']}"},
                      "validLabel": "合法索引 0～3", "validWidth": 4 * 40 + 3 * 4},
              "memCaption": "b 在記憶體裡的排列", "target": 4, "after": 40,
              "fields": [{"n": f"data[{i}]", "v": x} for i, x in enumerate(st.get("data", []))] + [{"n": "guard", "v": st.get("guard")}],
              "memNote": "data 的 4 格後面緊接著 guard。data[4] 其實就是 guard 的位置。"},
     after={"button": "繼續執行，看後果", "text": f"guard 從 42 變成 40，程式印出 {M((ROWS['sanrec'].get(cid) or {}).get('stdout', '').strip())}（實測輸出）。"},
     env="原生 Linux 不會停在這裡，guard 一樣會被默默改成 40。IRIS 在寫入之前先暫停。",
     origins=[{"name": "i", "value": str(v["index"]), "line": 16, "code": "for (int i = 0; i <= 4; i++) {", "span": "i <= 4", "step": step_at(cid, 16, before=err_n), "note": "條件寫成 i <= 4，i = 4 也會進入迴圈"}],
     fix={"text": "把條件改成 i < 4。", "diff": [["-", "    for (int i = 0; i <= 4; i++) {   // BUG：應為 i < 4"], ["+", "    for (int i = 0; i < 4; i++) {"]]},
     raw=raw_of(cid, "san", UB + "：array-bounds（可繼續模式下回報一次後繼續）"))

v = vg("arr2d_oob")
kind(id="arr2d-oob", family="arr", chip="二維陣列越界", title="二維陣列的欄越界", term="array index out of bounds", case="arr2d_oob", status="cont",
     errLine=6, span="g[r][c]", badge="✕ c = 3",
     headline=f"第 6 行寫入 {M('g[r][c]')}，這時 r = 1、c = {v['index']}，但每一列只有 3 欄（0～2）。",
     diagram={"type": "grid2d", "name": "g", "type2": "int[3][3]", "values": [[0, 0, 0], [0, 0, 0], [0, 0, 0]], "ghost": [1, 3], "ghostChip": "g[1][3]", "mark": [2, 0], "after": 9,
              "eq": "g[1][3] 不存在。記憶體是一列接一列排的，第 1 列第 3 欄其實落在第 2 列第 0 格 g[2][0]。"},
     after={"button": "繼續執行，看後果", "text": f"g[2][0] 變成 9，程式印出 {M((ROWS['sanrec'].get('arr2d_oob') or {}).get('stdout', '').strip())}（實測）。"},
     env="原生 Linux 也是同樣的排列，一樣會默默改到 g[2][0]。",
     origins=[{"name": "c", "value": str(v["index"]), "line": 5, "code": "int r = 1, c = 3;", "span": "c = 3", "step": step_at("arr2d_oob", 5)}],
     fix={"text": "欄的索引要小於 3。", "diff": [["-", "  int r = 1, c = 3;"], ["+", "  int r = 1, c = 2;"]]},
     raw=raw_of("arr2d_oob", "san", UB + "：array-bounds"))

cid = "vec_oob"
err_n = ROWS["san"][cid]["steps"]
st = vars_at(cid, err_n)
kind(id="vec-oob", family="arr", chip="vector[] 越界", title="vector 索引越界", term="vector index out of bounds", case=cid, status="stop",
     errLine=6, span="v[i]", badge=f"✕ 索引 {st.get('i')}",
     headline=f"第 6 行寫入 {M('v[i]')}，這時 i = {st.get('i')}，但 v.size() 是 {len(st.get('v', []))}（合法索引 0～{len(st.get('v', [])) - 1}）。",
     diagram={"type": "cells", "name": "v", "type2": "vector<int>", "values": st.get("v", []), "sizeLine": f"size() = {len(st.get('v', []))}",
              "headNote": f"capacity() = {st.get('v.capacity()')}", "ghost": {"index": st.get("i"), "chip": f"i = {st.get('i')}"},
              "validLabel": f"合法索引 0～{len(st.get('v', [])) - 1}", "validWidth": len(st.get("v", [])) * 44 - 4,
              "eq": f"v[i] 不會檢查範圍；v.at(i) 會先檢查，超出就停止。"},
     env="原生 Linux 通常不會停在這裡，而是默默寫到 vector 後面的記憶體，之後才在別的地方出問題。IRIS 打開了標準函式庫的檢查，所以會先停下來。",
     origins=[{"name": "i", "value": str(st.get("i")), "line": 5, "code": "for (int i = 0; i <= 5; i++) {", "span": "i <= 5", "step": step_at(cid, 5, before=err_n), "note": "條件寫成 i <= 5"}],
     fix={"text": "條件改成 i < v.size()。", "diff": [["-", "  for (int i = 0; i <= 5; i++) {"], ["+", "  for (int i = 0; i < (int)v.size(); i++) {"]]},
     raw=raw_of(cid, "san", LIBCXX))

kind(id="vec-at", family="arr", chip="at() 越界", title="at() 的索引超出範圍", term="out_of_range", case="vec_at", status="stop",
     errLine=5, span="v.at(5)", badge="✕ 索引 5",
     headline=f"第 5 行呼叫 {M('v.at(5)')}，但 v.size() 是 3（合法索引 0～2）。",
     diagram={"type": "cells", "name": "v", "type2": "vector<int>", "values": vars_at("vec_at", 2).get("v", []), "sizeLine": "size() = 3",
              "ghost": {"index": 5, "chip": "at(5)", "gap": True}, "validLabel": "合法索引 0～2", "validWidth": 3 * 44 - 4,
              "eq": "at() 會先檢查索引。原生程式超出範圍時會丟出 std::out_of_range 例外；IRIS 不支援例外，所以直接停在這一行。"},
     originNone="索引 5 直接寫在程式裡。",
     fix={"text": "索引要小於 v.size()。", "diff": [["-", "  cout << v.at(5) << endl;"], ["+", "  cout << v.at(2) << endl;"]]},
     raw=raw_of("vec_at", "san", LIBCXX))

kind(id="empty-stack", family="arr", chip="空 stack 的 top()", title="從空的 stack 取值", term="empty container", case="stack_empty_top", status="stop",
     errLine=7, span="s.top()", badge="✕ s 是空的",
     headline=f"第 7 行呼叫 {M('s.top()')}，但這時 s 是空的。",
     diagram={"type": "empty", "shape": "stack", "history": [
         {"line": 5, "code": "s.push(1)", "items": vars_at("stack_empty_top", 3).get("s", [])},
         {"line": 6, "code": "s.pop()", "items": vars_at("stack_empty_top", 4).get("s", []), "origin": True},
         {"line": 7, "code": "s.top()", "items": [], "bad": True}],
         "eq": "stack 是空的，top() 沒有東西可以拿。"},
     env="原生 Linux 不會停，可能讀到亂七八糟的值，也可能崩潰。IRIS 打開了標準函式庫的檢查，所以會先停下來。",
     origins=[{"name": "s", "value": "空的", "line": 6, "code": "s.pop();", "span": "s.pop()", "step": step_at("stack_empty_top", 6), "what": "最後一個元素被拿走"}],
     fix={"text": "取值前先確認不是空的。", "diff": [["-", "  cout << s.top() << endl;"], ["+", "  if (!s.empty()) cout << s.top() << endl;"]]},
     raw=raw_of("stack_empty_top", "san", LIBCXX + "（stack 的 top() 內部呼叫 deque::back()）"))

kind(id="empty-queue", family="arr", chip="空 queue 的 front()", title="從空的 queue 取值", term="empty container", case="queue_empty_front", status="stop",
     errLine=5, span="q.front()", badge="✕ q 是空的",
     headline=f"第 5 行呼叫 {M('q.front()')}，但 q 從建立到現在都是空的。",
     diagram={"type": "empty", "shape": "queue", "history": [
         {"line": 4, "code": "queue<int> q", "items": [], "origin": True},
         {"line": 5, "code": "q.front()", "items": [], "bad": True}],
         "eq": "queue 是空的，front() 沒有東西可以拿。"},
     origins=[{"name": "q", "value": "空的", "line": 4, "code": "queue<int> q;", "span": "queue<int> q", "step": step_at("queue_empty_front", 4), "what": "建立時沒有元素"}],
     fix={"text": "取值前先確認不是空的。", "diff": [["-", "  cout << q.front() << endl;"], ["+", "  if (!q.empty()) cout << q.front() << endl;"]]},
     raw=raw_of("queue_empty_front", "san", LIBCXX + "（queue 的 front() 內部呼叫 deque::front()）"))

kind(id="empty-vector", family="arr", chip="空 vector 的 back()", title="從空的 vector 取值", term="empty container", case="vec_empty_back", status="stop",
     errLine=5, span="v.back()", badge="✕ v 是空的",
     headline=f"第 5 行呼叫 {M('v.back()')}，但 v 是空的（size() = 0）。",
     diagram={"type": "empty", "shape": "vector", "history": [
         {"line": 4, "code": "vector<int> v", "items": [], "origin": True},
         {"line": 5, "code": "v.back()", "items": [], "bad": True}],
         "eq": "同一類：空的 vector 呼叫 front()、pop_back()，實測也都會在那一行停下。"},
     origins=[{"name": "v", "value": "空的", "line": 4, "code": "vector<int> v;", "span": "vector<int> v", "step": step_at("vec_empty_back", 4), "what": "建立時沒有元素"}],
     fix={"text": "取值前先確認不是空的。", "diff": [["-", "  cout << v.back() << endl;"], ["+", "  if (!v.empty()) cout << v.back() << endl;"]]},
     raw=raw_of("vec_empty_back", "san", LIBCXX) + "\n\n同類實測（vec_pop_empty）：" + json.dumps(vg("vec_pop_empty"), ensure_ascii=False))

kind(id="str-oob", family="arr", chip="string 索引越界", title="字串索引越界", term="string index out of bounds", case="str_oob", status="stop",
     errLine=5, span="s[10]", badge="✕ 索引 10",
     headline=f"第 5 行讀取 {M('s[10]')}，但 s 只有 3 個字元。",
     diagram={"type": "cells", "name": "s", "type2": "string", "values": list(vars_at("str_oob", 2).get("s", "")), "sizeLine": "size() = 3",
              "extra": [{"index": 3, "text": "\\0"}], "ghost": {"index": 10, "chip": "s[10]", "gap": True},
              "validLabel": "合法索引 0～3（第 3 格是結尾的 \\0）", "validWidth": 4 * 44 + 6,
              "eq": "同一類：s.substr(5) 的起點超過長度，實測也會停在那一行。"},
     origins=[{"name": "s", "value": "\"abc\"", "line": 4, "code": "string s = \"abc\";", "span": "string s = \"abc\"", "step": step_at("str_oob", 4)}],
     fix={"text": "索引要小於 s.size()。", "diff": [["-", "  cout << s[10] << endl;"], ["+", "  if (10 < s.size()) cout << s[10] << endl;"]]},
     raw=raw_of("str_oob", "san", LIBCXX) + "\n\n同類實測（substr_throw）：" + json.dumps(vg("substr_throw"), ensure_ascii=False))

kind(id="stoi", family="arr", chip="stoi 轉換失敗", title="字串無法轉成整數", term="invalid_argument", case="stoi_bad", status="stop",
     errLine=5, span="stoi(s)", badge="✕ 不是數字",
     headline=f"第 5 行把 {M('s')} 轉成整數，但 s = \"abc\"，開頭就不是數字。",
     diagram={"type": "cells", "name": "s", "type2": "string", "values": list(vars_at("stoi_bad", 2).get("s", "")), "badCellIndex": 0,
              "eq": "stoi 從第一個字元開始讀數字；第一個字元 'a' 不是數字，沒辦法轉換。"},
     env="原生程式會丟出 std::invalid_argument 例外；IRIS 不支援例外，所以直接停在這一行。",
     origins=[{"name": "s", "value": "\"abc\"", "line": 4, "code": "string s = \"abc\";", "span": "string s = \"abc\"", "step": step_at("stoi_bad", 4)}],
     fix={"text": "轉換前先確認字串是數字。", "diff": [["-", "  int x = stoi(s);"], ["+", "  int x = (!s.empty() && isdigit(s[0])) ? stoi(s) : 0;"]]},
     raw=raw_of("stoi_bad", "san", LIBCXX))

kind(id="sort-cmp", family="arr", chip="sort 的比較函式", title="sort 的比較函式不合法", term="strict weak ordering", case="sort_bad_cmp", status="stop",
     errLine=5, span="return a <= b;", badge="✕ 比較函式",
     headline=f"第 5 行的 sort 用 {M('a <= b')} 比較 40 個 5；sort 發現自己會讀到範圍外面。",
     diagram={"type": "cmp", "rows": [
         {"call": "cmp(5, 5)", "got": "true（5 <= 5）", "need": "false", "bad": True},
         {"call": "cmp(a, b) 和 cmp(b, a)", "got": "可能都是 true", "need": "最多一個是 true", "bad": True}],
         "eq": "sort 的比較要「嚴格」（strict weak ordering）：同一個值不能排在自己前面，所以 cmp(x, x) 一定要是 false。"},
     origins=[{"name": "v", "value": "40 個 5", "line": 4, "code": "vector<int> v(40, 5);", "span": "v(40, 5)", "step": step_at("sort_bad_cmp", 4), "what": "全部相等"}],
     fix={"text": "用 < 而不是 <=。", "diff": [["-", "  sort(v.begin(), v.end(), [](int a, int b) { return a <= b; });"], ["+", "  sort(v.begin(), v.end(), [](int a, int b) { return a < b; });"]]},
     raw=raw_of("sort_bad_cmp", "san", LIBCXX))

kind(id="unsigned-wrap", family="arr", chip="size() − 1 繞回", title="無號數 0 − 1 繞回最大值", term="unsigned wrap-around", case="unsigned_wrap", status="stop",
     errLine=6, span="v[i]", badge="✕ v 是空的",
     headline=f"第 6 行讀 {M('v[i]')}（i = 0），但 v 是空的。迴圈會進來，是因為第 5 行的 {M('v.size() - 1')} 變成了 4,294,967,295。",
     diagram={"type": "ring", "expr": "v.size() - 1", "value": 4294967295, "aria": "0 減 1 繞到最大值",
              "note": "size() 是無號數（size_t）。0 再減 1 不會變成 −1，而是繞到最大值，所以 i <= v.size() - 1 一開始就成立。",
              "after": {"name": "v", "type2": "vector<int>", "values": [], "sizeLine": "size() = 0", "ghost": {"index": 0, "chip": "i = 0"}}},
     env="這個引擎的 size_t 是 32 位元（wasm32），最大值是 4,294,967,295；原生 64 位元程式是 18,446,744,073,709,551,615，一樣會繞回。",
     origins=[{"name": "v", "value": "空的", "line": 4, "code": "vector<int> v;", "span": "vector<int> v", "step": step_at("unsigned_wrap", 4), "what": "size() = 0"}],
     fix={"text": "不要先減 1，改成 i < v.size()。", "diff": [["-", "  for (size_t i = 0; i <= v.size() - 1; i++) {"], ["+", "  for (size_t i = 0; i < v.size(); i++) {"]]},
     raw=raw_of("unsigned_wrap", "san", LIBCXX + "（抓到的是第 6 行的 vector 越界；第 5 行的繞回是 P3 的提醒）"))

# ── 指標與記憶體 ────────────────────────────────────────────────────────────
kind(id="null-ptr", family="ptr", chip="空指標", title="透過空指標寫入", term="null pointer dereference", case="null_write", status="stop",
     errLine=5, span="*p", badge="✕ p 是 nullptr",
     headline=f"第 5 行透過 {M('*p')} 寫入 5，但 p 是 nullptr。",
     diagram={"type": "nullsimple", "ptr": "p", "type2": "int*", "op": "*p = 5", "pointee": "int", "aria": "p 是 nullptr，沒有指向任何 int",
              "eq": "*p 的意思是「p 指向的那個 int」。p 是 nullptr，沒有指向任何 int，所以沒有地方可以寫。"},
     env="原生 Linux 會在這一行崩潰（SIGSEGV）。IRIS 的瀏覽器引擎原本不會崩潰（位址 0 可以讀寫，程式照樣往下跑）；加了檢查之後會停在這裡。",
     origins=[{"name": "p", "value": "nullptr", "line": 4, "code": "int* p = nullptr;", "span": "int* p = nullptr", "step": step_at("null_write", 4)}],
     fix={"text": "使用前先讓 p 指向一個變數，或先檢查 p 是不是 nullptr。", "diff": [["-", "  int* p = nullptr;"], ["+", "  int x = 0;"], ["+", "  int* p = &x;"]]},
     raw=raw_of("null_write", "san", UB + "：null（寫入）"))

cid = "ex_err_null_deref"
st = vars_at(cid, ROWS["san"][cid]["steps"])
kind(id="null-list", family="ptr", chip="鏈結串列走到 nullptr", title="透過空指標讀成員", term="null pointer dereference", case=cid, status="stop",
     errLine=21, span="cur->next->val", badge="✕ next 是 nullptr", codeFrom=10, codeTo=25,
     headline=f"第 21 行讀 {M('cur->next->val')}：這時 cur 指向最後一個節點，它的 next 是 nullptr。",
     diagram={"type": "nulllist", "cur": "cur", "aria": "鏈結串列 a 到 b，b 的 next 是 nullptr",
              "objs": [{"name": "a", "type": "Node", "val": st.get("a", {}).get("val")}, {"name": "b", "type": "Node", "val": st.get("b", {}).get("val"), "nextNull": st.get("b", {}).get("next") == 0}],
              "chain": [{"text": "cur", "note": "→ b"}, {"text": "->next", "note": "nullptr", "bad": True}, {"text": "->val", "note": "✕ 沒有節點可以讀", "bad": True}],
              "eq": "第一圈 cur 指向 a，讀 a.next-&gt;val = 20 沒問題（已經印出）。第二圈 cur 指向 b，b.next 是 nullptr。"},
     what="箭頭（cur 和 a.next 指向哪個節點）目前的軌跡記錄不到：引擎還不支援指向 struct 的指標，軌跡裡只有 &lt;ptr&gt;。圖上的箭頭是依程式推得的<span class=\"schematic\">示意</span>；val、b.next = nullptr 是實測值。",
     env="原生 Linux 會在這一行崩潰（SIGSEGV）。IRIS 的瀏覽器引擎原本會讀到位址 0 附近的值而不崩潰；加了檢查之後會停在這裡。",
     origins=[{"name": "b.next", "value": "nullptr", "line": 16, "code": "Node b{20, nullptr};", "span": "Node b{20, nullptr}", "step": step_at(cid, 16)}],
     fix={"text": "讀 next 之前先確認它不是 nullptr。", "diff": [["+", "        if (cur->next != nullptr)"], [" ", "        std::cout << \"值：\" << cur->val << \"，下一個值：\" << cur->next->val << std::endl;"]]},
     raw=raw_of(cid, "san", UB + "：null（讀成員）"))

kind(id="double-delete", family="ptr", chip="重複 delete", tag="P3", title="同一塊記憶體 delete 兩次", term="double delete", case="double_delete", status="design", phase="P3",
     errLine=6, span="delete p", badge="✕ 第二次 delete",
     headline=f"第 6 行再 delete 一次 p，但 p 指向的那塊記憶體在第 5 行已經還回去了。",
     diagram={"type": "heap", "caption": "p 指向的那塊記憶體", "events": [
         {"line": 4, "code": "new int(5)", "box": "5", "state": "使用中", "cls": "okc"},
         {"line": 5, "code": "delete p", "box": "5", "state": "已釋放", "cls": "freed"},
         {"line": 6, "code": "delete p", "box": "✕", "state": "已經釋放過", "cls": "badsolid", "bad": True}]},
     what="這張圖要等 P3（IRIS 自己記錄每一次 new 和 delete）才畫得出來。現在的軌跡裡 p 只有 &lt;ptr&gt;。",
     env=f"S0 實測：現在的引擎和加了檢查的版本都沒有發現，程式正常結束，印出 {M((ROWS['san'].get('double_delete') or {}).get('stdout', '').strip())}。原生 Linux（glibc）通常會中止並顯示 double free detected。",
     origins=[{"name": "p", "value": "已釋放", "line": 5, "code": "delete p;", "span": "delete p", "step": step_at("double_delete", 5), "what": "第一次 delete"}],
     fix={"text": "delete 之後把 p 設成 nullptr（delete nullptr 什麼事都不會做）。", "diff": [[" ", "  delete p;"], ["+", "  p = nullptr;"], [" ", "  delete p;"]]},
     raw=raw_of("double_delete", "san", "（S0 沒有實作；P3 取代全域 operator new/delete 後才偵測得到）"))

kind(id="use-after-free", family="ptr", chip="delete 後再使用", tag="P3", title="delete 之後再使用", term="use after free", case="use_after_free", status="design", phase="P3",
     errLine=6, span="*p", badge="✕ 已釋放",
     headline=f"第 6 行透過 p 寫入 7，但 p 指向的記憶體在第 5 行已經 delete 了。",
     diagram={"type": "heap", "caption": "p 指向的那塊記憶體", "events": [
         {"line": 4, "code": "new int(5)", "box": "5", "state": "使用中", "cls": "okc"},
         {"line": 5, "code": "delete p", "box": "5", "state": "已釋放", "cls": "freed"},
         {"line": 6, "code": "*p = 7", "box": "7", "state": "寫進已釋放的地方", "cls": "badsolid", "bad": True}]},
     what="這一類只能部分偵測：要在每次讀寫記憶體之前都檢查，這套瀏覽器工具鏈做不到（沒有 AddressSanitizer）。P3 的做法是釋放後先不重用那塊記憶體、填入特殊值，之後讀到它就標「可能」。",
     env=f"S0 實測：程式正常結束，印出 {M((ROWS['san'].get('use_after_free') or {}).get('stdout', '').strip())}，看起來像沒事。原生 Linux 也常常印出 7，所以這種錯誤很難發現。",
     origins=[{"name": "p", "value": "已釋放", "line": 5, "code": "delete p;", "span": "delete p", "step": step_at("use_after_free", 5), "what": "delete 之後 p 沒有改"}],
     fix={"text": "delete 之後就不要再用 p；需要的話把 p 設成 nullptr。", "diff": [[" ", "  delete p;"], ["-", "  *p = 7;"], ["-", "  cout << *p << endl;"]]},
     raw=raw_of("use_after_free", "san", "（S0 沒有實作）"))

it_x = None
for s in (trace("iter_invalid") or {}).get("steps", []):
    if s.get("line") == 6 and (s.get("vars") or {}).get("v.capacity()") == 6 and "x" in (s.get("vars") or {}):
        it_x = s["vars"]["x"]
        break
kind(id="iter-invalid", family="ptr", chip="迭代器失效", tag="偵測不到", title="迭代器失效", term="iterator invalidation", case="iter_invalid", status="none",
     errLine=6, span="v.push_back(4)", badge="迭代器失效",
     headline=f"第 6 行在 range-for 裡 push_back：vector 換到新的記憶體，迴圈卻還在讀舊的那一塊。",
     diagram={"type": "realloc", "caption": "放第 4 個元素時，capacity() 從 3 變成 6：換一塊更大的記憶體",
              "old": [1, 2, 3], "neu": [1, 2, 3, 4], "it": "迴圈的迭代器",
              "eq": f"實測：下一圈讀到的 x 是 {it_x}，不是 3（舊的記憶體已經還回去，內容不可靠）。" if it_x is not None else ""},
     what="libc++ 19 沒有追蹤迭代器失效的檢查，這一版偵測不到。這張圖只用在錯誤教案。",
     env="原生 Linux 也不會報錯，讀到的值不一定。",
     origins=[{"name": "v.capacity()", "value": "6", "line": 6, "code": "if (x == 2) v.push_back(4);", "span": "v.push_back(4)", "step": step_at("iter_invalid", 6, pred=lambda vv: vv.get("x") == 2), "what": "原本是 3"}],
     fix={"text": "迴圈中不要改變 vector 的大小：先記下要加的元素，迴圈結束後再加。", "diff": [["+", "  bool add = false;"], [" ", "  for (int x : v) {"], ["-", "    if (x == 2) v.push_back(4);"], ["+", "    if (x == 2) add = true;"], [" ", "  }"], ["+", "  if (add) v.push_back(4);"]]},
     raw=raw_of("iter_invalid", "san", "（libc++ 19 沒有這種檢查）"))

# ── 函式與流程 ──────────────────────────────────────────────────────────────
kind(id="missing-return", family="flow", chip="函式沒有回傳值", title="函式沒有回傳值", term="missing return", case="missing_return", status="stop",
     errLine=6, span="}", badge="✕ 沒有 return",
     headline=f"{M('sign(0)')} 走到第 6 行的結尾，途中沒有遇到任何 return。",
     diagram={"type": "path", "railTop": 36, "railH": 48, "lines": [
         {"no": 3, "code": "int sign(int x) {", "note": "x = 0"},
         {"no": 4, "html": "  if (<b>x &gt; 0</b>) <span style=\"color:var(--ink-faint)\">return 1;</span>", "note": "x > 0 是 false", "visited": True},
         {"no": 5, "html": "  if (<b>x &lt; 0</b>) <span style=\"color:var(--ink-faint)\">return -1;</span>", "note": "x < 0 是 false", "visited": True},
         {"no": 6, "code": "}", "note": "沒有 return 就到了結尾", "visited": True, "bad": True}],
         "eq": "函式說好要回傳 int，但 x = 0 時兩個 if 都不成立，沒有任何一行給出回傳值。"},
     env="原生程式不一定會停：可能回傳一個不確定的值，也可能崩潰（這是未定義行為）。IRIS 會停在這裡。",
     origins=[{"name": "x", "value": "0", "line": 8, "code": "cout << sign(0) << endl;", "span": "sign(0)", "step": step_at("missing_return", 8), "what": "呼叫時傳入 0"}],
     fix={"text": "補上 x == 0 的情況。", "diff": [[" ", "  if (x < 0) return -1;"], ["+", "  return 0;"], [" ", "}"]]},
     raw=raw_of("missing_return", "san", UB + "：return（錯誤紀錄的行號是函式開頭第 3 行，停點取軌跡的最後一步第 6 行）"))

ir = trace("inf_recursion") or {}
ds = ir.get("depthSummary") or {}
maxd = ds.get("maxDepth", 0)
first = ds.get("first", [])
last = ds.get("last", [])
items = [{"label": "main()", "depth": "第 1 層", "cls": "main"}]
for d in first[1:6]:
    n = d["vars"].get("n")
    it = {"label": f"f({n})", "depth": f"第 {d['depth']} 層"}
    if n == 3:
        it["note"] = "main 呼叫 f(3)"
    if n == 0:
        it["cls"] = "basemiss"
        it["note"] = "n = 0：應該在這裡停下，但程式沒有寫停止條件"
    items.append(it)
items.append({"gap": f"⋮ 中間還有 {fmt(max(0, maxd - 6 - 3))} 層，每一層的 n 都比下面少 1"})
for d in last[-3:]:
    items.append({"label": f"f({d['vars'].get('n')})", "depth": f"第 {fmt(d['depth'])} 層"})
items[-1]["cls"] = "top"
items[-1]["note"] = "再呼叫一層，堆疊就用完了"
items.append({"line": "堆疊用完（stack overflow）"})
kind(id="inf-rec", family="flow", chip="無窮遞迴", title="無窮遞迴", term="infinite recursion", case="inf_recursion", status="stop",
     errLine=4, span="f(n - 1)", badge="✕ 堆疊用完", errStep=ir.get("stepCount"), stepCount=ir.get("stepCount"),
     headline=f"f(3) 一直呼叫 f(n − 1)，n 經過 0 也沒有停，直到堆疊用完（第 {fmt(maxd)} 層）。",
     diagram={"type": "tower", "items": items, "eq": "每一層的 n 都比上一層少 1，經過 0 也繼續往下：程式沒有任何一層會停。"},
     what=f"層數 {fmt(maxd)} 是在 lab-david 的 Node 量的（堆疊較大）；瀏覽器的層數會少很多，見「遞迴太深」。",
     env="現在的 IRIS 把這種情況說成「瀏覽器引擎的遞迴深度不足」，而且整次執行不能回放。新的做法看軌跡判斷：n 一直往同一個方向走、從沒停下，就判定是程式的無窮遞迴，並且可以回放到最後一步。",
     origins=[{"name": "n", "value": "3", "line": 7, "code": "cout << f(3) << endl;", "span": "f(3)", "step": 1, "what": "第一次呼叫"}],
     fix={"text": "加上終止條件。", "diff": [[" ", "int f(int n) {"], ["+", "  if (n == 0) return 0;"], [" ", "  return f(n - 1) + 1;"]]},
     raw=raw_of("inf_recursion", "san", "執行環境：wasm 呼叫堆疊用完（host call stack exhausted）；無窮遞迴的判斷由軌跡做（P1）"))

dr = trace("deep_recursion") or {}
dds = dr.get("depthSummary") or {}
depth_rows = (RESULTS["depth"] or {}).get("rows", []) if RESULTS["depth"] else []
def depth_of(name, mb):
    for r in depth_rows:
        if r.get("name") == name and r.get("stackSizeMb") == mb:
            res = r.get("result")
            return res.get("maxOk") if isinstance(res, dict) else res
    return None
b_plain, b_san = depth_of("plain", 1), depth_of("san", 1)
LIMIT = b_san if isinstance(b_san, int) else 3734
ceil_txt = "瀏覽器的堆疊上限"
ceil_note = f"約 {fmt(LIMIT)} 層" + ("（1 MB 堆疊實測，加檢查）" if isinstance(b_san, int) else "（2026-09 瀏覽器實測，未加檢查）")
top_n = 5000 - (LIMIT - 2)
deep_items = [{"label": "main()", "depth": "第 1 層", "cls": "main"},
              {"label": "f(5000)", "depth": "第 2 層", "note": "main 呼叫 f(5000)"}, {"label": "f(4999)", "depth": "第 3 層"},
              {"gap": f"⋮ 瀏覽器裡跑得到的層"},
              {"label": f"f({top_n})", "depth": f"第 {fmt(LIMIT)} 層"},
              {"line": ceil_txt, "cls": "limit", "note": ceil_note},
              {"label": f"f({top_n - 1})", "depth": f"第 {fmt(LIMIT + 1)} 層", "cls": "ghostfr", "note": "以上這些層，瀏覽器跑不到，原生程式跑得到"},
              {"gap": "⋮"},
              {"label": "f(0)", "depth": "第 5,002 層", "cls": "basehit", "note": "n = 0：在這裡停下（程式是對的）"}]
kind(id="deep-rec", family="flow", chip="遞迴太深", tag="引擎限制", title="遞迴太深，超過瀏覽器的堆疊", term="engine limit", case="deep_recursion", status="limit",
     errLine=5, span="f(n - 1)", badge="瀏覽器堆疊上限", errStep=None,
     headline=f"f(5000) 需要 5,001 層呼叫。程式是對的，但瀏覽器的堆疊比原生程式小。",
     diagram={"type": "tower", "items": deep_items, "eq": "這個程式有停止條件，n 會一路減到 0；只是需要的層數比瀏覽器給的多。"},
     what="這個程式有終止條件（n == 0），在 lab-david 的 Node 實測可以跑完、印出 5000。",
     env="原生 Linux 的堆疊是 8 MB，5,000 層沒有問題。這不是程式的錯；IRIS 會這樣說明，不會當成程式錯誤。",
     origins=[{"name": "n", "value": "5000", "line": 9, "code": "cin >> n;", "span": "n", "step": step_at("deep_recursion", 9), "what": "程式輸入「5000」"}],
     fix={"text": "程式不用改。要在 IRIS 上看完整過程，改用比較小的輸入（例如 1000）。"},
     raw=raw_of("deep_recursion", "san", "執行環境（瀏覽器堆疊上限）；這個案例在 Node 實測正常結束") + (f"\n\n1 MB 堆疊最大深度：未加檢查 {b_plain}、加檢查 {b_san}" if b_plain else "\n\n1 MB 堆疊的最大深度：量測中"))

kind(id="assert", family="flow", chip="assert 失敗", title="assert 的條件不成立", term="assertion failed", case="assert_fail", status="stop",
     errLine=5, span="assert(x > 0)", badge="✕ 條件不成立",
     headline=f"第 5 行的 {M('assert(x > 0)')} 不成立：x = {vars_at('assert_fail', 2).get('x')}。",
     diagram={"type": "assert", "html": "assert(x &gt; 0);", "parts": [{"col": 7, "value": str(vars_at("assert_fail", 2).get("x")), "depth": 1}, {"col": 9, "value": "false", "depth": 0, "bad": True}],
              "eq": "assert 的意思是「這件事一定成立」。不成立就表示程式的假設錯了，所以立刻停止。"},
     env="原生 Linux 也會停止，並印出 Assertion `x > 0' failed。",
     origins=[{"name": "x", "value": str(vars_at("assert_fail", 2).get("x")), "line": 4, "code": "int x = -3;", "span": "int x = -3", "step": step_at("assert_fail", 4)}],
     fix={"text": "找出 x 為什麼是負數；assert 本身不用改。"},
     raw=raw_of("assert_fail", "san", "覆寫 __assert_fail（vgerr.h），帶出條件式文字"))

kind(id="abort", family="flow", chip="呼叫 abort()", title="程式自己呼叫 abort()", term="abort", case="abort_call", status="stop",
     errLine=5, span="abort()", badge="✕ abort",
     headline=f"第 5 行的程式自己呼叫了 {M('abort()')}，要求立刻結束。",
     diagram={"type": "simple", "eq": "abort() 會立刻結束程式，後面的程式碼都不會執行（第 6 行的 after 沒有印出來）。"},
     env="現在的 IRIS 已經抓得到（SIGABRT）；新的面板只是把它畫出來。",
     origins=[{"name": "x", "value": "1", "line": 4, "code": "int x = 1;", "span": "int x = 1", "step": step_at("abort_call", 4), "what": "所以 if (x == 1) 成立"}],
     fix={"text": "這是程式刻意的行為，不用改。"},
     raw=raw_of("abort_call", "san", "wasm trap（unreachable，來自 abort()）"))

kind(id="bad-alloc", family="flow", chip="記憶體不夠", tag="引擎限制", title="要求的記憶體超過上限", term="bad_alloc", case="huge_vector", status="limit",
     errLine=4, span="v(600000000)", badge="記憶體上限",
     headline=f"第 4 行要 6 億個 int（2.4 GB），超過 IRIS 引擎的記憶體上限 512 MB。",
     diagram={"type": "memlimit", "request": 2400000000, "limit": 536870912, "requestLabel": "2,400,000,000 bytes（2.4 GB）", "limitLabel": "536,870,912 bytes（512 MiB）"},
     env="原生 64 位元程式在記憶體夠大的電腦上可能可以執行。現在的 IRIS 只會說「程式中止（abort）」，分不出是 abort() 還是記憶體不夠；P1 改由 IRIS 自己接手 new，就能說出要了多少。",
     originNone="大小 600000000 直接寫在程式裡。",
     fix={"text": "減少資料量，或分批處理。"},
     raw=raw_of("huge_vector", "san", "wasm trap（abort）：libc++ 的 bad_alloc 在 -fno-exceptions 下直接 abort，S0 的覆寫沒有接到"))

# ── 輸入與未初始化 ──────────────────────────────────────────────────────────
kind(id="uninit", family="input", chip="未初始化的變數", tag="P4", title="讀取沒有初始值的變數", term="uninitialized read", case="uninit_read", status="design", phase="P4",
     errLine=6, span="sum += i", badge="✕ sum 沒有初始值",
     headline=f"第 6 行第一次執行 {M('sum += i')} 時，sum 從來沒有被給過值。",
     diagram={"type": "uninit", "name": "sum", "type2": "int", "declLine": 4, "readLine": 6, "readCode": "sum += i;",
              "eq": "IRIS 把沒有初始值的變數顯示成 0（並標出「未初始化」），這次剛好算出 6。原生程式裡，sum 一開始可能是任何值。"},
     what=f"S0 實測：沒有發現，程式印出 {M((ROWS['san'].get('uninit_read') or {}).get('stdout', '').strip())}。P4 會在讀取時檢查：宣告時沒有給值、之後也還沒寫過的變數被讀取，就在那一步停下。",
     origins=[{"name": "sum", "value": "（沒有值）", "line": 4, "code": "int sum;", "span": "int sum", "step": None, "what": "宣告時沒有給值（這一行沒有停點）"}],
     fix={"text": "宣告時就給初始值。", "diff": [["-", "  int sum;"], ["+", "  int sum = 0;"]]},
     raw=raw_of("uninit_read", "san", "（S0 沒有實作；軌跡的 uninit 欄位已經標出 sum 未初始化）"))

kind(id="cin-fail", family="input", chip="輸入讀不到", tag="P3 提醒", title="cin 沒有讀到資料", term="input failure", case="cin_fail", status="design", phase="P3",
     errLine=5, span="cin >> n", badge="提醒：沒讀到",
     headline=f"第 5 行要讀一個整數到 n，但程式輸入是空的。",
     diagram={"type": "input", "chars": [], "eofLabel": "輸入結束", "code": "cin >> n", "name": "n", "value": str(vars_at("cin_fail", 2).get("n")),
              "valueNote": "讀取失敗時 n 被設成 0，之後的 cin 也都會失敗"},
     what=f"這不是會讓程式停止的錯誤，IRIS 只顯示提醒（S0 實測：程式印出 {M((ROWS['san'].get('cin_fail') or {}).get('stdout', '').strip())}）。",
     originNone="「程式輸入」欄是空的。",
     fix={"text": "在「程式輸入」填入資料，或檢查 cin 有沒有成功。", "diff": [["-", "  cin >> n;"], ["+", "  if (!(cin >> n)) { cout << \"沒有讀到 n\" << endl; return 0; }"]]},
     raw=raw_of("cin_fail", "san", "（P3：vg.h 每一步檢查 cin 狀態）"))

def step_rec(cid, n):
    t = trace(cid)
    if not t or n is None:
        return None
    for st in t["steps"]:
        if st.get("i") == n - 1:
            return {"fn": st["fn"], "vars": st.get("vars") or {}, "uninit": st.get("uninit") or []}
    return None


for k in KINDS:
    va = {}
    if k.get("errStep"):
        r = step_rec(k["case"], k["errStep"])
        if r:
            va[str(k["errStep"])] = r
    for o in k["origins"]:
        if o.get("step"):
            r = step_rec(k["case"], o["step"] + 1)
            if r:
                va[str(o["step"] + 1)] = r
    if k["status"] == "cont" and k["case"] in TROWS["sanrec"]:
        last = [x for x in TROWS["sanrec"][k["case"]]["steps"] if "i" in x][-1]
        va["after"] = {"fn": last["fn"], "vars": last.get("vars") or {}, "uninit": last.get("uninit") or []}
        k["afterVars"] = True
    k["varsAt"] = va
    k["hlVars"] = sorted({o["name"].split(".")[0] for o in k["origins"]})

FAMILIES = [{"id": "num", "label": "數值"}, {"id": "arr", "label": "陣列與容器"}, {"id": "ptr", "label": "指標與記憶體"}, {"id": "flow", "label": "函式與流程"}, {"id": "input", "label": "輸入與未初始化"}]

# the template's diagram renderers use d.type for the renderer and some read d.type for the C++ type
for k in KINDS:
    d = k["diagram"]
    if "type2" in d:
        d["typeName"] = d.pop("type2")
    if d.get("after") and isinstance(d["after"], dict) and "type2" in d["after"]:
        d["after"]["typeName"] = d["after"].pop("type2")
    if d["type"] == "structrow":
        d["arr"]["typeName"] = d["arr"].pop("type")

# ── 實驗結果 ───────────────────────────────────────────────────────────────
SIG = {"div-zero": "SIGFPE", "memory": "SIGSEGV", "abort": "SIGABRT", "other": "SIGSEGV", "timeout": "SIGXCPU"}

# The full "cur" run compiled div0_input first: its cold PCH build overlapped the traces job and hit the compile
# budget (compile-timeout). The smoke run of the same config and commit (results-cur-part.json) has the real result.
_PART = {r["id"]: r for r in (load("results-cur-part.json") or {}).get("rows", [])}
COLD = [c for c, r in _PART.items() if c in ROWS["cur"] and not r.get("errors")
        and any(e.get("kind") == "compile-timeout" for e in (ROWS["cur"][c].get("errors") or []))]
for _c in COLD:
    ROWS["cur"][_c] = _PART[_c]
COLD_NOTE = '<span class="det">取自同一版本的 smoke 那一輪。全量那一輪它排第一個，冷啟動建 PCH 時另一個實驗同時在跑，超過編譯時限。</span>'


def outcome(cfg, cid):
    d = RESULTS.get(cfg)
    if d is None:
        return '<span class="st na">執行中</span>'
    r = ROWS[cfg].get(cid)
    if r is None:
        return '<span class="st na">—</span>'
    if r.get("fail"):
        return f'<span class="st fail">無法編譯</span><span class="det">{html.escape(r["fail"])}</span>'
    errs = [e for e in (r.get("errors") or []) if e.get("kind") not in ("width-warning", "trace-truncated")]
    if errs:
        k0 = errs[0].get("kind")
        label = {"unsupported": "引擎不支援這個語法", "compile": "編譯錯誤", "instrumentation-failed": "插樁失敗"}.get(k0, k0)
        return f'<span class="st fail">{html.escape(label)}</span>'
    v = r.get("vgerr") or []
    ex = r.get("exit") or {}
    out = (r.get("stdout") or "").strip().replace("\n", " ⏎ ")
    if v:
        x = v[0]
        line = x.get("line") or ((r.get("last") or {}).get("line"))
        kindname = x.get("vgerr")
        vals = ", ".join(f"{k}={x[k]}" for k in ("lhs", "rhs", "index", "value", "expr") if k in x)
        if kindname == "libcxx":
            msg = re.sub(r"^/include/c\+\+/v1/[^:]+:\d+: assertion .*? failed: ", "", x.get("msg", "")).strip()
            vals = msg[:70]
        cont = ""
        if cfg == "sanrec" and ex.get("reason") == "exit" and ex.get("code") == 0:
            cont = f"；繼續後輸出 {html.escape(out[:40])}"
        return f'<span class="st caught">✓ 第 {line} 行</span><span class="det"><span class="mono">{html.escape(kindname)}</span> {html.escape(vals)}{cont}</span>'
    reason = ex.get("reason")
    if reason == "trap":
        sig = SIG.get(ex.get("trap"), "SIGSEGV")
        line = (r.get("last") or {}).get("line")
        return f'<span class="st trap">trap → {sig}</span><span class="det">停在第 {line} 行；{html.escape(ex.get("message", "")[:60])}</span>'
    if reason == "stack-overflow":
        return '<span class="st limit">堆疊溢位</span><span class="det">說成「引擎的遞迴深度不足」，不能回放</span>'
    if reason == "step-limit":
        return '<span class="st limit">步數上限</span><span class="det">迴圈沒有結束</span>'
    if reason == "timeout":
        return '<span class="st limit">逾時</span>'
    if reason == "exit" and ex.get("code") == 0:
        return f'<span class="st miss">沒發現</span><span class="det">正常結束，輸出 {html.escape(out[:48]) or "（無）"}</span>'
    return f'<span class="st miss">{html.escape(str(reason))}</span>'


CASE_KIND = {}
for k in KINDS:
    CASE_KIND.setdefault(k["case"], k)
EXTRA_LABEL = {"div0_const": ("num", "整數除以零（兩邊都是常數）"), "div0_unused": ("num", "整數除以零（結果沒被用到）"), "mod0_input": ("num", "取餘數 % 0（值來自輸入）"),
               "ovf_fact": ("num", "有號溢位（20! 迴圈）"), "arr_oob_write": ("arr", "C 陣列越界寫入（i <= 5）"), "arr_oob_read": ("arr", "C 陣列越界讀取（索引 7）"),
               "vec_pop_empty": ("arr", "空 vector 的 pop_back()"), "substr_throw": ("arr", "substr 起點超出長度"), "null_read": ("ptr", "空指標讀取"),
               "ex_err_dangling_ptr": ("ptr", "懸空指標（教案範例）"), "ex_err_double_free": ("ptr", "淺拷貝造成重複釋放（教案範例）"), "ex_err_iterator_invalidation": ("ptr", "迭代器失效（教案範例）"),
               "ex_err_uninit": ("input", "未初始化（教案範例）"), "sort_user_cmp": ("arr", "對照：正確的 sort 比較函式"), "float_div_zero": ("num", "對照：浮點數除以零（不是錯誤，結果 inf）"),
               "vla_neg": ("arr", "int a[n] 的 n 是負數")}
order = []
for f in FAMILIES:
    order.append(("fam", f["label"]))
    for cid in [c for c, k in CASE_KIND.items() if k["family"] == f["id"]] + [c for c, (fa, _) in EXTRA_LABEL.items() if fa == f["id"] and c not in CASE_KIND]:
        order.append(("case", cid))
rows_html = []
for typ, x in order:
    if typ == "fam":
        rows_html.append(f'<tr class="fam"><td colspan="5">{html.escape(x)}</td></tr>')
        continue
    k = CASE_KIND.get(x)
    label = k["chip"] if k else EXTRA_LABEL[x][1]
    rows_html.append(f'<tr><td>{html.escape(label)}<span class="case">{html.escape(x)}</span></td><td>{outcome("cur", x)}{COLD_NOTE if x in COLD else ""}</td><td>{outcome("o0", x)}</td><td>{outcome("san", x)}</td><td>{outcome("sanrec", x)}</td></tr>')


def med(cfg, key):
    rr = [r for r in ROWS[cfg].values() if isinstance(r.get(key), (int, float))] if RESULTS.get(cfg) else []
    if not rr:
        return None
    xs = sorted(r[key] for r in rr)
    return statistics.median(xs), xs[-1], len(xs)


def metric(title, cfgs, key, unit, note=""):
    parts = []
    for label, cfg in cfgs:
        m = med(cfg, key)
        parts.append(f'<div class="d2">{html.escape(label)}：' + (f'<b class="mono">{m[0] / (1000 if unit == "s" else 1):.1f}{unit}</b>（最大 {m[1] / (1000 if unit == "s" else 1):.1f}{unit}，{m[2]} 個）' if m else '<span class="pending">執行中</span>') + '</div>')
    return f'<div class="metric"><div class="k">{html.escape(title)}</div>{"".join(parts)}{f"<div class=d2>{note}</div>" if note else ""}</div>'


def size_metric():
    a, b = med("plain", "wasmBytes"), med("san", "wasmBytes")
    if not a or not b:
        return '<div class="metric"><div class="k">wasm 大小（中位數）</div><div class="d2"><span class="pending">執行中</span></div></div>'
    return f'<div class="metric"><div class="k">wasm 大小（中位數）</div><div class="v">{a[0] / 1e6:.2f} → {b[0] / 1e6:.2f}<small> MB</small></div><div class="d2">未加檢查 → 加檢查</div></div>'


def depth_metric():
    if not depth_rows:
        return '<div class="metric"><div class="k">最大遞迴深度</div><div class="d2"><span class="pending">執行中</span></div></div>'
    cells = []
    for mb in (1, 4):
        a, b = depth_of("plain", mb), depth_of("san", mb)
        cells.append(f'<div class="d2">堆疊 {mb} MB：<b class="mono">{a if not isinstance(a, int) else fmt(a)}</b> → <b class="mono">{b if not isinstance(b, int) else fmt(b)}</b> 層</div>')
    return f'<div class="metric"><div class="k">最大遞迴深度（未加檢查 → 加檢查）</div>{"".join(cells)}</div>'


def fidelity_metric():
    d = RESULTS.get("fidelity")
    if not d:
        return '<div class="metric"><div class="k">軌跡一致性（沒有錯誤的程式）</div><div class="d2"><span class="pending">執行中</span></div></div>'
    rr = d["rows"]
    ran = [r for r in rr if "sameSteps" in r]
    same_steps = [r for r in ran if r["sameSteps"]]
    flagged = [r for r in ran if r.get("vgerr")]
    f2 = load("results-fid2.json")
    if not f2:
        same = [r for r in same_steps if r["sameStdout"]]
        return f'<div class="metric"><div class="k">軌跡一致性（教案與 E3 程式）</div><div class="v">{len(same)} / {len(ran)}<small> 支相同</small></div><div class="d2">停點與輸出逐一比對；其中 {len(flagged)} 支觸發了檢查</div></div>'
    # follow-up run (fid2.mjs): whole-trace comparison of the programs that differed, with a layout-only control
    explained = [c for c in f2["cmp"] if c.get("skelDiffAt") == -1 and c.get("stdoutSame")]
    hung = [r for r in flagged if ((r.get("exit") or [{}])[0] or {}).get("reason") == "timeout"]
    intended = [r for r in flagged if r not in hung]
    names = "、".join(os.path.basename(r["id"]).replace(".json", "") for r in hung)
    nl = sum(c["nLayout"] for c in explained)
    no = sum(c["nOther"] for c in explained)
    return (f'<div class="metric"><div class="k">軌跡一致性（教案與 E3 程式）</div>'
            f'<div class="v">{len(same_steps) + len(explained)} / {len(ran)}<small> 支停點相同</small></div>'
            f'<div class="d2">{len(same_steps)} 支每一步都相同；{len(explained)} 支只有本來就不固定的值不同'
            f'（{nl} 筆在只移動記憶體位置、不加檢查的對照組也會變，{no} 筆是物件成員還沒給值前的內容）。'
            f'{len(intended)} 支是故意寫錯的教案，在出錯處停下；{len(hung)} 支（{names}）不加檢查也跑不完，是插樁的既有問題。</div></div>')


exp_html = f'''
<div class="expcard"><h2>目標 1：錯誤會不會被看到</h2>
<div class="sub">每一列是一個小程式，在 lab-david 實際編譯執行。「現在」是正式機目前的引擎（-O1，沒有檢查）；「加檢查」是 S0 試作版（UBSan＋libc++ 檢查＋vgerr.h），「停止」與「可繼續」是錯誤發生後的兩種處理方式。</div>
<div class="legend"><span><span class="st caught">✓</span> 停在正確的行，帶出值</span><span><span class="st trap">trap</span> 停下來了，但只有訊號名稱</span><span><span class="st miss">沒發現</span> 程式正常結束</span><span><span class="st limit">限制</span> 堆疊、步數上限</span></div>
<table class="res"><thead><tr><th style="width:23%">錯誤</th><th>現在（-O1）</th><th>改成 -O0</th><th>加檢查・停止</th><th>加檢查・可繼續</th></tr></thead><tbody>
{"".join(rows_html)}
</tbody></table></div>
<div class="expcard"><h2>代價</h2><div class="sub">編譯時間是在 lab-david（容器 2 CPU）量的，不是瀏覽器的數字；瀏覽器要另外量。</div>
<div class="metrics">
{metric("編譯＋連結（沒有 PCH）", [("未加檢查", "plain"), ("加檢查", "san")], "tCompileLink", "s")}
{metric("編譯＋連結（有 PCH）", [("未加檢查", "plainpch"), ("加檢查", "sanpch")], "tCompileLink", "s", "引擎的預算是 8 秒")}
{metric("現在的引擎整次編譯（含 PCH）", [("-O1", "cur"), ("-O0", "o0")], "tCompile", "s")}
{size_metric()}
{depth_metric()}
{fidelity_metric()}
</div></div>'''

meta_t = []
for c in ["cur", "o0", "plain", "san", "sanrec", "sandebug", "plainpch", "sanpch", "depth", "fidelity"]:
    meta_t.append(f"{c}{'' if RESULTS.get(c) else '（執行中）'}")
prov = ("數值取自 lab-david 實測（2026-11-23，commit 42b297e9；加檢查的是 S0 試作版，引擎本身沒有改）。"
        "面板採 2026-11-23 規劃的暫定決定：出錯那一步自動暫停、右側欄自動展開、該行標紅。")

DATA = {"kinds": KINDS, "families": FAMILIES, "expHtml": exp_html, "prov": prov, "configs": meta_t}
tpl = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
out = tpl.replace("/*__DATA__*/", "const DATA = " + json.dumps(DATA, ensure_ascii=False) + ";")
open(OUT, "w", encoding="utf-8", newline="\n").write(out)
print("wrote", OUT, len(out), "bytes;", len(KINDS), "kinds; configs:", ", ".join(meta_t))
