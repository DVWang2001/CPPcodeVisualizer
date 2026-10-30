import React from "react";
import type { Diagnostic } from "./compileDiag";
import type { Family } from "./compileFamily";

// ── 編譯錯誤的視覺化畫面（第一期：家族 1–3；第二期：家族 4–6）──────────────
// 每個子類型一個畫面，結構與文字對應 Claude Design 畫布（第一期、第二期各一張）。
// 中文說明為白話，術語放在括號中；原始 clang 訊息收合在底部。
// 名稱（cnt、i、Card、bump…）取自 clang 訊息本身，不是寫死的。

const FAMILY_LABEL: Record<string, string> = {
  "1": "名稱與作用域", "2": "型別", "3": "語法",
  "4": "函式呼叫與多載", "5": "模板與自動推導", "6": "const 與權限", "7": "類別與繼承", "8": "流程與回傳",
};

const TITLE: Record<string, string> = {
  "undeclared": "未宣告的名稱（undeclared）",
  "out-of-scope": "超出作用域（out-of-scope）",
  "redefinition": "重複定義（redefinition）",
  "missing-include": "缺少標頭（missing-include）",
  "init-type": "初始化型別不符（init-type）",
  "ptr-value": "指標與值（ptr-value）",
  "return-type": "回傳型別不符（return-type）",
  "narrowing": "窄化轉換（narrowing）",
  "missing-semicolon": "缺少分號（missing-semicolon）",
  "missing-paren": "缺少右括號（missing-paren）",
  "syntax-chain": "語法連鎖（syntax-chain）",
  "missing-typename": "缺少 typename（missing-typename）",
  "case-jump": "跨越 case 初始化（case-jump）",
  "no-matching-call": "參數不符（no-matching-call）",
  "ambiguous-call": "二義性呼叫（ambiguous-call）",
  "no-member": "沒有這個成員（no-member）",
  "no-matching-ctor": "建構子參數不符（no-matching-ctor）",
  "deduction-failed": "模板推導失敗（deduction-failed）",
  "template-operator": "模板實例化失敗（template-operator，錨點）",
  "incomplete-type": "不完整型別（incomplete-type）",
  "abstract-class": "抽象類別（abstract-class）",
  "override-mismatch": "覆寫不符（override-mismatch）",
  "lambda-capture": "lambda 捕捉（lambda-capture）",
  "lambda-return": "lambda 回傳型別衝突（lambda-return）",
  "goto-jump": "goto 跨越初始化（goto-jump）",
  "vla-file-scope": "全域非常數陣列（vla-file-scope）",
  "auto-no-init": "auto 沒有初始值（auto-no-init）",
  "binary-operator": "運算子不支援（binary-operator）",
  "const-assign": "修改常數（const-assign）",
  "discards-qualifiers": "const 物件呼叫非 const 方法（discards-qualifiers）",
  "private-access": "存取私有成員（private-access）",
  "static-context": "靜態上下文（static-context）",
};

const mono: React.CSSProperties = { fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace" };
const box: React.CSSProperties = { padding: "10px 12px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#F8FAFC" };
const blue = "#1D4ED8";
const red = "#C2410C";
const blueBox: React.CSSProperties = { ...box, flex: 1, border: `2px solid ${blue}`, background: "#EEF4FF" };
const redBox: React.CSSProperties = { ...box, flex: 1, border: `3px solid ${red}`, background: "#FDF0EA" };
const dashedRedBox: React.CSSProperties = { ...box, flex: 1, border: `3px dashed ${red}`, background: "#FDF0EA", color: red };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

/** 候選清單最多顯示幾個，超過的收合（完整內容在原文中）。 */
export const CANDIDATE_LIMIT = 5;

/** 從 clang 訊息中取出第一個引號內的名稱，例如 'cnt'、'vector'。取不到回傳 "?"。 */
function quotedName(message: string): string {
  const m = /'([^']+)'/.exec(message);
  return m ? m[1] : "?";
}

