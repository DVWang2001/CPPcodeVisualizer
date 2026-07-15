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
