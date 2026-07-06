export type Annotation = { guide: string; tts: string; layout: string };

const FIELD_RE = /@(guide|tts|layout)\b/g;

/** Parse the content after `//@` on one line into up to three fields. */
export function parseLineBody(body: string): Annotation {
  const out: Annotation = { guide: "", tts: "", layout: "" };
  const marks: { key: keyof Annotation; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(body)) !== null) {
    marks.push({ key: m[1] as keyof Annotation, start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const valStart = marks[i].end;
    const valEnd = i + 1 < marks.length ? marks[i + 1].start : body.length;
    out[marks[i].key] = body.slice(valStart, valEnd).trim();
  }
  return out;
}

/** Return the `//@` body of a single source line, or null if none. */
export function directiveBody(line: string): string | null {
  const idx = line.indexOf("//@");
  if (idx === -1) return null;
  return line.slice(idx + 3);
}

export function parseAnnotations(code: string) {
  const guide: Record<string, string> = {};
  const tts: Record<string, string> = {};
  const layout: Record<string, string> = {};
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const body = directiveBody(lines[i]);
    if (body === null) continue;
    const a = parseLineBody(body);
    const n = String(i + 1);
    if (a.guide) guide[n] = a.guide;
    if (a.tts) tts[n] = a.tts;
    if (a.layout) layout[n] = a.layout;
  }
  return { guide, tts, layout };
}