/** 從 clang 訊息中取出型別名稱（"of type 'X'"）。 */
function typeName(message: string): string {
  const m = /of type '([^']+)'/.exec(message);
  return m ? m[1] : "?";
}

/** clang 的 lvalue/rvalue 型別（字串常值為 const char[N]）。 */
function lvalueType(message: string): string {
  const m = /with an lvalue of type '([^']+)'/.exec(message) || /with an rvalue of type '([^']+)'/.exec(message);
  return m ? m[1] : "?";
}

/** 錯誤所在的原始碼行（取自編輯器內容），第一行號從 1 起算。 */
function sourceLine(source: string | undefined, line: number): string | null {
  if (!source) return null;
  const lines = source.split("\n");
  return line >= 1 && line <= lines.length ? lines[line - 1] : null;
}

/** 候選說明：clang 的 "candidate ..." 附註，排除隱含的複製/移動建構子（與使用者的錯誤無關）。 */
export function candidateNotes(notes: Diagnostic[]): Diagnostic[] {
  return notes.filter((n) => /^candidate/.test(n.message) && !/\(the implicit /.test(n.message));
}

/** 候選清單：每個候選的宣告行與 clang 說明；超過上限時註明還有幾個。 */
function CandidateList({ notes, source }: { notes: Diagnostic[]; source?: string }) {
  const cands = candidateNotes(notes);
  if (cands.length === 0) return null;
  const shown = cands.slice(0, CANDIDATE_LIMIT);
  const more = cands.length - shown.length;
  return (
    <div data-testid="candidate-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {shown.map((n, i) => (
        <div key={i} data-testid="candidate-item" style={{ ...box, border: `1px solid ${blue}`, background: "#EEF4FF" }}>
          <div style={{ ...mono, fontSize: 14 }}>{sourceLine(source, n.line) ?? `第 ${n.line} 行`}</div>
          <div style={{ fontSize: 13, color: "#57606A", marginTop: 4 }}>{n.message}</div>
        </div>
      ))}
      {more > 0 && <div style={{ fontSize: 13, color: "#57606A" }}>還有 {more} 個候選（完整內容見下方收合的原文）</div>}
    </div>
  );
}

