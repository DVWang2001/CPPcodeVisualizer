"""AI 教案生成的純函式（不依賴 Flask，方便單元測試）。"""
import difflib
import importlib.util
import json
import re
from pathlib import Path

# 挑這一組的理由都是在正式機上量出來的，不是看規格挑的：
#
#   * OpenCode Zen 的 big-pickle：穩定 1 token/秒，一份教案推估 80 分鐘。而且那把
#     key 只授權它一個模型（帶 key 查 /models 回 1 個、不帶 key 回 70 個）。
#   * NVIDIA 的 deepseek-v4-flash（舊名，已下架；現行為 v4.1-flash）：每次請求約 68 秒固定開銷，之後約 29 tok/s
#     （13 tokens 要 69.5s、800 tokens 要 97.4s——多的 787 個只花 28 秒）。
#     一份 5000 token 的教案因此約 4 分鐘，落在下面的 timeout 內。
#
# 注意 meta/llama-3.3-70b-instruct（本專案原本的預設）已經從 NVIDIA 目錄下架，
# 換模型前先打 /v1/models 確認它還在。
DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "deepseek-ai/deepseek-v4.1-flash"
MAX_SOURCE_BYTES = 100 * 1024

_SYSTEM_TEMPLATE = (
    "你是 CPPcodeVisualizer 的教案產生器。以下是教案撰寫指南全文，語法必須嚴格遵守：\n\n"
    "{guide}\n\n"
    "輸出規則（最重要，違反即失敗）：\n"
    "1. 只輸出完整的 C++ 原始碼，不要任何說明文字、標題或 markdown 圍欄。\n"
    "2. 只能在行尾加上 //@ 註解（@guide / @tts / @layout），不得修改程式碼本身，"
    "不得增刪或調換任何行，輸出行數必須與輸入完全相同。\n"
    "3. //@ 註解語法必須符合指南；Guide 與 TTS 內容使用繁體中文。\n"
    "4. 函式的回傳值必須先存入名為 result 的區域變數再 return（呼叫樹據此顯示回傳值）；"
    "result 必須在函式最外層宣告一次，各分支只賦值、不得在內層區塊重複宣告。\n"
    "5. 教案必須全自動播放（硬性標準）：每一個 GDB 可能停駐的行（含函式右大括號行與 main 的收尾行）"
    "都要有 @tts 並以自動播放指令開頭（[next]/[step-in]/[continue]）；同一行的每個 @N 門檻段落也各自"
    "要以指令開頭；最後一個停駐點用 [continue] 收尾。缺任何一個停駐點的指令即為不合格。"
    "Run 一定先停在 main 的第一個可執行行，main 的呼叫行會停兩次（出發與返回），"
    "訊息必須用 @2 門檻區分。\n"
    "6. //@ 註解在 GDB 停在該行、尚未執行該行時觸發：該行才要賦值的變數不得在同一行註解的 "
    "{{變數}} 中引用（會讀到未初始化值），請放到下一行的註解。\n"
    "7. 多分支遞迴：每個遞迴呼叫獨立成行、存入具名變數（不得單行多個遞迴呼叫）；"
    "呼叫行一律用 [step-in]；呼叫行的訊息必須方向中性（去程與回程都說得通）。\n"
    "8. return 行的 @guide 要顯示「回傳值及其由來」，格式「回傳 {{result}} ← <由來>」，"
    "由來如 {{n}} + {{rest}}、{{a}} + {{b}}、max(...)、base case、直接查記憶表等，"
    "讓學生在 return 那一刻看出為什麼回傳這個值。\n"
    "9. 一行最多一個遞迴呼叫，且其回傳值先存進自己的具名變數再參與後續運算；"
    "不要寫 take = val[i] + knap(...) 這種把子問題回傳值和額外運算混在一行的寫法，"
    "要拆成 int sub = knap(...); take = val[i] + sub;，讓子問題的回傳值在節點上看得見。\n"
    "10. 只在 GDB 真的會停駐的行加 //@：不要標 #include、using namespace、函式簽名行、"
    "全域宣告，也不要標迴圈或 if 的單獨 }}（只有函式右大括號與 main 收尾會停）。\n"
    "11. @N 門檻只用來區分「第一次」與「之後」，除非有具體理由，不要自創 @5、@11 這類數字。\n"
    "12. @guide 只放要顯示在右側面板的變數或容器（{{x}}、{{v[i]}}），敘述一律寫在 @tts，"
    "不要在 @guide 把 @tts 的話再講一遍。沒有可顯示的變數就省略 @guide。"
    "程式只有 main、沒有其他函式時沒有呼叫圖：不寫 [標籤#顏色]，也不寫純文字的 @guide。"
    "有遞迴或函式呼叫時，呼叫圖標籤（[名稱#顏色] 簡短說明）是唯一可以在 @guide 寫文字的地方。\n"
)


