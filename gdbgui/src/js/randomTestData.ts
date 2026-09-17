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

/** 有支援的教案回傳它的產生器，否則回傳 null（按鈕就不該顯示）。 */
export function randomTestDataFor(fullnameToRender?: string | null): Generator | null {
  if (fullnameToRender) {
    const base = basename(fullnameToRender);
    if (GENERATORS[base]) return GENERATORS[base];
  }

  const userFn = store.get("user_source_fullname");
  if (userFn) {
    const base = basename(userFn);
    if (GENERATORS[base]) return GENERATORS[base];
  }

  // 靜態檔名如果被重命名成 main.cpp / __imported__ 等，檢查程式碼內容標頭
  const cachedFiles = store.get("cached_source_files") || [];
  let sourceContent = "";
  if (fullnameToRender && Array.isArray(cachedFiles)) {
    const found = cachedFiles.find((f: any) => f.fullname === fullnameToRender);
    if (found && found.source_code) sourceContent = found.source_code;
  }
  if (!sourceContent && Array.isArray(cachedFiles) && cachedFiles.length > 0) {
    sourceContent = cachedFiles[0].source_code || "";
  }

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
