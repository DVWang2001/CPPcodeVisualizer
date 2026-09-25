# 在 GDB 內執行：對 main 一路 `next`，記錄每一站的行號與作用域內變數。輸出 JSON 到指定檔案。
# 用法：gdb -q -batch -x gdbref.py --args ./bin   （環境變數 REF_IN=輸入檔、REF_OUT=輸出檔、REF_MAX=最多步數）
import gdb, json, os

INP = os.environ.get("REF_IN", "/dev/null")
OUT = os.environ.get("REF_OUT", "/tmp/ref.json")
MAXN = int(os.environ.get("REF_MAX", "3000"))
GLOBALS = [g for g in os.environ.get("REF_GLOBALS", "").split(",") if g]
MODE = os.environ.get("REF_MODE", "next")   # next=單步跨過函式；step=進入函式
# REF_EXPRS：JSON 檔，{"行號": ["表達式", ...]}；在該行的每個停駐點，用 GDB 自己求值當標準答案
CAPS = [c for c in os.environ.get("REF_CAPS", "").split(",") if c]   # 每一站對這些 vector 變數求 name.capacity()
EXPRS = json.load(open(os.environ["REF_EXPRS"])) if os.environ.get("REF_EXPRS") else {}

gdb.execute("set pagination off")
gdb.execute("set confirm off")
for pat in ("/usr/include/c++/*", "/usr/include/c++/*/*", "/usr/include/c++/*/*/*", "/usr/include/c++/*/*/*/*",
            "/usr/include/x86_64-linux-gnu/c++/*/*/*", "/usr/include/x86_64-linux-gnu/*/*/*"):
    gdb.execute("skip -gfi %s" % pat)   # step 只進入使用者自己的函式，不進標準函式庫
gdb.execute("break main")
gdb.execute("run < %s > /dev/null" % INP)

INT_CODES = (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_CHAR)

def dump(v, depth=0):
    if depth > 6:
        return "<deep>"
    t = v.type.strip_typedefs()
    if t.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
        return dump(v.referenced_value(), depth + 1)   # 參考：看它指向的值
    viz = gdb.default_visualizer(v)
    if viz is not None and hasattr(viz, "children"):
        kids = [dump(c[1], depth + 1) for c in viz.children()]
        hint = viz.display_hint() if hasattr(viz, "display_hint") else None
        if hint == "map":   # map 的美化印表機把 key、value 攤平交錯；兩兩併成 [key, value]
            return [[kids[i], kids[i + 1]] for i in range(0, len(kids) - 1, 2)]
        return kids
    if t.code == gdb.TYPE_CODE_ARRAY:
        lo, hi = t.range()
        return [dump(v[i], depth + 1) for i in range(lo, hi + 1)]
    if t.code in INT_CODES:
        return int(v)
    if t.code == gdb.TYPE_CODE_FLT:
        return float(v)
    if viz is not None:
        sv = str(v)   # std::string 等：GDB 顯示成 "abc"，轉成純字串好跟我們的 JSON 比
        if sv.startswith('"'):
            try:
                return json.loads(sv)
            except Exception:
                return sv[1:-1]
        return sv
    return "<?>"

def frame_vars(fr):
    out = {}
    block = fr.block()
    while block is not None:
        for sym in block:
            if (sym.is_variable or sym.is_argument) and sym.name not in out:
                try:
                    out[sym.name] = dump(sym.value(fr))
                except Exception as e:
                    out[sym.name] = "<err>"
        if block.function is not None:
            break
        block = block.superblock
    for name in GLOBALS:   # 全域變數：用目前的作用域解析（被區域變數遮蔽時就是區域那個，跟 C++ 一致）
        if name not in out:
            try:
                out[name] = dump(gdb.parse_and_eval(name))
            except Exception:
                pass
    return out

steps = []
for _ in range(MAXN):
    try:
        fr = gdb.selected_frame()
    except gdb.error:
        break
    sal = fr.find_sal()
    if sal.symtab is None:
        break   # 離開 main 進到沒有除錯資訊的 libc：結束
    if MODE == "next" and fr.name() != "main":
        break
    rec = {"line": sal.line, "fn": fr.name(), "vars": frame_vars(fr)}
    if EXPRS.get(str(sal.line)):
        ev = {}
        for ex in EXPRS[str(sal.line)]:
            try:
                ev[ex] = {"ok": dump(gdb.parse_and_eval(ex))}
            except Exception as e:
                ev[ex] = {"err": str(e)[:120]}
        rec["exprs"] = ev
    caps = {}
    for cn in CAPS:
        if cn in rec["vars"]:
            try:
                # 直接讀 libstdc++ 的成員（結尾指標 − 起始指標），不呼叫任何函式：
                # 呼叫 capacity() 在程式沒用到它時會失敗，在遞迴 step 途中還會干擾單步。
                impl = gdb.parse_and_eval(cn)["_M_impl"]
                caps[cn] = int(impl["_M_end_of_storage"] - impl["_M_start"])
            except Exception as e:
                caps[cn] = "<err>"
    if caps:
        rec["caps"] = caps
    steps.append(rec)
    try:
        gdb.execute(MODE, to_string=True)
    except gdb.error:
        break

json.dump(steps, open(OUT, "w"))
print("REF_STEPS", len(steps))