def build_messages(guide_md, source, instruction=""):
    user = "請為以下 C++ 程式碼加上 //@ 教案註解：\n\n" + source
    if instruction and instruction.strip():
        user += "\n\n老師的額外指示：" + instruction.strip()
    return [
        {"role": "system", "content": _SYSTEM_TEMPLATE.format(guide=guide_md)},
        {"role": "user", "content": user},
    ]


def validate_base_url(url):
    """空值 → 預設；https → 去尾斜線後回傳；其他 → None（拒絕）。

    嚴格要求小寫 "https://" scheme prefix：任何大小寫變形（HTTP://、HTTPS://、
    Https:// 等）或非 https scheme 一律回傳 None（fail closed），避免外連被導向
    非加密或內部/後設資料端點（例如 http://169.254.169.254 SSRF）。
    """
    u = (url or "").strip().rstrip("/")
    if not u:
        return DEFAULT_BASE_URL
    # Case-sensitive check on purpose: "HTTPS://", "Https://" etc. do not match
    # the literal "https://" prefix and are therefore rejected (fail closed)
    # rather than silently accepted.
    if not u.startswith("https://"):
        return None
    return u


# 允許使用伺服器環境變數 key 的主機（防止自訂 base_url 竊取伺服器 key）。
#
# 這裡只放「伺服器金鑰真正屬於的那一家」。多放一家就多一個把金鑰以 Bearer 送出去
# 的對象——對方雖然會拒絕，但金鑰已經離開機器了。要換供應商就連同這份名單一起換。
ENV_KEY_BASE_URLS = frozenset({
    DEFAULT_BASE_URL,
})


def env_key_allowed(base_url):
    return base_url in ENV_KEY_BASE_URLS


def resolve_api_key(request_key, environ):
    for candidate in (
        request_key,
        environ.get("LESSON_AI_API_KEY"),
        environ.get("NVIDIA_API_KEY"),
    ):
        if candidate and candidate.strip():
            return candidate.strip()
    return None


_ANNOT_RE = re.compile(r"\s*//@.*$")


def code_unchanged(source, output):
    """去掉 //@ 註解後，輸出必須與輸入逐行相同（行數、內容都不能變）。

    prompt 只是請求；模型改了程式（甚至刪行）時，//@ 的行號就全部錯位，
    而且畫面上看不出來。回傳 None 表示通過，否則回傳給使用者看的原因。
    """
    def norm(text):
        return [_ANNOT_RE.sub("", ln).rstrip() for ln in text.strip("\n").splitlines()]

    a, b = norm(source), norm(output)
    if len(a) != len(b):
        return f"模型改變了行數（原 {len(a)} 行、輸出 {len(b)} 行），已拒絕"
    for i, (x, y) in enumerate(zip(a, b), 1):
        if x != y:
            return f"模型修改了第 {i} 行的程式碼，已拒絕：\n原：{x}\n改：{y}"
    return None


def strip_annotations(source):
    """去掉輸入程式碼裡既有的 //@ 註解（行數不變）。

    編輯器裡可能已經有舊教案的註解。讓模型看到它們，它會被舊內容牽著走（沿用、改寫、
    或照抄舊的 @N 門檻）；使用者要的是「重新生成」，舊註解等他按下「套用」才被覆蓋。
    """
    return "\n".join(_ANNOT_RE.sub("", ln) for ln in source.split("\n"))


def restore_dropped_comments(source, code):
    """模型被刪掉的若全是 `//` 說明註解或空行，就放回原位。回傳 (新程式碼, 補回幾行)。

    實測：題目開頭常有幾行 `// 教案：…` 的說明，模型會把它們刪掉（18 行變 15 行），
    修一輪也不見得補得回來。這些行不影響程式，補回比整份拒絕合理；刪到真正的程式碼
    就不補，留給 code_unchanged 擋。
    """
    def norm(text):
        return [_ANNOT_RE.sub("", ln).rstrip() for ln in text.strip("\n").splitlines()]

    original = source.strip("\n").splitlines()
    produced = code.strip("\n").splitlines()
    a, b = norm(source), norm(code)
    result, restored = [], 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "delete" and all(not x.strip() or x.lstrip().startswith("//") for x in a[i1:i2]):
            result += original[i1:i2]
            restored += i2 - i1
        elif tag != "delete":
            result += produced[j1:j2]
    return "\n".join(result), restored


