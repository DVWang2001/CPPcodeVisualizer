export type Annotation = { guide: string; tts: string; layout: string };

const FIELD_RE = /@(guide|tts|layout)\b/g;

// A `//@` directive lives on ONE source line, but guide/tts values may contain
// real newlines (multi-line narration). Escape them (and backslashes) so the
// directive stays single-line, and reverse it on parse so the consumer gets the
// original text back. Values without these characters are unchanged.
function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function unescapeValue(v: string): string {
  return v.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c));
}

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
    out[marks[i].key] = unescapeValue(body.slice(valStart, valEnd).trim());
  }
  return out;
}

/** Return the `//@` body of a single source line, or null if none. */
export function directiveBody(line: string): string | null {
  const idx = line.indexOf("//@");
  if (idx === -1) return null;
  return line.slice(idx + 3);
}

/** Return the code portion of a line, with any trailing `//@` directive removed. */
export function stripDirective(line: string): string {
  const idx = line.indexOf("//@");
  return idx === -1 ? line : line.slice(0, idx).replace(/\s+$/, "");
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

export function parseLineAnnotation(line: string): Annotation {
  const body = directiveBody(line);
  return body === null ? { guide: "", tts: "", layout: "" } : parseLineBody(body);
}

export function serializeAnnotation(a: Annotation): string {
  const parts: string[] = [];
  if (a.guide.trim()) parts.push(`@guide ${escapeValue(a.guide.trim())}`);
  if (a.tts.trim()) parts.push(`@tts ${escapeValue(a.tts.trim())}`);
  if (a.layout.trim()) parts.push(`@layout ${escapeValue(a.layout.trim())}`);
  return parts.length ? `//@ ${parts.join(" ")}` : "";
}

export function upsertLineAnnotation(line: string, a: Annotation): string {
  const idx = line.indexOf("//@");
  const code = (idx === -1 ? line : line.slice(0, idx)).replace(/\s+$/, "");
  const directive = serializeAnnotation(a);
  if (!directive) return code;
  return `${code}  ${directive}`;
}
