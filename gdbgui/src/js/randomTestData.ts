/**
 * 課堂用隨機測資產生器：每個支援的教案對應一個產生器，用檔名（basename）配對。
 * 邏輯跟 scripts/gen_grid_paths.py 同一套規則，寫在前端是因為上課現場更常用
 * 這條路——按鈕直接換 Standard Input，不必切去終端機跑腳本再貼回來。
 */

type Generator = (rng?: () => number) => string;

function randomGridPathsInput(rng: () => number = Math.random): string {
  const wallRate = 0.25;
  const h = 3 + Math.floor(rng() * 6); // 3~8
  const w = 3 + Math.floor(rng() * 6); // 3~8

  const rows: string[] = [];
  for (let i = 0; i < h; i++) {
    let row = "";
    for (let j = 0; j < w; j++) row += rng() < wallRate ? "#" : ".";
    rows.push(row);
  }
  // 起點與終點保證是通道：兩者是牆答案就是 0，拿來當課堂教材沒有意義。
  rows[0] = "." + rows[0].slice(1);
  rows[h - 1] = rows[h - 1].slice(0, w - 1) + ".";

  return `${h} ${w}\n${rows.join("\n")}\n`;
}


/**
 * 教案內建的隨機測資腳本：.cpp 裡每行 `// @random <指令>` 是一條指令，依序執行，
 * print / matrix / line / grid 產生的輸出串起來就是測資。只跑白名單指令，不執行任何程式碼。
 *   名稱 = N | lo..hi        宣告變數
 *   print 值…                印一行（值是變數或整數）
 *   line n lo..hi            印一行 n 個整數
 *   matrix h w lo..hi [distinct]   印 h 行、每行 w 個整數；distinct = 全不重複
 *   grid h w 字元集 機率 [corners] 印 h 行 w 字元的地圖；corners = 起訖點保證是 字元集[0]
 * 放在檔尾，才不會擠動上面程式的行號（斷點、填表題觸發行都吃行號）。
 */
const RANDOM_LINE = /^\s*\/\/\s*@random\s+(.*?)\s*$/;

function parseRange(tok: string, vars: Record<string, number>, rng: () => number): number {
  const m = tok.match(/^(-?\w+)\.\.(-?\w+)$/);
  if (!m) return val(tok, vars);
  const lo = val(m[1], vars);
  const hi = val(m[2], vars);
  if (hi < lo) throw new Error(`範圍 ${tok} 上界小於下界`);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function val(tok: string, vars: Record<string, number>): number {
  if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
  if (tok in vars) return vars[tok];
  throw new Error(`未宣告的變數或不是整數：${tok}`);
}

function bounds(tok: string, vars: Record<string, number>): [number, number] {
  const m = tok.match(/^(-?\w+)\.\.(-?\w+)$/);
  if (!m) throw new Error(`需要範圍 lo..hi：${tok}`);
  return [val(m[1], vars), val(m[2], vars)];
}

/** 解析 + 執行；語法錯誤丟 Error（訊息含行號）。 */
export function runRandomScript(source: string, rng: () => number = Math.random): string | null {
  const lines = source.split(/\r?\n/);
  const vars: Record<string, number> = {};
  let out = "";
  let found = false;
  lines.forEach((raw, idx) => {
    const m = raw.match(RANDOM_LINE);
    if (!m) return;
    found = true;
    const t = m[1].split(/\s+/);
    try {
      if (t[1] === "=" && t.length === 3) {
        vars[t[0]] = parseRange(t[2], vars, rng);
      } else if (t[0] === "print") {
        out += t.slice(1).map(x => val(x, vars)).join(" ") + "\n";
      } else if (t[0] === "line") {
        const n = val(t[1], vars);
        const [lo, hi] = bounds(t[2], vars);
        out += Array.from({ length: n }, () => lo + Math.floor(rng() * (hi - lo + 1))).join(" ") + "\n";
      } else if (t[0] === "matrix") {
        const h = val(t[1], vars);
        const w = val(t[2], vars);
        const [lo, hi] = bounds(t[3], vars);
        let pool: number[] | null = null;
        if (t[4] === "distinct") {
          if (hi - lo + 1 < h * w) throw new Error(`distinct 需要至少 ${h * w} 個值，範圍只有 ${hi - lo + 1} 個`);
          pool = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        } else if (t[4]) throw new Error(`不認得的選項：${t[4]}`);
        const cells: number[] = [];
        for (let i = 0; i < h * w; i++) {
          if (pool) cells.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          else cells.push(lo + Math.floor(rng() * (hi - lo + 1)));
        }
        for (let i = 0; i < h; i++) out += cells.slice(i * w, (i + 1) * w).join(" ") + "\n";
      } else if (t[0] === "grid") {
        const h = val(t[1], vars);
        const w = val(t[2], vars);
        const chars = t[3];
        const rate = parseFloat(t[4]);
        if (!chars || isNaN(rate)) throw new Error("grid 需要 字元集 與 機率");
        const rows: string[] = [];
        for (let i = 0; i < h; i++) {
          let r = "";
          for (let j = 0; j < w; j++) r += rng() < rate ? chars[chars.length - 1] : chars[0];
          rows.push(r);
        }
        if (t[5] === "corners") {
          rows[0] = chars[0] + rows[0].slice(1);
          rows[h - 1] = rows[h - 1].slice(0, w - 1) + chars[0];
        }
        out += rows.join("\n") + "\n";
      } else {
        throw new Error(`不認得的指令：${t[0]}`);
      }
    } catch (e) {
      throw new Error(`// @random 第 ${idx + 1} 行：${(e as Error).message}`);
    }
  });
  return found ? out : null;
}

/** 有 @random 腳本且語法正確就回傳產生器，否則 null（錯誤印 console）。 */
function scriptGenerator(source: string): Generator | null {
  try {
    if (runRandomScript(source) === null) return null; // 試跑一次驗證語法
  } catch (e) {
    console.warn((e as Error).message);
    return null;
  }
  return rng => runRandomScript(source, rng) as string;
}

const GENERATORS: Record<string, Generator> = {
  "grid_paths.cpp": randomGridPathsInput,
  "grid_derivation.cpp": randomGridPathsInput
};

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || "";
}

