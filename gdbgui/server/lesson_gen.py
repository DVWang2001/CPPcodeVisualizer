"""AI 教案生成的純函式（不依賴 Flask，方便單元測試）。"""
import re

DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "meta/llama-3.3-70b-instruct"
MAX_SOURCE_BYTES = 100 * 1024

_SYSTEM_TEMPLATE = (
    "你是 CPPcodeVisualizer 的教案產生器。以下是教案撰寫指南全文，語法必須嚴格遵守：\n\n"
    "{guide}\n\n"
    "輸出規則（最重要，違反即失敗）：\n"
    "1. 只輸出完整的 C++ 原始碼，不要任何說明文字、標題或 markdown 圍欄。\n"
    "2. 只能在行尾加上 //@ 註解（@guide / @tts / @layout），不得修改程式碼本身，"
    "不得增刪或調換任何行，輸出行數必須與輸入完全相同。\n"
    "3. //@ 註解語法必須符合指南；Guide 與 TTS 內容使用繁體中文。\n"
    "4. 函式的回傳值必須先存入名為 result 的區域變數再 return（呼叫樹據此顯示回傳值）。\n"
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


# 允許使用伺服器環境變數 key 的主機（防止自訂 base_url 竊取伺服器 key）
ENV_KEY_BASE_URLS = frozenset({
    DEFAULT_BASE_URL,
    "https://api.mistral.ai/v1",
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
