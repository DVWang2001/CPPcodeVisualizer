export type LessonCfg = { preset: string; baseUrl: string; model: string; apiKey: string };

export const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  // NVIDIA 是預設，也是唯一能用伺服器金鑰的一家（見 lesson_gen.ENV_KEY_BASE_URLS）。
  // 其他家仍然可選，但要自己在面板填 key——伺服器的金鑰不會送去別家。
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", model: "deepseek-ai/deepseek-v4-flash-0731" },
  zen: { baseUrl: "https://opencode.ai/zen/v1", model: "big-pickle" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
  custom: { baseUrl: "", model: "" },
};

const LS_KEY = "gdbgui_lesson_ai_config";

export function defaultCfg(): LessonCfg {
  return { preset: "nvidia", ...PRESETS.nvidia, apiKey: "" };
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

/** 串流事件：後端每行一個 JSON 物件（見 http_routes.generate_lesson 的 relay）。 */
export type StreamEvent =
  | { delta: string }
  | { done: true; code: string }
  | { error: string };

/**
 * 從串流緩衝區切出「完整的行」，尾巴那段還沒收完的留著。
 *
 * 網路切塊不會剛好落在換行上——一個 JSON 物件可能橫跨兩次 read。沒有把殘段
 * 留下來的話，中文字被切一半就會 parse 失敗，串流看起來像隨機掉字。
 */
export function takeCompleteLines(buffer: string): { events: StreamEvent[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const line of parts) {
    const text = line.trim();
    if (!text) continue;
    try {
      events.push(JSON.parse(text) as StreamEvent);
    } catch {
      // 壞掉的一行不該讓整段串流中斷；略過，繼續收下一行。
    }
  }
  return { events, rest };
}
