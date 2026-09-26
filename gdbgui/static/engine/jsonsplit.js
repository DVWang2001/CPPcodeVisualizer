// @ts-check
// Split clang's `-ast-dump=json` output (one top-level JSON object per matching declaration,
// concatenated) into parsed objects. Brace depth is tracked outside string literals only.
/** @param {string} text @returns {any[]} */
export function splitJson(text) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92 /* \ */) esc = true;
      else if (c === 34 /* " */) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 /* { */) { if (depth++ === 0) start = i; }
    else if (c === 125 /* } */) {
      if (depth === 0) throw new Error("splitJson: unbalanced '}' at " + i);
      if (--depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (depth !== 0 || inStr) throw new Error("splitJson: truncated JSON");
  return out;
}
