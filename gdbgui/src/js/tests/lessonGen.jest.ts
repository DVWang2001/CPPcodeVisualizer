import { PRESETS, defaultCfg, applyPreset, buildRequestBody } from "../lessonGen";

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
    expect(defaultCfg().model).toBe("meta/llama-3.3-70b-instruct");
  });
});
