"""AI 生成教案的評分：硬性門檻 G + 結構分 S（機器）+ 教學品質 Q（另一個模型代評）。

    python scripts/score_lesson.py 教案.gdbgui.json
    python scripts/score_lesson.py 教案.cpp --original 原始.cpp   # 多一道 G1：程式碼沒被改
    python scripts/score_lesson.py 教案.gdbgui.json --judge --judge-model <模型名>
    python scripts/score_lesson.py 教案.cpp --json                # 給實驗腳本吃

評分標準見對話紀錄／AUTHORING_GUIDE 第九章。第 0 層（G）任一項不過，整份記 0 分；
S 每項 0~2 分，Q 每項 0~2 分（不適用的題型回 null，不計入分母）。

S 這層都是啟發式的靜態判斷，不是 GDB 實跑：它抓得到「標在不會停的行」「自創的 @N」
這類模型常犯的錯，抓不到語意。真正的驗收仍是 Import 後按 Run。
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import check_lesson as cl  # noqa: E402

PANELS = {"compile_errors", "memory_watch", "callgraph", "visualizer", "container",
          "locals", "watch_table", "live_quiz"}

# --- 靜態分類 -------------------------------------------------------------------

#: 這些「不是停駐點」。注意函式右大括號（第 0 欄的單獨 `}`）是停駐點，所以不在這裡。
_PREPROC = re.compile(r"^\s*(#|using\b|//|$)")
_BRACE_ONLY = re.compile(r"^\s*[{}]\s*;?\s*$")
_ELSE_LINE = re.compile(r"^\s*\}\s*else\b[^;]*\{?\s*$")
_FUNC_DEF = re.compile(r"^[A-Za-z_][\w:<>,\s\*&]*\s+\**&?(\w+)\s*\([^;]*\)\s*(const\s*)?\{?\s*$")
_TYPE_DEF = re.compile(r"^\s*(struct|class|namespace|enum)\b")
_GLOBAL_DECL = re.compile(r"^[A-Za-z_].*;\s*$")
_BARE_DECL = re.compile(
    r"^\s+(?:(?:const|static|unsigned|long|short)\s+)*[A-Za-z_][\w:]*(?:<[\w:,<>\s\*]*>)?[\s\*&]+\w+(?:\[[^\]]*\])*\s*;\s*$")
_NOT_TYPES = {"return", "break", "continue", "goto", "throw", "delete", "case", "else"}
_LOOP_HEAD =re.compile(r"^\s*(for|while)\b|^\s*do\s*\{?\s*$")


def code_part(line):
    return line.split("//@", 1)[0].rstrip()


def is_stop_line(code):
    """GDB 會不會停在這一行（啟發式）。"""
    if _PREPROC.match(code) or _TYPE_DEF.match(code) or _ELSE_LINE.match(code):
        return False
    if _FUNC_DEF.match(code) or _GLOBAL_DECL.match(code) and not code.startswith((" ", "\t")):
        return False
    if _BRACE_ONLY.match(code):
        # 第 0 欄的單獨 `}` 是函式（或 main）收尾，會停；其餘區塊結尾、`};` 都不會
        return code.rstrip() == "}"
    if _BARE_DECL.match(code) and code.split()[0] not in _NOT_TYPES:
        return False  # 縮排內「無初值宣告」：int x;
    return True


def loop_depths(lines):
    """每行：這一行可能被執行幾次以上 → True 表示可能多次（在迴圈內或 main 以外的函式內）。"""
    many = []
    stack = []  # 每層 '{' 的種類："loop" / "main" / "func" / "other"
    for line in lines:
        code = code_part(line)
        multi = any(k in ("loop", "func") for k in stack) or bool(_LOOP_HEAD.match(code))
        many.append(multi)
        kind = "other"
        if _LOOP_HEAD.match(code):
            kind = "loop"
        elif _FUNC_DEF.match(code):
            kind = "main" if re.search(r"\bmain\s*\(", code) else "func"
        for ch in re.sub(r'"(\\.|[^"\\])*"', '""', code):
            if ch == "{":
                stack.append(kind)
                kind = "other"
            elif ch == "}" and stack:
                stack.pop()
    return many


def skipped_by_continue(lines):
    """[continue] 之後到下一個 //@ 之前的行不會被停到（§8.1）。"""
    skipped, skipping = set(), False
    for i, line in enumerate(lines, 1):
        found = cl.fields(line)
        if found is not None:
            skipping = False
            if found.get("tts", "").split("|")[0].strip().startswith("[continue]"):
                skipping = True
        elif skipping:
            skipped.add(i)
    return skipped