function Visual({ kind, diag, source }: { kind: string; diag: Diagnostic; source?: string }) {
  const message = diag.message;
  const notes = diag.notes;
  switch (kind) {
    case "undeclared": {
      const n = quotedName(message);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={row}><div style={{ ...box, width: 260, border: `1px solid ${blue}`, background: "#EEF4FF" }}>for 區塊：i</div><span style={{ color: blue, fontWeight: 700 }}>✕ 名字不是 {n}</span></div>
          <div style={row}><div style={{ ...box, width: 260 }}>main 區塊</div><span style={{ color: "#57606A", fontWeight: 700 }}>✕ 沒有 {n}</span></div>
          <div style={row}><div style={{ ...box, width: 260 }}>全域範圍</div><span style={{ color: red, fontWeight: 700 }}>✕ 沒有 {n}，停止查找</span></div>
        </div>
      );
    }
    case "out-of-scope": {
      const n = quotedName(message);
      return (
        <div style={{ display: "flex", gap: 24 }}>
          <div style={{ ...blueBox, color: blue }}>
            <div style={{ fontSize: 13 }}>for 迴圈範圍（{n} 活在這裡）</div>
            <pre style={{ ...mono, fontSize: 13, margin: "6px 0 0" }}>{`for (int ${n} = 0; ...) {\n  // ${n} 有效\n}`}</pre>
          </div>
          <div style={dashedRedBox}>
            <div style={{ fontSize: 13 }}>迴圈外（{n} 已經不存在）</div>
            <pre style={{ ...mono, fontSize: 13, margin: "6px 0 0" }}>{`使用 ${n}`}</pre>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>✕ 使用點在框外</div>
          </div>
        </div>
      );
    }
    case "redefinition": {
      // 第 1 次宣告的位置由附註（previous definition is here）給出；兩行都從原始碼取
      const first = notes.length ? sourceLine(source, notes[0].line) : null;
      const second = sourceLine(source, diag.line);
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>第 1 次宣告（先到）</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 6 }}>{first ?? "（附註沒有提供位置）"}</div></div>
          <div style={{ width: 90, textAlign: "center", fontSize: 14, color: red, fontWeight: 700 }}>同一個名字 {quotedName(message)}</div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>第 2 次宣告（衝突）</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 6 }}>{second ?? "（找不到原始碼）"}</div></div>
        </div>
      );
    }
    case "missing-include": {
      // clang 第一個錯誤是 'std'（缺的是標準函式庫的標頭），名稱不是使用者寫的那個東西
      const n = quotedName(message);
      const label = n === "std" ? "標準函式庫（std）" : n;
      return (
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ ...redBox, border: `3px solid ${red}` }}>
            <div style={{ fontSize: 13, color: red, fontWeight: 700 }}>根因</div>
            <div style={{ fontSize: 18, marginTop: 6 }}>沒有引入 {label} 的標頭</div>
            <div style={{ ...mono, fontSize: 15, marginTop: 10, color: red }}>#include &lt;…&gt; 缺少</div>
          </div>
          <div style={blueBox}>
            <div style={{ fontSize: 13, color: blue }}>{label} 在哪裡？</div>
            <div style={{ fontSize: 15, marginTop: 6, lineHeight: 1.7 }}>✕ 目前可見的範圍：沒有 {label}<br />✓ 加入標頭後：{label} 可以使用</div>
          </div>
        </div>
      );
    }
    case "init-type":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>變數的型別</div><div style={{ ...mono, fontSize: 22, fontWeight: 700, marginTop: 8 }}>{typeName(message)}</div></div>
          <div style={{ fontSize: 30, color: red, fontWeight: 700 }}>✕</div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>右邊的值的型別</div><div style={{ ...mono, fontSize: 20, fontWeight: 700, marginTop: 8 }}>{lvalueType(message)}</div></div>
        </div>
      );
    case "ptr-value":
      return (
        <div style={{ ...row, gap: 22 }}>
          <div style={{ ...box, width: 200, border: `2px solid ${blue}`, background: "#EEF4FF", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: blue }}>拿到的是值</div>
            <div style={{ ...mono, fontSize: 24, fontWeight: 700, marginTop: 6 }}>{lvalueType(message)}</div>
          </div>
          <div style={{ flex: 1, textAlign: "center", color: red, fontSize: 14, fontWeight: 700 }}>✕ 拿到的是值，不是位址</div>
          <div style={{ ...box, width: 220, border: `3px solid ${red}`, background: "#FDF0EA", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: red }}>指標（要存位址）</div>
            <div style={{ ...mono, fontSize: 20, fontWeight: 700, marginTop: 6 }}>{typeName(message)}</div>
          </div>
        </div>
      );
    case "return-type":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>函式宣告的回傳型別</div><div style={{ ...mono, fontSize: 22, fontWeight: 700, marginTop: 8 }}>{typeName(message)}</div></div>
          <div style={{ fontSize: 30, color: red, fontWeight: 700 }}>✕</div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>return 後面實際的值</div><div style={{ ...mono, fontSize: 20, fontWeight: 700, marginTop: 8 }}>{lvalueType(message)}</div></div>
        </div>
      );
    case "narrowing": {
      const bits = [1, 0, 0, 1, 0, 1, 1, 0, 0];
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 15, color: blue, fontWeight: 700 }}>300 的二進位：1 0010 1100（9 位元）；char 只有 8 位元</div>
          <div style={{ display: "flex", gap: 4 }}>
            {bits.map((b, i) => (
              <div key={i} style={{ width: 48, height: 40, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", borderRadius: 6, background: i === 0 ? red : blue, ...mono }}>{b}</div>
            ))}
          </div>
          <div style={{ fontSize: 15, color: "#57606A" }}>紅色：最高位元放不進 char，花括號初始化直接拒絕（不像一般賦值只給警告）。</div>
        </div>
      );
    }
    case "missing-semicolon":
      return (
        <div style={row}>
          <div style={{ ...box, background: "#EEF4FF", ...mono, fontSize: 16 }}>行尾</div>
          <div style={{ ...box, border: `2px dashed ${red}`, color: red, fontWeight: 700, ...mono, fontSize: 16 }}>;</div>
          <div style={{ fontSize: 14, color: red }}>← 預期在這裡</div>
        </div>
      );
    case "syntax-chain":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ ...box, border: `3px solid ${red}`, background: "#FDF0EA", display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, background: red, color: "#fff", padding: "3px 8px", borderRadius: 6 }}>第 {diag.line} 行</span>
            <span style={{ ...mono, fontSize: 14 }}>{message}</span>
          </div>
          <div style={{ fontSize: 13, color: "#57606A" }}>另一處獨立的缺分號也會出現同樣的訊息，修正一處不會讓另一處消失。</div>
        </div>
      );
    case "missing-paren":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>左括號 ( 開啟</div><div style={{ ...mono, fontSize: 22, marginTop: 6 }}>(</div></div>
          <div style={{ ...box, width: 180, textAlign: "center", border: `3px dashed ${red}`, background: "#FDF0EA" }}>
            <div style={{ fontSize: 13, color: red }}>缺少的 )</div>
            <div style={{ ...mono, fontSize: 26, fontWeight: 700, color: red, marginTop: 4 }}>)</div>
          </div>
        </div>
      );
    case "missing-typename":
      return (
        <div style={row}>
          <div style={{ ...blueBox, ...mono }}><div style={{ ...mono, fontSize: 13, color: blue, fontFamily: "inherit" }}>C 還不知道是什麼</div><div style={{ fontSize: 20, fontWeight: 700, marginTop: 8 }}>C::iterator</div></div>
          <div style={{ ...redBox, ...mono }}><div style={{ fontSize: 13, color: red, fontFamily: "inherit", fontWeight: 700 }}>加上 typename 就明確了</div><div style={{ fontSize: 20, fontWeight: 700, marginTop: 8 }}>typename C::iterator</div></div>
        </div>
      );
    case "case-jump":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>case 1 的區塊</div><div style={{ ...mono, fontSize: 15, marginTop: 6 }}>int y = 10</div><div style={{ fontSize: 13, color: "#57606A", marginTop: 4 }}>y 在這裡才被建立</div></div>
          <div style={dashedRedBox}><div style={{ fontSize: 13 }}>case 2 的入口</div><div style={{ ...mono, fontSize: 15, marginTop: 6 }}>直接跳到這裡</div><div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>✕ 略過了 y 的建立</div></div>
        </div>
      );

    // ── 第二期：家族 4 ─────────────────────────────────────────────
    case "no-matching-call": {
      const req = /requires (\d+) arguments?, but (\d+) (?:was|were) provided/.exec(notes.map((n) => n.message).join(" "));
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={row}>
            <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>實際呼叫</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>{quotedName(message)}（{req ? req[2] : "?"} 個參數）</div></div>
            <div style={{ fontSize: 30, color: red, fontWeight: 700 }}>✕</div>
            <div style={redBox}><div style={{ fontSize: 13, color: red }}>候選需要</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>{req ? `${req[1]} 個參數` : "不同的參數型別"}</div></div>
          </div>
          <CandidateList notes={notes} source={source} />
        </div>
      );
    }
    case "ambiguous-call":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 15, color: red, fontWeight: 700 }}>{quotedName(message)} 有多個候選同樣符合，編譯器無法選擇</div>
          <CandidateList notes={notes} source={source} />
        </div>
      );
    case "no-member": {
      const cls = /in '([^']+)'/.exec(message);
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>{cls ? cls[1] : "類別"} 有的成員</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>（見類別定義）</div></div>
          <div style={{ fontSize: 30, color: red, fontWeight: 700 }}>✕</div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>你呼叫的成員</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>{quotedName(message)}()</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ {cls ? cls[1] : "類別"} 裡沒有這個名字</div></div>
        </div>
      );
    }
    case "no-matching-ctor":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={row}>
            <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>{quotedName(message)} 的建構子</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>（見類別定義）</div></div>
            <div style={{ fontSize: 30, color: red, fontWeight: 700 }}>✕</div>
            <div style={redBox}><div style={{ fontSize: 13, color: red }}>你給的參數</div><div style={{ ...mono, fontSize: 16, marginTop: 6 }}>參數數量或型別不符</div></div>
          </div>
          <CandidateList notes={notes} source={source} />
          <div style={{ fontSize: 13, color: "#57606A" }}>編譯器列出的隱含複製與移動建構子與你的錯誤無關，所以不顯示，只留在下方收合的原文裡。</div>
        </div>
      );

    // ── 第二期：家族 5 ─────────────────────────────────────────────
    case "deduction-failed":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>模板參數 T</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 8 }}>？（未知）</div><div style={{ fontSize: 14, marginTop: 8 }}>{quotedName(message)}() 沒有任何參數可以推導 T</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red, fontWeight: 700 }}>需要的資訊</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{quotedName(message)}&lt;型別&gt;()</div><div style={{ fontSize: 14, color: red, marginTop: 8 }}>✓ 明確指定 T，就能呼叫</div></div>
        </div>
      );
    case "template-operator": {
      // 錨點畫面：你的程式（使用者檔案的錨點行）＋ 根因（標頭內的運算子缺失）
      const ty = (/\('(?:const )?([^']+)' and/.exec(message) || [])[1] ?? "?";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue, fontWeight: 700 }}>錨點：你的程式（第 {diag.line} 行）</div><div style={{ fontSize: 13, marginTop: 8 }}>函式庫在這裡要求 {ty} 能比較大小</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red, fontWeight: 700 }}>根因：{ty} 沒有 operator&lt;</div><div style={{ ...mono, fontSize: 15, marginTop: 8 }}>const {ty} &lt; const {ty} ?</div><div style={{ fontSize: 14, color: red, marginTop: 8 }}>✕ 無法比較，在標準函式庫內部失敗</div></div>
        </div>
      );
    }
    case "auto-no-init":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>auto 的型別從哪裡來？</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>auto x = 5;  → int</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>這裡的初始值</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>（沒有）</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 無從推導型別</div></div>
        </div>
      );
    case "binary-operator": {
      const ty = (/\('(?:const )?([^']+)' and/.exec(message) || [])[1] ?? "?";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>左邊：{ty}</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 8 }}>{ty} a</div></div>
          <div style={{ width: 110, display: "flex", flexDirection: "column", alignItems: "center" }}><div style={{ ...mono, fontSize: 22, color: red, fontWeight: 700 }}>?</div><div style={{ fontSize: 12, color: red }}>沒有定義</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>右邊：{ty}</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 8 }}>{ty} b</div></div>
        </div>
      );
    }

    // ── 第二期：家族 6 ─────────────────────────────────────────────
    case "const-assign": {
      const n = quotedName(message);
      return (
        <div style={row}>
          <div style={{ ...box, width: 220, height: 130, border: `3px solid ${blue}`, background: "#EEF4FF", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <div style={{ fontSize: 36 }}>🔒</div>
            <div style={{ ...mono, fontSize: 18 }}>{n}</div>
            <div style={{ fontSize: 13, color: blue }}>const：唯讀</div>
          </div>
          <div style={{ flex: 1, fontSize: 15, color: red, fontWeight: 700 }}>✕ 寫入被擋下：{n} 在宣告時就決定了</div>
        </div>
      );
    }
    case "discards-qualifiers": {
      // 第一個引號是 'this'，方法名在 "member function 'bump'"
      const method = (/member function '([^']+)'/.exec(message) || [])[1] ?? quotedName(message);
      const objType = (/has type '([^']+)'/.exec(message) || [])[1] ?? "?";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>物件的型別</div><div style={{ ...mono, fontSize: 16, fontWeight: 700, marginTop: 8 }}>{objType}</div><div style={{ fontSize: 13, marginTop: 6 }}>承諾：不修改這個物件</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>{method}() 的宣告</div><div style={{ ...mono, fontSize: 16, fontWeight: 700, marginTop: 8 }}>{method}()（沒有 const）</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ {method} 可能修改物件，違反承諾</div></div>
        </div>
      );
    }
    case "private-access": {
      const member = quotedName(message);
      const cls = (/of '([^']+)'/.exec(message) || [])[1] ?? "類別";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>{cls} 的欄位</div><div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}><span style={{ fontSize: 22 }}>🔒</span><span style={{ ...mono, fontSize: 16 }}>{member}（private）</span></div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>從外部存取</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>物件.{member}</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 外部不能直接讀取私有欄位</div></div>
        </div>
      );
    }
    case "static-context":
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>static 函式</div><div style={{ fontSize: 14, marginTop: 8 }}>屬於整個類別，沒有 this，不知道要用哪一個物件</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>呼叫非 static 成員</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>成員函式（需要物件）</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 這裡沒有物件可以用來呼叫</div></div>
        </div>
      );
    // ── 第三期：家族 7 ─────────────────────────────────────────────
    case "incomplete-type": {
      const n = quotedName(message);
      return (
        <div style={row}>
          <div style={{ ...blueBox, border: `2px dashed ${blue}` }}><div style={{ fontSize: 13, color: blue }}>{n} 的定義</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>（只宣告，沒有內容）</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red, fontWeight: 700 }}>需要的資訊</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{n} 的大小</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 編譯器不知道要配置多大的空間</div></div>
        </div>
      );
    }
    case "abstract-class": {
      const n = quotedName(message);
      const pure = (/unimplemented pure virtual method '([^']+)'/.exec(notes.map((x) => x.message).join(" ")) || [])[1] ?? "?";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>{n} 的成員</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{pure}() = 0　← 沒有實作</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>要建立的物件</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{n} 物件</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 抽象類別不能直接建立物件</div></div>
        </div>
      );
    }
    case "override-mismatch": {
      const fn = quotedName(message);
      const notBase = /does not override/.test(message);
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>基底的虛函式</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>draw()</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>宣告的 override</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{fn}()</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>{notBase ? `✕ 基底沒有 ${fn}，沒有覆寫任何東西` : `✕ 基底的 ${fn} 不是 virtual`}</div></div>
        </div>
      );
    }

    // ── 第三期：家族 8 ─────────────────────────────────────────────
    case "lambda-capture": {
      const n = quotedName(message);
      // 只保留兩條附註：declared here（定義位置）與 begins here（lambda 開始）；capture 建議收合
      const keep = notes.filter((x) => /declared here|begins here/.test(x.message));
      const declared = keep.find((x) => /declared here/.test(x.message));
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={row}>
            <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>{n} 在外面宣告</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{(declared && sourceLine(source, declared.line)) ?? "（原始碼）"}</div></div>
            <div style={redBox}><div style={{ fontSize: 13, color: red }}>lambda 的捕捉清單</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>[ ]　← 沒有 {n}</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ {n} 沒有被帶進 lambda</div></div>
          </div>
          <div style={{ fontSize: 13, color: "#57606A" }}>{keep.map((k) => `${k.message}（第 ${k.line} 行）`).join("；")}</div>
        </div>
      );
    }
    case "lambda-return": {
      const m = /return type '([^']+)' must match previous return type '([^']+)'/.exec(message);
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>先出現的回傳型別</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 8 }}>{m ? m[2] : "?"}</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red }}>後來的回傳型別</div><div style={{ ...mono, fontSize: 18, fontWeight: 700, marginTop: 8 }}>{m ? m[1] : "?"}</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 與前面的不一致</div></div>
        </div>
      );
    }
    case "goto-jump": {
      const skipped = notes.length ? sourceLine(source, notes[0].line) : null;
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>實際執行的路徑</div><div style={{ ...mono, fontSize: 15, marginTop: 8 }}>goto → 跳轉目標 → return</div></div>
          <div style={dashedRedBox}><div style={{ fontSize: 13 }}>被略過的宣告</div><div style={{ ...mono, fontSize: 15, marginTop: 6 }}>{skipped ?? "（略過的宣告）"}</div><div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>✕ 還沒被建立就被使用</div></div>
        </div>
      );
    }
    case "vla-file-scope": {
      const n = (/read of non-const variable '([^']+)'/.exec(notes.map((x) => x.message).join(" ")) || [])[1] ?? "?";
      return (
        <div style={row}>
          <div style={blueBox}><div style={{ fontSize: 13, color: blue }}>大小來自哪裡？</div><div style={{ ...mono, fontSize: 16, marginTop: 8 }}>{n}（執行時才有值）</div></div>
          <div style={redBox}><div style={{ fontSize: 13, color: red, fontWeight: 700 }}>需要的資訊</div><div style={{ fontSize: 14, marginTop: 8 }}>編譯時就知道的數字</div><div style={{ fontSize: 14, color: red, fontWeight: 700, marginTop: 6 }}>✕ 全域陣列在編譯時就要配置</div></div>
        </div>
      );
    }
    default:
      return null;
  }
}

