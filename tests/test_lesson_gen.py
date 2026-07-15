from gdbgui.server import lesson_gen


def test_validate_base_url_empty_falls_back_to_default():
    assert lesson_gen.validate_base_url("") == lesson_gen.DEFAULT_BASE_URL
    assert lesson_gen.validate_base_url(None) == lesson_gen.DEFAULT_BASE_URL


def test_validate_base_url_https_normalized():
    assert (
        lesson_gen.validate_base_url("https://api.mistral.ai/v1/")
        == "https://api.mistral.ai/v1"
    )


def test_validate_base_url_rejects_non_https():
    assert lesson_gen.validate_base_url("http://169.254.169.254/v1") is None
    assert lesson_gen.validate_base_url("file:///etc/passwd") is None


def test_resolve_api_key_priority():
    env = {"LESSON_AI_API_KEY": "env-lesson", "NVIDIA_API_KEY": "env-nvidia"}
    assert lesson_gen.resolve_api_key("req-key", env) == "req-key"
    assert lesson_gen.resolve_api_key("", env) == "env-lesson"
    assert lesson_gen.resolve_api_key("", {"NVIDIA_API_KEY": "env-nvidia"}) == "env-nvidia"
    assert lesson_gen.resolve_api_key("  ", {}) is None


def test_strip_code_fences():
    code = 'int main() {  //@ @guide hi\n  return 0;\n}'
    assert lesson_gen.strip_code_fences(f"```cpp\n{code}\n```") == code
    assert lesson_gen.strip_code_fences(f"```\n{code}\n```") == code
    assert lesson_gen.strip_code_fences(code) == code  # 沒圍欄原樣返回
    assert lesson_gen.strip_code_fences("") == ""


def test_build_messages_shape():
    msgs = lesson_gen.build_messages("GUIDE-TEXT", "int main(){}", "語速放慢")
    assert msgs[0]["role"] == "system"
    assert "GUIDE-TEXT" in msgs[0]["content"]
    assert "//@" in msgs[0]["content"]  # 輸出規則有提到 //@
    assert msgs[1]["role"] == "user"
    assert "int main(){}" in msgs[1]["content"]
    assert "語速放慢" in msgs[1]["content"]


def test_build_messages_without_instruction():
    msgs = lesson_gen.build_messages("G", "code")
    assert "額外指示" not in msgs[1]["content"]
