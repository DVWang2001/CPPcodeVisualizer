const KEYWORDS = new Set([
  "int", "char", "bool", "float", "double", "void", "long", "short", "unsigned",
  "signed", "auto", "const", "static", "return", "if", "else", "while", "for",
  "do", "switch", "case", "break", "continue", "struct", "class", "public",
  "private", "protected", "new", "delete", "true", "false", "nullptr", "using",
  "namespace", "std", "include", "sizeof", "template", "typename", "this",
]);

export function lineIdentifiers(codeLine: string): string[] {
  const code = codeLine.replace(/\/\/.*$/, ""); // drop trailing line comment
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const id = m[0];
    if (KEYWORDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function insertAtCursor(text: string, pos: number, insert: string): { text: string; pos: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  return { text: text.slice(0, p) + insert + text.slice(p), pos: p + insert.length };
}

export function replaceRange(text: string, from: number, to: number, insert: string): { text: string; pos: number } {
  const a = Math.max(0, Math.min(from, text.length));
  const b = Math.max(a, Math.min(to, text.length));
  return { text: text.slice(0, a) + insert + text.slice(b), pos: a + insert.length };
}

/** If an in-progress `{ident` token ends exactly at the caret, return the index of its `{`; else null. */
export function activeTokenStart(textBeforeCaret: string): number | null {
  const m = textBeforeCaret.match(/\{([A-Za-z0-9_]*)$/);
  return m ? m.index! : null;
}

export function filterCandidates(prefix: string, candidates: string[]): string[] {
  const lp = prefix.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    if (c.toLowerCase().startsWith(lp)) { seen.add(c); out.push(c); }
  }
  return out;
}
