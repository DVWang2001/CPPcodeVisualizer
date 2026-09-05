export type LessonCfg = { preset: string; baseUrl: string; model: string; apiKey: string };

export const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  // Zen 是預設，也是唯一能用伺服器金鑰的一家（見 lesson_gen.ENV_KEY_BASE_URLS）。
  // 其他家仍然可選，但要自己在面板填 key——伺服器的金鑰不會送去別家。
  zen: { baseUrl: "https://opencode.ai/zen/v1", model: "big-pickle" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
  custom: { baseUrl: "", model: "" },
};

const LS_KEY = "gdbgui_lesson_ai_config";

export function defaultCfg(): LessonCfg {
  return { preset: "zen", ...PRESETS.zen, apiKey: "" };
}

export function applyPreset(cfg: LessonCfg, preset: string): LessonCfg {
  if (preset === "custom" || !PRESETS[preset]) return { ...cfg, preset: "custom" };
  return { ...cfg, preset, ...PRESETS[preset] };
}

export function loadCfg(): LessonCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (raw && typeof raw === "object") return { ...defaultCfg(), ...raw };
  } catch (e) {
    /* 壞資料回預設 */
  }
  return defaultCfg();
}

export function saveCfg(cfg: LessonCfg): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function buildRequestBody(cfg: LessonCfg, source: string, instruction: string): object {
  const body: any = { source };
  if (instruction.trim()) body.instruction = instruction.trim();
  if (cfg.baseUrl.trim()) body.base_url = cfg.baseUrl.trim();
  if (cfg.model.trim()) body.model = cfg.model.trim();
  if (cfg.apiKey.trim()) body.api_key = cfg.apiKey.trim();
  return body;
}