import { store } from "statorgfc";

function getSourceCodeString(fullnameToRender?: string | null): string {
  if (typeof window !== "undefined") {
    const editor = (window as any).gdbgui_editor_instance;
    if (editor && typeof editor.getValue === "function") {
      const code = editor.getValue();
      if (code) return code;
    }
  }

  if (typeof localStorage !== "undefined") {
    const imported = localStorage.getItem("gdbgui_editor_code___imported__");
    if (imported) return imported;
    if (fullnameToRender) {
      const byName = localStorage.getItem("gdbgui_editor_code_" + fullnameToRender);
      if (byName) return byName;
    }
  }

  let cachedFiles: any[] = [];
  try {
    cachedFiles = store.get("cached_source_files") || [];
  } catch (_) {}
  if (Array.isArray(cachedFiles)) {
    for (const f of cachedFiles) {
      if (!f || !f.source_code) continue;
      if (typeof f.source_code === "string") return f.source_code;
      if (typeof f.source_code === "object") {
        return Object.values(f.source_code).join("\n");
      }
    }
  }

  return "";
}

/** 有支援的教案回傳它的產生器，否則回傳 null（按鈕就不該顯示）。 */
export function randomTestDataFor(fullnameToRender?: string | null): Generator | null {
  const script = scriptGenerator(getSourceCodeString(fullnameToRender));
  if (script) return script;

  if (fullnameToRender) {
    const base = basename(fullnameToRender);
    if (GENERATORS[base]) return GENERATORS[base];
  }

  let userFn: string | null = null;
  try {
    userFn = store.get("user_source_fullname");
  } catch (_) {}
  if (userFn) {
    const base = basename(userFn);
    if (GENERATORS[base]) return GENERATORS[base];
  }

  // 靜態檔名如果被重命名成 main.cpp / __imported__ 等，檢查程式碼內容標頭
  const sourceContent = getSourceCodeString(fullnameToRender);
  if (sourceContent) {
    if (
      sourceContent.includes("走方格") ||
      sourceContent.includes("Grid 1") ||
      sourceContent.includes("grid_paths") ||
      sourceContent.includes("grid_derivation")
    ) {
      return randomGridPathsInput;
    }
  }

  return null;
}
