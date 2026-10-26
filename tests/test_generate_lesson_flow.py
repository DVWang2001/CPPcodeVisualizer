"""POST /api/generate_lesson 的流程：關閉思考、檢查、修正一輪、確定性修復。

上游模型用假的 `_requests.post` 取代，照腳本依序回傳每一次呼叫的內容。
"""

import json

import pytest

from gdbgui.server import http_routes, lesson_gen
from .conftest import register_user

SRC = "#include <iostream>\nint main() {\n   int n = 5;\n   int s = 0;\n}\n"
GOOD = (
    "#include <iostream>\n"
    "int main() {\n"
    "   int n = 5;  //@ @tts [next] 宣告 n\n"
    "   int s = 0;  //@ @guide {n} @tts [next] 開始\n"
    "}  //@ @tts [continue] 結束\n"
)
G5 = GOOD.replace("@tts [next] 宣告 n", "@guide n={n} @tts [next] 宣告 n")  # 宣告行引用剛宣告的 n
EDITED = GOOD.replace("n = 5", "n = 6")


class _FakeUpstream:
    status_code = 200
    text = ""

    def __init__(self, content):
        self._content = content

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_lines(self):
        yield ("data: " + json.dumps({"choices": [{"delta": {"content": self._content}}]})).encode()
        yield b"data: [DONE]"


@pytest.fixture
def upstream(monkeypatch):
    """回傳 (設定回應的函式, 已收到的請求 payload 清單)。"""
    scripted, payloads = [], []

    def fake_post(url, headers=None, json=None, **kwargs):
        payloads.append(json)
        return _FakeUpstream(scripted.pop(0))

    monkeypatch.setattr(http_routes._requests, "post", fake_post)
    return scripted, payloads


def _generate(flask_app, source=SRC):
    user = register_user(flask_app)
    resp = user.http.post(
        "/api/generate_lesson",
        data=json.dumps({"source": source, "api_key": "k"}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )
    assert resp.status_code == 200
    return [json.loads(line) for line in resp.get_data(as_text=True).splitlines() if line.strip()]


def _last(events):
    return events[-1]


def test_good_first_pass_is_one_call_with_thinking_disabled(flask_app, upstream):
    scripted, payloads = upstream
    scripted.append(GOOD)
    done = _last(_generate(flask_app))
    assert done["done"] and done["code"] == GOOD.strip() and not done["repaired"] and done["warnings"] == []
    assert len(payloads) == 1
    assert payloads[0]["chat_template_kwargs"] == {"thinking": False}


def test_checker_failure_triggers_one_repair_round_with_the_checker_output(flask_app, upstream):
    scripted, payloads = upstream
    scripted += [G5, GOOD]
    events = _generate(flask_app)
    assert {"reset": True} in events
    done = _last(events)
    assert done["code"] == GOOD.strip() and done["repaired"] is True and done["warnings"] == []
    assert len(payloads) == 2
    followup = payloads[1]["messages"]
    assert followup[-2] == {"role": "assistant", "content": G5.strip()}
    assert "沒通過檢查器" in followup[-1]["content"] and "第 3 行" in followup[-1]["content"]


def test_unrepaired_declaration_reference_is_removed_deterministically(flask_app, upstream):
    scripted, _ = upstream
    scripted += [G5, G5]
    done = _last(_generate(flask_app))
    assert done["done"] and "n={n}" not in done["code"]
    assert any("已自動移除第 3 行" in w for w in done["warnings"])


def test_edited_source_that_stays_edited_after_repair_is_rejected(flask_app, upstream):
    scripted, _ = upstream
    scripted += [EDITED, EDITED]
    last = _last(_generate(flask_app))
    assert "error" in last and "修改了第 3 行" in last["error"]


def test_failed_repair_falls_back_to_the_first_pass(flask_app, upstream):
    scripted, _ = upstream
    scripted += [G5, EDITED]  # 修正回合反而改了程式 → 退回第一份，再做確定性修復
    done = _last(_generate(flask_app))
    assert done["done"] and done["repaired"] is False and "n = 5" in done["code"]


def test_custom_base_url_does_not_get_the_nvidia_only_parameter(flask_app, upstream):
    scripted, payloads = upstream
    scripted.append(GOOD)
    user = register_user(flask_app)
    user.http.post(
        "/api/generate_lesson",
        data=json.dumps({"source": SRC, "api_key": "k", "base_url": "https://api.mistral.ai/v1"}),
        content_type="application/json",
        headers={"x-csrftoken": user.csrf},
    )
    assert "chat_template_kwargs" not in payloads[0]
    assert lesson_gen.DEFAULT_BASE_URL != "https://api.mistral.ai/v1"


def test_dropped_header_comment_is_restored_without_a_repair_round(flask_app, upstream):
    scripted, payloads = upstream
    scripted.append(GOOD)  # 模型輸出沒有開頭的說明註解
    done = _last(_generate(flask_app, source="// 說明\n" + SRC))
    assert done["done"] and done["code"].startswith("// 說明\n") and not done["repaired"]
    assert any("已放回原位" in w for w in done["warnings"]) and len(payloads) == 1


def test_rate_limit_gets_a_readable_message(flask_app, monkeypatch):
    class _Limited(_FakeUpstream):
        status_code = 429

    monkeypatch.setattr(http_routes._requests, "post", lambda *a, **k: _Limited(""))
    last = _last(_generate(flask_app))
    assert "429" in last["error"] and "再試" in last["error"]


def test_prose_only_guide_is_stripped_for_main_only_programs(flask_app, upstream):
    scripted, _ = upstream
    scripted.append(GOOD.replace("@tts [next] 宣告 n", "@guide [初始化#blue] 宣告 n @tts [next] 宣告 n"))
    done = _last(_generate(flask_app))
    assert done["done"] and "初始化" not in done["code"] and "@guide {n}" in done["code"]
    assert done["prose_guides_dropped"] == 1 and any("純敘述" in w for w in done["warnings"])
