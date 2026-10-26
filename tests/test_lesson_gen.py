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
        "https://generativelanguage.googleapis.com/v1beta/openai",
    ):
        assert lesson_gen.env_key_allowed(other) is False


def test_env_key_allowed_rejects_arbitrary_host():
    assert lesson_gen.env_key_allowed("https://evil.example.com/v1") is False


def test_sse_delta_extracts_content():
    line = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
    assert lesson_gen.sse_delta(line) == ("content", "你好")
    assert lesson_gen.sse_delta(line.encode("utf-8")) == ("content", "你好")


def test_sse_delta_separates_reasoning_from_the_answer():
    """推理型模型先吐思考過程才吐答案，兩者不能混在一起。

    deepseek-v4-flash 的串流實測長這樣：先 7 塊 reasoning_content、才 2 塊
    content。把 reasoning 當成答案會讓思考過程被寫進學生看到的教案裡；把它
    整個丟掉則會讓畫面在推理的那幾分鐘完全空白。所以要分開回報。
    """
    reasoning = 'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"我們"}}]}'
    assert lesson_gen.sse_delta(reasoning) == ("reasoning", "我們")

    # 同一塊同時有兩種時，答案優先——content 才是要留下來的東西。
    both = 'data: {"choices":[{"delta":{"reasoning_content":"想","content":"答"}}]}'
    assert lesson_gen.sse_delta(both) == ("content", "答")


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
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'event: ping',
    ):
        assert lesson_gen.sse_delta(noise) is None, noise


def test_code_unchanged_ignores_annotations_only():
    src = "int main() {\n  int x = 1;\n}\n"
    out = "int main() {\n  int x = 1;  //@ @tts [next] 好\n}  //@ @tts [continue] 結束"
    assert lesson_gen.code_unchanged(src, out) is None


def test_code_unchanged_rejects_edit_and_line_count():
    src = "int a = 1;\nint b = 2;\n"
    assert "行數" in lesson_gen.code_unchanged(src, "int a = 1;\n")
    assert "第 2 行" in lesson_gen.code_unchanged(src, "int a = 1;\nint b = 3;\n")


_ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
_DECL_BUG = (
    "#include <iostream>\n"
    "int main() {\n"
    "   int n = 5;  //@ @guide n={n} @tts [next] 宣告 n\n"
    "   int s = 0;  //@ @guide {n} @tts [next] 開始\n"
    "}  //@ @tts [continue] 結束\n"
)


def test_find_problems_flags_ref_to_variable_declared_on_the_same_line():
    check = lesson_gen.load_checker(_ROOT)
    problems = lesson_gen.find_problems(check, _DECL_BUG)
    assert [n for n, _ in problems] == [3]


def test_drop_unset_refs_removes_only_the_offending_token_and_its_label():
    check = lesson_gen.load_checker(_ROOT)
    problems = lesson_gen.find_problems(check, _DECL_BUG)
    fixed_code, fixed = lesson_gen.drop_unset_refs(_DECL_BUG, problems)
    assert fixed == [(3, "n")]
    assert "n={n}" not in fixed_code.split("\n")[2]
    assert "{n}" in fixed_code.split("\n")[3]  # 下一行的 {n} 是合法的，不能動
    assert lesson_gen.find_problems(check, fixed_code) == []


def test_find_problems_without_checker_is_empty():
    assert lesson_gen.find_problems(None, _DECL_BUG) == []
    assert lesson_gen.load_checker("/no/such/root") is None


def test_repair_message_quotes_the_checker_output():
    msg = lesson_gen.repair_message([(3, "不能這樣"), (0, "整份有問題")])
    assert "第 3 行：不能這樣" in msg and "- 整份有問題" in msg


def test_restore_dropped_comments_puts_header_comments_and_blank_lines_back():
    src = "// 說明\n\n#include <iostream>\nint main() {\n}\n"
    out = "#include <iostream>\nint main() {  //@ @tts [next] 好\n}  //@ @tts [continue] 完"
    fixed, restored = lesson_gen.restore_dropped_comments(src, out)
    assert restored == 2 and fixed.split("\n")[:3] == ["// 說明", "", "#include <iostream>"]
    assert lesson_gen.code_unchanged(src, fixed) is None


def test_restore_dropped_comments_never_restores_real_code():
    src = "int a = 1;\nint b = 2;\n"
    fixed, restored = lesson_gen.restore_dropped_comments(src, "int a = 1;\n")
    assert restored == 0 and lesson_gen.code_unchanged(src, fixed) is not None
