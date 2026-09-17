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
