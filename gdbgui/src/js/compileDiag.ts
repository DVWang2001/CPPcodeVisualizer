// ── 編譯錯誤解析層：clang stderr 文字 → 結構化的 Diagnostic ─────────────
// 純字串處理，不碰 store、不碰 DOM。格式以引擎實測的 clang 輸出為準
// （tests/compile-diag/probe.mjs）：
//   main.cpp:2:33: error: use of undeclared identifier 'cnt'
//       2 |   for (...) { cnt += i; }        ← 原始碼摘錄，略過
//         |                                  ← 插入點標記，略過
//   main.cpp:2:5: note: previous definition is here   ← 附註，掛在前一個診斷下
// 無法解析的行一律略過，不丟出例外。

export type Severity = "error" | "warning" | "note";

export interface Diagnostic {
  severity: Severity;
  file: string;
  line: number;
  col: number;
  message: string;
  notes: Diagnostic[];
}

// 「main.cpp:2:33: error: 訊息」，file 可能含路徑分隔符，故用非貪婪匹配到第一個 :行:列:
const HEAD = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s?(.*)$/;

/** 把 clang 的 stderr 解析成診斷清單。note 歸屬於它前面最近的 error/warning。 */
export function parseCompileDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let current: Diagnostic | null = null;
  for (const raw of (stderr || "").split(/\r?\n/)) {
    const m = HEAD.exec(raw);
    if (!m) continue; // 原始碼摘錄、插入點、「N errors generated.」等都不是診斷標頭
    const d: Diagnostic = {
      severity: m[4] as Severity,
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      message: m[5],
      notes: [],
    };
    if (d.severity === "note") {
      if (current) current.notes.push(d);
      continue; // 孤立的 note（前面沒有 error/warning）略過，不單獨成為診斷
    }
    out.push(d);
    current = d;
  }
  return out;
}
