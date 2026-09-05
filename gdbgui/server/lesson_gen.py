"""AI 教案生成的純函式（不依賴 Flask，方便單元測試）。"""
import re

DEFAULT_BASE_URL = "https://opencode.ai/zen/v1"
DEFAULT_MODEL = "big-pickle"
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


_FENCE_RE = re.compile(r"^```[^\n]*\n(.*?)\n?```\s*$", re.S)


def strip_code_fences(text):
    t = (text or "").strip()
    m = _FENCE_RE.match(t)
    return m.group(1) if m else t
