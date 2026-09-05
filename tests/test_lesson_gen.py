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


def test_env_key_allowed_default_base_url():
    assert lesson_gen.env_key_allowed(lesson_gen.DEFAULT_BASE_URL) is True


def test_env_key_not_shared_with_other_real_providers():
    """伺服器金鑰只屬於一家，別家再有名也不給。

    白名單多放一家，就多一個把金鑰以 Bearer 送出去的對象——對方會拒絕，但金鑰
    已經離開機器了。這幾家都是貨真價實的供應商，正因如此才容易被順手加進名單。
    """
    for other in (
        "https://api.mistral.ai/v1",
        "https://opencode.ai/zen/v1",
        "https://api.openai.com/v1",
    ):
        assert lesson_gen.env_key_allowed(other) is False


def test_env_key_allowed_rejects_arbitrary_host():
    assert lesson_gen.env_key_allowed("https://evil.example.com/v1") is False


def test_sse_delta_extracts_content():
    line = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
    assert lesson_gen.sse_delta(line) == "你好"
    assert lesson_gen.sse_delta(line.encode("utf-8")) == "你好"


def test_sse_delta_ignores_everything_that_is_not_content():
    """串流裡的雜訊不該讓解析器中斷——只要安靜略過。"""
    for noise in (
        "",
        "\n",
        ": heartbeat",
        "data: [DONE]",
        "data: ",
        "data: {不是JSON",
        'data: {"choices":[]}',
        'data: {"choices":[{"delta":{}}]}',
        'data: {"choices":[{"delta":{"content":null}}]}',
        'event: ping',
    ):
        assert lesson_gen.sse_delta(noise) is None, noise
