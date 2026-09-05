import { PRESETS, defaultCfg, applyPreset, buildRequestBody, takeCompleteLines } from "../lessonGen";

describe("applyPreset", () => {
  test("switching to mistral fills its baseUrl/model", () => {
    const cfg = applyPreset(defaultCfg(), "mistral");
    expect(cfg.preset).toBe("mistral");
    expect(cfg.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(cfg.model).toBe("mistral-small-latest");
  });

  test("custom keeps existing baseUrl/model", () => {
    const cfg = applyPreset(
      { preset: "nvidia", baseUrl: "https://x/v1", model: "m", apiKey: "k" },
      "custom"
    );
    expect(cfg.baseUrl).toBe("https://x/v1");
    expect(cfg.model).toBe("m");
    expect(cfg.apiKey).toBe("k");
  });

  test("apiKey survives preset switch", () => {
    const cfg = applyPreset({ ...defaultCfg(), apiKey: "sk-1" }, "mistral");
    expect(cfg.apiKey).toBe("sk-1");
  });
});

describe("buildRequestBody", () => {
  test("includes only non-empty fields", () => {
    const body: any = buildRequestBody(
      { preset: "custom", baseUrl: " ", model: "", apiKey: "" },
      "int main(){}",
      "  "
    );
    expect(body).toEqual({ source: "int main(){}" });
  });

  test("passes trimmed values through", () => {
    const body: any = buildRequestBody(
      { preset: "nvidia", ...PRESETS.nvidia, apiKey: " sk-2 " },
      "code",
      " 重點放在遞迴 "
    );
    expect(body.base_url).toBe(PRESETS.nvidia.baseUrl);
    expect(body.model).toBe(PRESETS.nvidia.model);
    expect(body.api_key).toBe("sk-2");
    expect(body.instruction).toBe("重點放在遞迴");
  });
});

describe("預設要指向能用伺服器金鑰的那一家", () => {
  test("預設的 baseUrl 與後端白名單一致", () => {
    // 這個字串要和 gdbgui/server/lesson_gen.py 的 DEFAULT_BASE_URL 一模一樣。
    // 對不上的話，會員按下生成會被後端擋成「自訂 base_url 請填自己的 key」，
    // 而那個訊息完全看不出真正的原因。
    expect(defaultCfg().preset).toBe("nvidia");
    expect(defaultCfg().baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(defaultCfg().model).toBe("deepseek-ai/deepseek-v4-flash-0731");
  });
});

describe("takeCompleteLines — 串流切塊不會剛好落在換行上", () => {
  test("完整的行解析出來，殘段留在 rest", () => {
    const r = takeCompleteLines('{"delta":"甲"}\n{"delta":"乙"}\n{"del');
    expect(r.events).toEqual([{ delta: "甲" }, { delta: "乙" }]);
    expect(r.rest).toBe('{"del');
  });

  test("殘段接上下一塊之後才成為一行", () => {
    const first = takeCompleteLines('{"delta":"甲');
    expect(first.events).toEqual([]);
    const second = takeCompleteLines(first.rest + ' 乙"}\n');
    expect(second.events).toEqual([{ delta: "甲 乙" }]);
    expect(second.rest).toBe("");
  });

  test("壞掉的一行被略過，不會讓整段串流中斷", () => {
    const r = takeCompleteLines('{"delta":"好"}\n這不是JSON\n{"done":true,"code":"x"}\n');
    expect(r.events).toEqual([{ delta: "好" }, { done: true, code: "x" }]);
  });

  test("空行照樣略過", () => {
    expect(takeCompleteLines('\n\n{"delta":"甲"}\n').events).toEqual([{ delta: "甲" }]);
  });
});