def tier(bad, ok_max=0, mid_max=2):
    return 2 if bad <= ok_max else 1 if bad <= mid_max else 0


# --- 第 0 層 --------------------------------------------------------------------

def gate_g2(raw):
    if "```" in raw:
        return "輸出含 markdown 圍欄"
    for n, line in enumerate(raw.split("\n"), 1):
        if re.match(r"^[一-鿿]", line):
            return f"第 {n} 行是行首中文說明文字（不在註解內）"
    return None


def gate_g6(lines):
    problems = []
    for n, line in enumerate(lines, 1):
        if "//@" not in line:
            continue
        body = line.split("//@", 1)[1]
        if body.count("//@"):
            problems.append((n, "一行出現多個 //@"))
        for m in re.finditer(r"@([A-Za-z_]\w*)", re.sub(r"\[fast @[^\]]*\]", "", body)):
            if m.group(1) not in ("guide", "tts", "layout"):
                problems.append((n, f"未知欄位關鍵字 @{m.group(1)}"))
        found = cl.fields(line) or {}
        for key, value in found.items():
            if value.count("{") != value.count("}"):
                problems.append((n, f"@{key} 的 {{ }} 不成對"))
        for m in re.finditer(r"\b(open|close):([\w,]+)", found.get("layout", "")):
            for pid in m.group(2).split(","):
                if pid not in PANELS:
                    problems.append((n, f"layout 的面板 ID 不存在：{pid}"))
    return problems


# --- 第 1 層：S -----------------------------------------------------------------

def s1(lines):
    bad = [n for n, ln in enumerate(lines, 1)
           if "//@" in ln and not is_stop_line(code_part(ln))
           and ((cl.fields(ln) or {}).get("tts") or (cl.fields(ln) or {}).get("guide"))]
    return tier(len(bad)), f"標在不會停的行：{bad[:8]}" if bad else "ok"


def s2(lines):
    many = loop_depths(lines)
    funcs = set(functions(lines))
    bad = []
    for n, ln in enumerate(lines, 1):
        found = cl.fields(ln)
        if not found or many[n - 1]:
            continue
        for seg in found.get("tts", "").split("|"):
            m = re.match(r"\s*@(\d+)", seg)
            # 呼叫自訂函式的行會停兩次（出發與返回，§1.3），所以 @2 是合法的
            calls = any(re.search(r"\b" + f + r"\s*\(", code_part(ln)) for f in funcs)
            if m and int(m.group(1)) >= (3 if calls else 2):
                bad.append(n)
                break
    return tier(len(bad)), f"只會執行一次的行卻有 @N≥2：{bad[:8]}" if bad else "ok"


def s3(lines):
    bad = []
    for n, ln in enumerate(lines, 1):
        found = cl.fields(ln)
        m = re.match(r"^\s*for\s*\(\s*(?:[\w:<>]+\s+)+(\w+)\s*=", code_part(ln))
        if not found or not m:
            continue
        var = m.group(1)
        for key in ("guide", "tts"):
            for token in re.findall(r"\{[^}]*\}", found.get(key, "")):
                if re.search(r"\b" + re.escape(var) + r"\b", token):
                    bad.append(n)
    return tier(len(set(bad)), 0, 1), f"for 行引用自己的迴圈變數：{sorted(set(bad))}" if bad else "ok"


def s4(lines, program_input):
    code = "\n".join(code_part(ln) for ln in lines)
    has_read = bool(re.search(r"\b(cin\s*>>|getline|scanf)", code))
    bad = []
    if has_read:
        for n, ln in enumerate(lines, 1):
            if re.search(r"\b(cin\s*>>|getline|scanf)", code_part(ln)):
                found = cl.fields(ln)
                if found and (found.get("guide") or
                              re.sub(r"^\s*\[continue\]\s*", "", found.get("tts", "")).strip()):
                    bad.append(n)
    elif program_input and program_input.strip():
        return 0, "程式沒有讀入，program_input 卻非空"
    if not has_read and not program_input:
        return None, "不適用（沒有讀資料）"
    return tier(len(bad), 0, 1), f"讀資料的行有旁白：{bad}" if bad else "ok"


