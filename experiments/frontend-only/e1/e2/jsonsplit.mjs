// 把串在一起的多個頂層 JSON 物件切開（clang 的 -ast-dump=json 每個符合篩選的宣告輸出一個）。
export function splitJson(text) {
  const out = []; let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}") { if (--depth === 0) out.push(JSON.parse(text.slice(start, i + 1))); }
  }
  return out;
}
