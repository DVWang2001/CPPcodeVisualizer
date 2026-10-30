// ── 編譯錯誤分類層：Diagnostic → 家族（1–6）與子類型（kind）──────────────
// 純函式。訊息文字以引擎實測的 clang 輸出為準（tests/compile-diag/expected.json）。
// 未知訊息一律回傳 family:"other"，保留原文，不丟掉。

import type { Diagnostic } from "./compileDiag";

export type Family = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | "other";
export interface Classified {
  family: Family;
  kind: string;
}

const TYPE_DECL = "(?:int|char|bool|double|float|long|short|unsigned|auto|size_t|string|std::string)";

/** 名稱是否在原始碼的其他地方被宣告過（用來區分 out-of-scope 與 undeclared，clang 文字相同）。 */
function isDeclaredSomewhere(name: string, source: string): boolean {
  const re = new RegExp(`\\b${TYPE_DECL}\\s*[*&]?\\s*${name}\\b`);
  return re.test(source);
}

/**
 * 錯誤是否位於標準函式庫等系統標頭（clang 以 /include/… 等絕對路徑回報）。
 * 注意：使用者的檔案在瀏覽器引擎中是 /workspace/main.cpp，也是絕對路徑，不能只用「/」判斷，
 * 否則使用者的錯誤會被當成標頭而整個過濾掉（這是實機 e2e 才抓到的問題）。
 */
export function isHeaderFile(file: string): boolean {
  return file.startsWith("/") && !/(^|\/)main\.cpp$/.test(file);
}

