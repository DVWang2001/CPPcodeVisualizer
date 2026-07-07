import { serializeAnnotation } from "./sourceAnnotations";

export type V2Bundle = {
  version: string; fullname_to_render: string; source_code: string;
  breakpoints: any[]; program_input: string;
};

function emptyV2(): V2Bundle {
  return { version: "2.0", fullname_to_render: "", source_code: "",
    breakpoints: [], program_input: "" };
}

export function normalizeBundle(raw: any): V2Bundle {
  if (!raw || typeof raw !== "object") {
    console.warn("[bundleAdapter] malformed bundle, returning empty v2");
    return emptyV2();
  }
  const base: V2Bundle = {
    version: "2.0",
    fullname_to_render: raw.fullname_to_render || "",
    source_code: typeof raw.source_code === "string" ? raw.source_code : "",
    breakpoints: Array.isArray(raw.breakpoints) ? raw.breakpoints : [],
    program_input: raw.program_input || "",
  };
  const ld = raw.line_data;
  if (!ld || typeof ld !== "object" || Object.keys(ld).length === 0) {
    return base; // already v2
  }
  const lines = base.source_code.split("\n");
  for (const [key, data] of Object.entries(ld as Record<string, any>)) {
    const n = parseInt(key, 10);
    if (isNaN(n) || n < 1 || n > lines.length) {
      console.warn(`[bundleAdapter] line ${key} out of range, skipped`);
      continue;
    }
    const directive = serializeAnnotation({
      guide: data.guide || "", tts: data.tts || "", layout: data.layout || "",
    });
    if (!directive) continue;
    const existing = lines[n - 1];
    if (existing.indexOf("//") !== -1) {
      console.warn(`[bundleAdapter] line ${key} already has a comment; inserting //@ before it`);
      const ci = existing.indexOf("//");
      lines[n - 1] = existing.slice(0, ci).replace(/\s+$/, "") + "  " + directive + " " + existing.slice(ci);
    } else {
      lines[n - 1] = existing.replace(/\s+$/, "") + "  " + directive;
    }
  }
  base.source_code = lines.join("\n");
  return base;
}