def load_checker(root):
    """載入 scripts/check_lesson.py 的 check()；找不到回 None（驗證就只剩 code_unchanged）。

    和 AUTHORING_GUIDE.md 一樣從 repo 根目錄找，不把 scripts/ 當套件匯入。
    """
    path = Path(root) / "scripts" / "check_lesson.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("check_lesson", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.check


def find_problems(check, code):
    """check_lesson 的 problems：[(行號, 訊息)]。沒有檢查器就當沒問題。"""
    return list(check(code)[0]) if check else []


def repair_message(problems):
    """把檢查器的原始輸出貼回給模型（AUTHORING_GUIDE §9.4：不要轉述）。"""
    lines = "\n".join(f"- 第 {n} 行：{m}" if n else f"- {m}" for n, m in problems)
    return (
        "你的輸出沒通過檢查器：\n" + lines + "\n"
        "請修正這些問題後，重新輸出完整的 C++ 原始碼（只輸出程式碼，其餘規則不變，"
        "原始碼每一行都要保留）。"
    )


_FUNC_DEF_RE = re.compile(r"^[A-Za-z_][\w:<>,\s\*&]*\s+\**&?(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$")
_FIELD_RE = re.compile(r"(@(?:guide|tts|layout)\b)")


def defines_other_functions(code):
    """程式有沒有 main 以外的函式（有就會有呼叫圖，guide 才需要寫文字標籤）。"""
    for line in code.split("\n"):
        m = _FUNC_DEF_RE.match(line.split("//@", 1)[0].rstrip())
        if m and m.group(1) != "main" and not line.startswith(("if", "for", "while", "switch", "return")):
            return True
    return False


def drop_prose_guides(code):
    """只有 main 的程式：移除沒有 {變數} 的 @guide。回傳 (新程式碼, 移除幾行)。

    實測（6 題 × 3 次共 169 行 guide）：25% 是純敘述、22% 與 @tts 高度重疊；人工教案裡
    沒有函式呼叫的程式（factor_sum、collatz、palindrome）根本沒有 guide。沒有呼叫圖時
    guide 只該顯示變數，敘述屬於 @tts。有其他函式時 guide 的文字標籤是呼叫圖在用，不動。
    """
    if defines_other_functions(code):
        return code, 0
    lines, dropped = code.split("\n"), 0
    for i, line in enumerate(lines):
        if "//@" not in line:
            continue
        head, tail = line.split("//@", 1)
        parts = _FIELD_RE.split(tail)  # [前導空白, 關鍵字, 內容, 關鍵字, 內容, ...]
        kept, removed = [], False
        for kw, val in zip(parts[1::2], parts[2::2]):
            if kw == "@guide" and "{" not in val:
                removed = True
            else:
                kept.append(kw + val)
        if removed:
            lines[i] = head + "//@" + parts[0] + "".join(kept) if kept else head.rstrip()
            dropped += 1
    return "\n".join(lines), dropped


def _annotations(lines):
    """[(行號, 第一個 @tts 段落去掉 @N 前綴後的文字)]，只含有 //@ 的行。"""
    out = []
    for number, line in enumerate(lines, 1):
        if "//@" not in line:
            continue
        parts = _FIELD_RE.split(line.split("//@", 1)[1])
        tts = ""
        for kw, val in zip(parts[1::2], parts[2::2]):
            if kw == "@tts":
                tts = val
        out.append((number, re.sub(r"^\s*@\d+\s*", "", tts.split("|")[0].strip())))
    return out


def _function_ranges(lines):
    """{函式名: (起行, 迄行)}：第 0 欄的簽名行到下一個第 0 欄的單獨 `}`（1-based）。"""
    ranges, name, start = {}, None, 0
    for number, line in enumerate(lines, 1):
        code = line.split("//@", 1)[0].rstrip()
        m = _FUNC_DEF_RE.match(code)
        if m and name is None and not code.startswith(("if", "for", "while", "switch", "return")):
            name, start = m.group(1), number
        elif name and code == "}":
            ranges[name] = (start, number)
            name = None
    return ranges


