import { store } from "statorgfc";

// Shared {var} → live-value substitution for @guide text. Used by both the
// Visualizer side panel (full text) and CallGraph (segmented, for value
// highlighting). `expressions` defaults to the live store so callers don't
// need to thread it through in production, but unit tests can pass a fixed
// array without touching statorgfc.
function findExprValue(expressions: any[], name: string): string | undefined {
  const found = expressions.find(
    (obj: any) => obj.in_scope === "true" && obj.value !== undefined &&
      (obj.expression === name || obj.expression.endsWith("::" + name))
  );
  return found ? found.value : undefined;
}

export function resolveGuideText(raw: string, expressions: any[] = store.get("expressions") || []): string {
  if (!raw || !raw.includes("{")) return raw;
  return raw.replace(/\{([^{}]+)\}/g, (_match, varName) => {
    const name = varName.trim();
    const value = findExprValue(expressions, name);
    return value !== undefined ? value : `{${name}}`;
  });
}

export type GuideSegment = { text: string; isValue: boolean };

export function resolveGuideSegments(raw: string, expressions: any[] = store.get("expressions") || []): GuideSegment[] {
  if (!raw) return [];
  if (!raw.includes("{")) return [{ text: raw, isValue: false }];

  const segments: GuideSegment[] = [];
  let lastIndex = 0;
  const re = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: raw.slice(lastIndex, match.index), isValue: false });
    }
    const name = match[1].trim();
    const value = findExprValue(expressions, name);
    if (value !== undefined) {
      segments.push({ text: value, isValue: true });
    } else {
      segments.push({ text: `{${name}}`, isValue: false });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < raw.length) {
    segments.push({ text: raw.slice(lastIndex), isValue: false });
  }
  return segments;
}