def functions(lines):
    """回傳 {函式名: (起行, 迄行)}（1-based）。以第 0 欄開頭、下一個第 0 欄 `}` 結尾。"""
    out, name, start = {}, None, 0
    for n, ln in enumerate(lines, 1):
        code = code_part(ln)
        m = _FUNC_DEF.match(code)
        if m and name is None and not code.startswith(("if", "for", "while")):
            name, start = m.group(1), n
        elif name and code.rstrip() == "}":
            out[name] = (start, n)
            name = None
    return out


def s5(lines):
    recursive = {}
    for fname, (a, b) in functions(lines).items():
        body = lines[a:b - 1]
        if any(re.search(r"\b" + fname + r"\s*\(", code_part(x)) for x in body):
            recursive[fname] = (a, b)
    if not recursive:
        return None, "不適用（沒有遞迴）"
    fails = []
    for fname, (a, b) in recursive.items():
        body = [(a + 1 + i, x) for i, x in enumerate(lines[a:b - 1])]
        returns = [(n, x) for n, x in body if re.search(r"\breturn\b\s*[^;\s]", code_part(x))]
        if returns and any(not re.search(r"\breturn\s+result\s*;", code_part(x)) for _, x in returns):
            fails.append(f"{fname}: return 的不是 result")
        if any(len(re.findall(r"\b" + fname + r"\s*\(", code_part(x))) > 1 for _, x in body):
            fails.append(f"{fname}: 一行多個遞迴呼叫")
        for n, x in returns:
            if re.search(r"\breturn\s+result\s*;", code_part(x)):
                g = (cl.fields(x) or {}).get("guide", "")
                if not ("回傳" in g and "←" in g):
                    fails.append(f"{fname}:{n} return 行 guide 缺「回傳 … ← 由來」")
                    break
        calls = [(n, x) for n, x in body if re.search(r"\b" + fname + r"\s*\(", code_part(x))]
        for n, x in calls:
            tts = (cl.fields(x) or {}).get("tts", "")
            if tts and not re.search(r"\[step-in\]", tts.split("|")[0]):
                fails.append(f"{fname}:{n} 呼叫行第一段不是 [step-in]")
                break
        results = [n for n, x in body if re.match(r"^\s*(int|long long|double|bool)\s+result\b", code_part(x))]
        if len(results) > 1:
            fails.append(f"{fname}: result 重複宣告")
    return tier(len(fails), 0, 1), "; ".join(fails) if fails else "ok"


def s7(lines):
    """沒有呼叫圖（只有 main）時，guide 只該放變數；純敘述的 @guide 是在重講 @tts。"""
    if set(functions(lines)) - {"main"}:
        return None, "不適用（有 main 以外的函式，guide 文字標籤給呼叫圖用）"
    bad = [n for n, ln in enumerate(lines, 1)
           if (cl.fields(ln) or {}).get("guide") and "{" not in cl.fields(ln)["guide"]]
    return tier(len(bad), 0, 2), f"純敘述的 @guide：{bad[:8]}" if bad else "ok"


def s6(lines):
    if cl.mode_of("\n".join(lines)) != "autoplay":
        return None, "不適用（不是自動播放教案）"
    skipped = skipped_by_continue(lines)
    stops = [n for n, ln in enumerate(lines, 1) if is_stop_line(code_part(ln)) and n not in skipped]
    if not stops:
        return 0, "找不到停駐行"
    covered = [n for n in stops if (cl.fields(lines[n - 1]) or {}).get("tts")]
    ratio = len(covered) / len(stops)
    miss = [n for n in stops if n not in covered]
    return (2 if ratio >= 0.95 else 1 if ratio >= 0.8 else 0), f"覆蓋 {ratio:.0%}，漏：{miss[:8]}"


# --- 第 2 層：Q（模型代評）---------------------------------------------------------

Q_RUBRIC = """你是教案品質評審。下面是一份「行尾帶 //@ 註解」的 C++ 教案。逐項給 0/1/2 分（2=完全做到、1=部分、0=沒有或做錯）；
該題型不適用就給 null。只輸出 JSON，格式 {"Q1":{"score":2,"why":"一句話"},...}，不要其他文字。

Q1 旁白與程式一致：不說程式沒做的事、數字與範圍和程式相符（例如說「所有因數」卻只算到 9 就是 0 分）。
Q2 旁白用 {變數} 顯示即時值，不把測資數字寫死。
Q3 版面合題：沒有函式呼叫就不開 callgraph；沒有容器就不開 container；最後一站可開 watch_table。
Q4 重複進入的行逐步簡化（第一次詳細，之後簡短），而不是每次都講同一句。
Q5 @guide 盡量只放變數／容器，敘述放 @tts（遞迴的 callgraph 標籤除外）。
Q6 旁白提到容器的某一格時，同一行有 {容器[索引]:顏色} 高亮、@layout pop:、@tts [anim]。沒有容器就 null。
Q7 「兩值相加寫進某一格」的行有 pull:。沒有這種行就 null。
"""