export interface CompileDiagViewProps {
  diag: Diagnostic;
  family: Family;
  kind: string;
  source?: string;
}

/** 單一編譯錯誤的視覺化區塊。錯誤行程式碼在上，原始 clang 訊息與附註收合在底部。 */
export function CompileDiagView({ diag, family, kind, source }: CompileDiagViewProps) {
  const known = TITLE[kind] !== undefined;
  const famLabel = family === "other" ? "其他" : `家族 ${family}・${FAMILY_LABEL[String(family)]}`;
  const code = sourceLine(source, diag.line);
  return (
    <div data-testid="compile-diag-view" data-kind={kind} style={{ padding: "10px 12px", borderBottom: "1px solid #e0e0e0", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, color: "#57606A" }}>{famLabel}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{known ? TITLE[kind] : kind}</div>
      {code !== null && (
        <pre style={{ ...mono, fontSize: 13, margin: 0, padding: "8px 10px", background: "#1F2328", color: "#E6EDF3", borderRadius: 6, whiteSpace: "pre-wrap" }}>
          {code}
        </pre>
      )}
      <Visual kind={known ? kind : "other"} diag={diag} source={source} />
      <div style={{ fontSize: 13, color: "#1F2328" }}>
        <b>白話說明：</b>{explain(kind, diag.message)}
      </div>
      <details>
        <summary style={{ fontSize: 12, color: "#57606A", cursor: "pointer" }}>原始 clang 訊息（第 {diag.line} 行）</summary>
        <pre style={{ ...mono, fontSize: 12, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>
          {diag.message}
          {diag.notes.map((n) => `\n${n.severity}: ${n.message}`).join("")}
        </pre>
      </details>
    </div>
  );
}

/** 中文白話說明（與畫布的說明文字一致；名稱取自訊息）。 */
function explain(kind: string, message: string): string {
  const n = quotedName(message);
  switch (kind) {
    case "undeclared": return `編譯器從內往外找 ${n}，每一層都找不到，所以停下來報錯。`;
    case "out-of-scope": return `${n} 只活在 for 的括號裡，離開後就消失了。名字存在過，但這裡已經看不到。`;
    case "redefinition": return "同一個作用域內名字只能宣告一次。換名字，或把其中一個放進新的區塊 { }。";
    case "missing-include": return "這個名字來自標準函式庫，要先引入對應的標頭檔才看得到。";
    case "init-type": return "整數的盒子裝不下字串，兩邊型別不能直接放在一起。";
    case "ptr-value": return "指標的盒子裝的是「位址」，你放進去的是「值」。加上 & 才能取得位址。";
    case "return-type": return "函式答應回傳的型別，和 return 後面的值不一致。";
    case "narrowing": return "盒子太小，裝不下就不讓你裝；要明確轉換，或改用更大的型別。";
    case "missing-semicolon": return "每個敘述的結尾都要有分號，像句號一樣。";
    case "missing-paren": return "括號要成對。開了 ( 就要有 )。";
    case "syntax-chain": return "同一種錯誤出現多次：每一處都要各自補上，它們互不影響。";
    case "missing-typename": return "依賴模板參數的名稱，要加 typename 說明它是型別。";
    case "case-jump": return "switch 會直接跳到 case 標籤，中間的變數宣告不會執行。解法：用 { } 包住 case 的內容。";
    case "no-matching-call": return "函式的參數數量或型別和你給的不一樣。把實際參數與候選並排，不符的地方一眼就看得出來。";
    case "ambiguous-call": return "兩個候選各自在不同的參數上比較好，編譯器無法判斷哪一個更適合，所以不選。";
    case "no-member": return `${n} 不是這個類別的成員。可能是名字打錯，也可能是想用的是別的類別。`;
    case "no-matching-ctor": return "建構子要求的參數和你給的不一樣。";
    case "deduction-failed": return `編譯器要從呼叫的參數推算模板參數，但這次沒有任何參數能推出它。解法：明確指定，例如 ${n}<int>()。`;
    case "template-operator": return "標準函式庫的演算法需要元素能比較大小。給它的型別沒有定義對應的運算子，解法是為它加上 operator<。";
    case "auto-no-init": return "auto 是「看右邊的值決定型別」。沒有右邊的值，編譯器就不知道它是什麼型別。";
    case "binary-operator": return "這個型別是你自己定義的，編譯器不知道 < 要怎麼比較。為它定義 operator< 就能使用。";
    case "const-assign": return "const 的意思是「不能改」。要改值，就不要宣告成 const。";
    case "discards-qualifiers": return "這個物件是唯讀的（const），但它呼叫的方法可能修改物件。解法：把方法改成 const（若它真的不修改），或不要用 const 參數。";
    case "private-access": return "class 的欄位預設是私有的，只有類別自己的成員函式能碰。要讓外面讀取，請提供公開的 getter。";
    case "static-context": return "成員函式要靠某個物件才能呼叫；static 函式屬於整個類別，手上沒有任何物件，所以不知道該用哪一個。解法（二選一）：① 在 static 函式裡先建立物件再呼叫 ② 若被呼叫的函式不需要物件的資料，把它也改成 static。";
    case "incomplete-type": return "前向宣告只告訴編譯器「有這個名字」，沒有說明內容，所以無法建立這種型別的物件。要建立物件，必須先有完整的定義。";
    case "abstract-class": return "類別裡有還沒實作的純虛函式，所以它只是「介面」。要建立物件，請用一個實作了這些函式的衍生類別。";
    case "override-mismatch": return "override 是在告訴編譯器「我要覆寫基底的虛函式」。名字、參數與 const 要和基底完全一樣，否則編譯器會報錯。（另一種情況是基底的函式根本不是 virtual。）";
    case "lambda-capture": return `lambda 只能用它捕捉清單裡的變數。要用 ${n}，請寫成 [${n}]（傳值）或 [&${n}]（傳參考）。`;
    case "lambda-return": return "lambda 沒有寫回傳型別時，編譯器從第一個 return 推斷。之後的 return 必須和它一致。解法：統一所有 return 的型別，或在 lambda 後面明確寫出 -> 型別。";
    case "goto-jump": return "goto 會直接跳過中間的變數宣告，所以變數還不存在。解法：把被跳過的宣告移到跳轉目標之前，或用 { } 包住。";
    case "vla-file-scope": return "全域陣列在程式開始前就要決定大小，所以大小必須是編譯時就知道的常數。解法：改用 const 或 constexpr 的常數，或改用 std::vector。";
    default: return "這個錯誤還沒有專屬的畫面，下方是編譯器的原始訊息。";
  }
}