def derive_breakpoints(code):
    """自動播放教案「一定要有」的斷點：[(行號, 原因)]。AUTHORING_GUIDE §8.1、§1.4、§3.4。

    * `[continue]` 之後的下一個有 //@ 的行：不放的話 continue 一路跑到程式結束，整份
      教案被衝掉（無聲、沒有任何錯誤訊息）。
    * 遞迴函式的入口（函式內第一個有 //@ 的行）：自動播放的「下降」靠它攔住每一層。
    * 遞迴函式裡用 `[fast @N]` 的行：快轉的每一步是 next，會跨過呼叫，沒斷點計數不到。

    不推導「教學起點」「測驗觸發行」這類斷點：那是老師的判斷，不是結構決定的。
    實測對 67 份人工教案：推導出的斷點全部都在老師放的斷點裡（遞迴入口老師放在簽名行，
    GDB 會落在 prologue 之後的第一個敘述，兩者等價）。
    """
    lines = code.split("\n")
    ann = _annotations(lines)
    found = {}
    for index, (number, tts) in enumerate(ann[:-1]):
        if tts.startswith("[continue]"):
            found.setdefault(ann[index + 1][0], "[continue] 之後的落腳行")
    for name, (start, end) in _function_ranges(lines).items():
        body = lines[start:end - 1]
        if not any(re.search(r"\b" + re.escape(name) + r"\s*\(", b.split("//@", 1)[0]) for b in body):
            continue
        inside = [(n, t) for n, t in ann if start < n < end]
        if inside:
            found.setdefault(inside[0][0], f"遞迴函式 {name} 的入口")
        for n, t in inside:
            if "[fast @" in lines[n - 1]:
                found.setdefault(n, "遞迴裡的 [fast @N]")
    return sorted(found.items())


_UNSET_RE = re.compile(r"建構的 \{(\w+)\}")


def drop_unset_refs(code, problems):
    """把「引用該行才宣告的變數」的 {變數} 從那一行的註解移除。回傳 (新程式碼, [(行號, 變數)])。

    模型最頑固的毛病（實測 12 份有 10 份犯）：在 `int n = ...;` 這行的註解寫 {n}，
    停在那一行時 n 還沒值，學生看到垃圾。檢查器已經指出行號與變數，直接刪掉比再問
    一次模型可靠；`n={n}` 這種寫法連前面的 `n=` 一起拿掉，免得留下半句話。
    """
    lines = code.split("\n")
    fixed = []
    for number, message in problems:
        found = _UNSET_RE.search(message)
        if not found or not (1 <= number <= len(lines)) or "//@" not in lines[number - 1]:
            continue
        name = re.escape(found.group(1))
        head, tail = lines[number - 1].split("//@", 1)
        ref = r"\{" + name + r"(?:\[[^}]*)?\}"
        new = re.sub(r"[^\s{}，。、：:]*\s*[=＝]\s*" + ref, "", tail)
        new = re.sub(ref, "", new)
        new = re.sub(r"[ \t]{2,}", " ", new)
        if new != tail:
            lines[number - 1] = head + "//@" + new
            fixed.append((number, found.group(1)))
    return "\n".join(lines), fixed


_FENCE_RE = re.compile(r"^```[^\n]*\n(.*?)\n?```\s*$", re.S)


def strip_code_fences(text):
    t = (text or "").strip()
    m = _FENCE_RE.match(t)
    return m.group(1) if m else t


def sse_delta(line):
    """從一行 SSE 取出 `("content"|"reasoning", 文字)`；不是內容行就回 None。

    上游是 OpenAI 相容的串流：每行長成 `data: {...}`，結尾一行是 `data: [DONE]`。
    心跳與空行照樣會出現，全部安靜略過——串流解析器不該因為一行雜訊就中斷。

    **為什麼要分兩種**：deepseek-v4-flash 是推理型模型，串流會先吐一長段
    `delta.reasoning_content`（思考過程）才輪到 `delta.content`（真正的答案）。
    實測一個「說三個字」的請求就有 7 塊 reasoning、2 塊 content。只認 content 的
    解析器會看到「上游 200、資料一直來、卻一個字都沒解析到」，而且如果 max_tokens
    在推理階段就用完，content 根本不會出現。

    呼叫端要把 reasoning 拿去當進度顯示（推理階段長達數分鐘，沒有它畫面是空的），
    但**只有 content 能進最終的程式碼**。
    """
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    line = line.strip()
    if not line.startswith("data:"):
        return None
    payload = line[len("data:"):].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        choices = json.loads(payload).get("choices") or []
        delta = choices[0].get("delta") or {}
    except (ValueError, AttributeError, IndexError, KeyError):
        return None
    if delta.get("content"):
        return ("content", delta["content"])
    if delta.get("reasoning_content"):
        return ("reasoning", delta["reasoning_content"])
    return None