def judge(source, model, base_url):
    key = os.environ.get("LESSON_AI_API_KEY") or os.environ.get("NVIDIA_API_KEY")
    if not key:
        raise SystemExit("--judge 需要環境變數 LESSON_AI_API_KEY 或 NVIDIA_API_KEY")
    body = json.dumps({
        "model": model, "temperature": 0, "max_tokens": 4096,
        "messages": [{"role": "system", "content": Q_RUBRIC},
                     {"role": "user", "content": source}],
    }).encode()
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", body, {
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=600) as resp:
        text = json.load(resp)["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0)) if m else {}


# --- 整合 -----------------------------------------------------------------------

def load_lesson(path):
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        b = json.loads(raw)
        return b["source_code"], b.get("program_input", ""), {int(x["line"]) for x in b.get("breakpoints") or []}
    return raw, "", None


def load_code_unchanged():
    spec = importlib.util.spec_from_file_location("lesson_gen", ROOT / "gdbgui/server/lesson_gen.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.code_unchanged


def score(source, program_input="", breakpoints=None, original=None, raw=None):
    lines = source.split("\n")
    gates = {}
    gates["G1"] = (load_code_unchanged()(original, source) if original is not None else None)
    gates["G2"] = gate_g2(raw if raw is not None else source)
    problems, _ = cl.check(source, breakpoints)
    gates["G3"] = "; ".join(f"{n}:{m}" for n, m in problems if "@tts" in m and "段落" not in m) or None
    gates["G4"] = "; ".join(f"{n}:{m}" for n, m in problems if "段落" in m or "[continue]" in m) or None
    gates["G5"] = "; ".join(f"{n}:{m}" for n, m in problems if "還沒有值" in m) or None
    gates["G6"] = "; ".join(f"{n}:{m}" for n, m in gate_g6(lines)) or None
    failed = {k: v for k, v in gates.items() if v}
    s = {"S1": s1(lines), "S2": s2(lines), "S3": s3(lines),
         "S4": s4(lines, program_input), "S5": s5(lines), "S6": s6(lines), "S7": s7(lines)}
    got = [v[0] for v in s.values() if v[0] is not None]
    pct = round(100 * sum(got) / (2 * len(got))) if got else 0
    return {"gates_failed": failed, "gates_passed": not failed,
            "S": {k: {"score": v[0], "note": v[1]} for k, v in s.items()},
            "S_percent": 0 if failed else pct}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("lesson")
    ap.add_argument("--original", help="輸入給模型的原始程式（.cpp），用來檢查 G1")
    ap.add_argument("--judge", action="store_true")
    ap.add_argument("--judge-model", default=os.environ.get("LESSON_JUDGE_MODEL", "deepseek-ai/deepseek-v4.1-flash"))
    ap.add_argument("--judge-base-url", default="https://integrate.api.nvidia.com/v1")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv[1:])

    path = Path(args.lesson)
    source, program_input, breakpoints = load_lesson(path)
    original = Path(args.original).read_text(encoding="utf-8") if args.original else None
    result = score(source, program_input, breakpoints, original)
    if args.judge:
        q = judge(source, args.judge_model, args.judge_base_url)
        vals = [v.get("score") for v in q.values() if isinstance(v, dict) and v.get("score") is not None]
        result["Q"] = q
        result["Q_percent"] = round(100 * sum(vals) / (2 * len(vals))) if vals else None

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0
    print(f"{path.name}")
    for k, v in result["gates_failed"].items():
        print(f"  門檻 {k} 未過：{v}")
    for k, v in result["S"].items():
        print(f"  {k}: {v['score'] if v['score'] is not None else 'N/A'}  {v['note']}")
    print(f"  S 分數：{result['S_percent']}%" + ("（門檻未過，記 0）" if result["gates_failed"] else ""))
    if "Q" in result:
        for k, v in result["Q"].items():
            print(f"  {k}: {v.get('score')}  {v.get('why', '')}")
        print(f"  Q 分數：{result['Q_percent']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