/** 單一診斷的分類（不含跨診斷的分組，見 classifyDiagnostics / toViewItems）。 */
export function classifyDiagnostic(d: Diagnostic, source = ""): Classified {
  const m = d.message;

  let r: RegExpExecArray | null;
  if ((r = /use of undeclared identifier '(\w+)'/.exec(m))) {
    if (r[1] === "std") return { family: 1, kind: "missing-include" };
    return isDeclaredSomewhere(r[1], source)
      ? { family: 1, kind: "out-of-scope" }
      : { family: 1, kind: "undeclared" };
  }
  if (/^redefinition of '/.test(m)) return { family: 1, kind: "redefinition" };
  if (/^unknown type name '/.test(m)) return { family: 1, kind: "missing-include" };

  if (/^cannot initialize return object of type/.test(m)) return { family: 2, kind: "return-type" };
  if (/^cannot initialize a variable of type '[^']*\*'/.test(m)) return { family: 2, kind: "ptr-value" };
  if (/^cannot initialize a variable of type/.test(m)) return { family: 2, kind: "init-type" };
  if (/cannot be narrowed from type/.test(m)) return { family: 2, kind: "narrowing" };

  if (/^expected ';' (at end of declaration|after expression|after top level declarator)/.test(m))
    return { family: 3, kind: "missing-semicolon" };
  if (/^expected '\)'/.test(m)) return { family: 3, kind: "missing-paren" };
  if (/^missing 'typename' prior to dependent type name/.test(m)) return { family: 3, kind: "missing-typename" };
  if (/^cannot jump from switch statement/.test(m)) return { family: 3, kind: "case-jump" };

  // 家族 4：函式呼叫與多載
  if (/^no matching function for call to '/.test(m)) {
    // 模板參數無法推導：clang 以附註 "couldn't infer template argument" 說明，歸入家族 5
    if (d.notes.some((n) => /couldn't infer template argument/.test(n.message)))
      return { family: 5, kind: "deduction-failed" };
    return { family: 4, kind: "no-matching-call" };
  }
  if (/^call to '[^']*' is ambiguous/.test(m)) return { family: 4, kind: "ambiguous-call" };
  if (/^no member named '/.test(m)) return { family: 4, kind: "no-member" };
  if (/^no matching constructor for initialization of/.test(m)) return { family: 4, kind: "no-matching-ctor" };

  // 家族 5：模板與自動推導
  if (/deduced type 'auto' requires an initializer/.test(m)) return { family: 5, kind: "auto-no-init" };
  if (/^invalid operands to binary expression/.test(m))
    // 同一句訊息：位於標頭檔是模板實例化的內部錯誤（錨點畫面），位於使用者檔案才是運算子不支援
    return isHeaderFile(d.file) ? { family: 5, kind: "template-operator" } : { family: 5, kind: "binary-operator" };

  // 家族 6：const 與存取權限
  if (/^cannot assign to variable '.*' with const-qualified type/.test(m)) return { family: 6, kind: "const-assign" };
  if (/^'this' argument to member function '.*' has type .*, but function is not marked const/.test(m))
    return { family: 6, kind: "discards-qualifiers" };
  if (/ is a private member of /.test(m)) return { family: 6, kind: "private-access" };
  if (/^call to non-static member function without an object argument/.test(m)) return { family: 6, kind: "static-context" };

  // 家族 7：類別與繼承
  if (/^variable has incomplete type '/.test(m)) return { family: 7, kind: "incomplete-type" };
  if (/^variable type '[^']*' is an abstract class$/.test(m)) return { family: 7, kind: "abstract-class" };
  if (/^'[^']*' marked 'override' but does not override any member functions/.test(m) ||
      /^only virtual member functions can be marked 'override'/.test(m))
    return { family: 7, kind: "override-mismatch" };

  // 家族 8：流程與回傳
  if (/cannot be implicitly captured in a lambda with no capture-default specified/.test(m))
    return { family: 8, kind: "lambda-capture" };
  if (/must match previous return type .* when lambda expression has unspecified explicit return type/.test(m))
    return { family: 8, kind: "lambda-return" };
  if (/^cannot jump from this goto statement to its label/.test(m)) return { family: 8, kind: "goto-jump" };
  if (/^variable length array declaration not allowed at file scope/.test(m)) return { family: 8, kind: "vla-file-scope" };

  return { family: "other", kind: "other" };
}

/**
 * 全部診斷的分類。同一種缺分號若出現多次，稱為 syntax-chain（語法連鎖分組）。
 * 只有 error 會被分類；warning 與 note 不在範圍內，回傳 other。
 */
export function classifyDiagnostics(ds: Diagnostic[], source = ""): Classified[] {
  const base = ds.map((d) => (d.severity === "error" ? classifyDiagnostic(d, source) : { family: "other" as Family, kind: "other" }));
  const semis = base.filter((c) => c.kind === "missing-semicolon").length;
  if (semis >= 2) {
    return base.map((c) => (c.kind === "missing-semicolon" ? { family: 3, kind: "syntax-chain" } : c));
  }
  return base;
}

/** 畫面用的一個項目：要畫的診斷（位置可能已換成錨點）、家族與子類型。 */
export interface ViewItem {
  diag: Diagnostic;
  family: Family;
  kind: string;
}

/**
 * 把診斷清單轉成要畫的畫面清單，套用第二期的錨點規則：
 * - 標頭檔內的模板實例化錯誤（template-operator）：只畫一個畫面，位置換成使用者檔案中的
 *   「requested here」附註（錨點）。同一個錨點的多個標頭錯誤合併成一個畫面。
 * - 標頭檔內的其他錯誤：不另外畫，屬於上述錨點的連鎖（收合在原文中）。
 * - 使用者檔案中的錯誤：各自一個畫面。
 */
export function toViewItems(ds: Diagnostic[], source = ""): ViewItem[] {
  const errs = ds.filter((d) => d.severity === "error");
  const classified = classifyDiagnostics(errs, source);
  const out: ViewItem[] = [];
  const seenAnchors = new Set<number>();
  errs.forEach((d, i) => {
    const c = classified[i];
    if (!isHeaderFile(d.file)) {
      out.push({ diag: d, family: c.family, kind: c.kind });
      return;
    }
    if (c.kind !== "template-operator") return; // 標頭內其他錯誤：併入錨點，不另畫
    const anchor = d.notes.find((n) => !isHeaderFile(n.file) && /requested here/.test(n.message));
    if (!anchor) {
      // 找不到錨點：退回原文，仍保留標頭內的錯誤，不丟掉
      out.push({ diag: d, family: "other", kind: "other" });
      return;
    }
    if (seenAnchors.has(anchor.line)) return;
    seenAnchors.add(anchor.line);
    out.push({
      diag: { ...d, file: anchor.file, line: anchor.line, col: anchor.col },
      family: c.family,
      kind: c.kind,
    });
  });
  return out;
}
