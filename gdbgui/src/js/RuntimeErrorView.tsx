// 執行錯誤圖解（P2）的畫面：每一種錯誤一個畫面，結構照設計稿（docs/superpowers/designs/runtime-errors-p2/）：
// 狀態與標題 → 錯誤行（底線標出出錯的那一段）→ 1 發生了什麼（圖）→ 2 值從哪裡來（可以跳到那一步）→ 3 怎麼改
// → 和原生 Linux 比較 → 原始訊息（收合）。值全部來自 runtimeDiag.diagnose，這裡不算任何值。
// 樣式只在這個元件裡（.rtv 底下），第一次畫的時候插一個 <style>；顏色照設計系統（--danger #b42318 等）。
import React from "react";
import { RtDiag, RtOrigin, stripComment } from "./runtimeDiag";

export interface RuntimeErrorViewProps {
  diag: RtDiag;
  /** 播放器現在停在第幾步（null：不知道）。陣列越界「寫出去之後」的記憶體圖要等走過那一步才畫。 */
  stepNow: number | null;
  /** 點「跳到第 N 行」：跳到那個值被寫入的那一步 */
  onJump: (step: number) => void;
  /**
   * 程式現在的狀態（預設 paused）：paused 停在某一步，可以繼續或跳到別的步；ended 錯誤之後跑到結束了；
   * stopped 沒有跑完就回到編輯模式（例如停在錯誤那一步按了「編輯」）。後兩種不能再跳步。
   */
  status?: RtStatus;
}

export type RtStatus = "paused" | "ended" | "stopped";

const MONO = `"JetBrains Mono",Menlo,Monaco,Consolas,"Courier New",monospace`;
const CSS = `
.rtv{--rt-ink:#1e1b2e;--rt-soft:#5c5873;--rt-faint:#6c6885;--rt-line:#e5e2ef;--rt-struct:#c9c4dc;--rt-accent:#4a3aa0;
  --rt-accent-soft:#ece9f8;--rt-hl-soft:#fff5cc;--rt-hl-strong:#b38600;--rt-ok-soft:#e5f3ea;--rt-danger:#b42318;
  --rt-danger-soft:#fdecea;--rt-paper:#f4f3f9;
  font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",system-ui,sans-serif;color:var(--rt-ink);
  display:flex;flex-direction:column;gap:10px;padding:10px 12px 14px;font-size:13px;line-height:1.6;box-sizing:border-box;}
.rtv *{box-sizing:border-box;}
.rtv .rt-mono,.rtv code,.rtv pre{font-family:${MONO};font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;}
.rtv .rt-nobr{white-space:nowrap;}
.rtv .rt-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--rt-soft);}
.rtv .rt-chip{font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;}
.rtv .rt-chip-stop{color:var(--rt-danger);background:var(--rt-danger-soft);}
.rtv .rt-chip-pause{color:#7a5c00;background:var(--rt-hl-soft);box-shadow:inset 0 0 0 1px var(--rt-hl-strong);}
.rtv .rt-chip-done{color:var(--rt-soft);box-shadow:inset 0 0 0 1px var(--rt-struct);}
.rtv .rt-title{margin:0;font-size:15px;font-weight:700;line-height:1.35;}
.rtv .rt-en{font-weight:500;color:var(--rt-soft);font-size:13px;margin-left:6px;}
.rtv .rt-code{margin:0;padding:8px 10px;background:#1F2328;color:#E6EDF3;border-radius:6px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;}
.rtv .rt-ln{color:#8b949e;user-select:none;margin-right:10px;}
.rtv .rt-bad{color:#ffb4a9;text-decoration:underline wavy #ff7b6b;text-underline-offset:3px;}
.rtv .rt-sec{border-top:1px solid var(--rt-line);padding-top:9px;display:flex;flex-direction:column;gap:7px;}
.rtv .rt-sec-head{font-size:12px;font-weight:700;color:var(--rt-soft);letter-spacing:.02em;}
.rtv .rt-sec-num{color:var(--rt-accent);margin-right:4px;}
.rtv .rt-p{margin:0;}
.rtv .rt-p code,.rtv .rt-origin-d code,.rtv .rt-cap code{font-size:12px;font-weight:700;background:var(--rt-accent-soft);padding:0 3px;border-radius:3px;}
.rtv .rt-cap{font-size:12px;color:var(--rt-soft);line-height:1.5;margin:0;}
.rtv .rt-red{color:var(--rt-danger);font-weight:700;}
.rtv .rt-origins{display:flex;flex-direction:column;gap:7px;}
.rtv .rt-origin{display:flex;flex-direction:column;gap:1px;}
.rtv .rt-origin-v{font-family:${MONO};font-weight:700;font-size:13px;}
.rtv .rt-origin-d{font-size:12.5px;color:var(--rt-soft);line-height:1.5;}
.rtv .rt-jump{font:inherit;font-size:12.5px;color:var(--rt-accent);font-weight:700;text-decoration:underline;text-underline-offset:3px;cursor:pointer;background:none;border:0;padding:0;margin-left:6px;white-space:nowrap;}
.rtv .rt-fix{margin:0;padding:7px 10px;background:var(--rt-ok-soft);border:1px solid #b9dcc6;border-radius:6px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;color:#173b27;font-family:${MONO};}
.rtv .rt-add{background:#c9ebd5;border-radius:3px;}
.rtv .rt-native{font-size:12.5px;line-height:1.55;color:var(--rt-soft);}
.rtv .rt-native b{color:var(--rt-ink);}
.rtv .rt-raw{font-size:12px;color:var(--rt-soft);}
.rtv .rt-raw summary{cursor:pointer;}
.rtv .rt-raw pre{margin:6px 0 0;white-space:pre-wrap;font-size:12px;color:var(--rt-ink);}
.rtv .rt-eq{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;}
.rtv .rt-opnd{display:flex;flex-direction:column;align-items:center;gap:2px;}
.rtv .rt-opsym{font-size:18px;font-weight:700;line-height:34px;color:var(--rt-soft);}
.rtv .rt-cellrow{display:flex;align-items:flex-start;gap:4px;flex-wrap:wrap;}
.rtv .rt-cells{display:flex;gap:4px;padding:6px;border:1px solid var(--rt-line);border-radius:10px;background:var(--rt-paper);flex-wrap:wrap;}
.rtv .rt-cellbox{display:flex;flex-direction:column;align-items:center;gap:2px;}
.rtv .rt-cell,.rtv .rt-outcell,.rtv .rt-cellgap{min-width:30px;height:34px;padding:0 5px;display:flex;align-items:center;justify-content:center;border:1px solid var(--rt-struct);border-radius:6px;background:#fff;font-family:${MONO};font-size:13px;}
.rtv .rt-cellgap{border:0;background:none;color:var(--rt-soft);}
.rtv .rt-cell-hit{border:1px solid var(--rt-danger);box-shadow:0 0 0 1px var(--rt-danger);background:var(--rt-danger-soft);color:var(--rt-danger);font-weight:700;}
.rtv .rt-outcell{border:2px dashed var(--rt-danger);background:var(--rt-danger-soft);color:var(--rt-danger);font-weight:700;margin-top:6px;}
.rtv .rt-idx{font-family:${MONO};font-size:11px;color:var(--rt-faint);min-height:15px;}
.rtv .rt-size-edge{align-self:stretch;border-left:2px solid var(--rt-accent);padding:4px 0 0 4px;font-size:11px;color:var(--rt-accent);font-weight:700;white-space:nowrap;}
.rtv .rt-farcell{align-self:center;color:var(--rt-soft);padding:0 2px;}
.rtv .rt-after{border:1px dashed var(--rt-struct);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:7px;background:#fbfaff;}
.rtv .rt-after-tag{font-size:11.5px;font-weight:700;color:var(--rt-accent);}
.rtv .rt-mem{display:flex;gap:0;flex-wrap:wrap;}
.rtv .rt-memcell{border:1px solid var(--rt-struct);padding:4px 8px;font-family:${MONO};font-size:12px;background:#fff;}
.rtv .rt-memcell + .rt-memcell{border-left:0;}
.rtv .rt-memhit{border-color:var(--rt-danger);background:var(--rt-danger-soft);color:var(--rt-danger);}
.rtv .rt-numline{display:flex;flex-direction:column;gap:6px;}
.rtv .rt-nl-svg{display:block;overflow:visible;}
.rtv .rt-nl-legend{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--rt-soft);}
.rtv .rt-nl-key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px;}
.rtv .rt-nl-dot{border-radius:50%;}
.rtv .rt-bitsbox{display:flex;flex-direction:column;gap:4px;}
.rtv .rt-bits{display:flex;gap:1px;width:100%;}
.rtv .rt-bit,.rtv .rt-bitpad{flex:1 1 0;min-width:0;max-width:12px;height:17px;font-family:${MONO};font-size:9.5px;line-height:15px;text-align:center;}
.rtv .rt-bit{border:1px solid var(--rt-struct);border-radius:2px;background:#fff;}
.rtv .rt-bit-cut{border:1px dashed var(--rt-danger);color:var(--rt-danger);background:var(--rt-danger-soft);text-decoration:line-through;}
.rtv .rt-bit-sign{background:var(--rt-hl-soft);border-color:var(--rt-hl-strong);font-weight:700;}
.rtv .rt-bit-neg{background:var(--rt-danger-soft);border-color:var(--rt-danger);color:var(--rt-danger);}
.rtv .rt-emptybox{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.rtv .rt-cells-empty{min-width:120px;height:46px;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;}
.rtv .rt-objs{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;}
.rtv .rt-obj{border:1px solid var(--rt-struct);border-radius:8px;background:#fff;min-width:110px;overflow:hidden;}
.rtv .rt-obj-head{padding:3px 8px;background:var(--rt-paper);border-bottom:1px solid var(--rt-line);font-size:12px;font-weight:700;}
.rtv .rt-obj-row{display:flex;justify-content:space-between;gap:10px;padding:2px 8px;font-size:12px;font-family:${MONO};}
.rtv .rt-obj-row + .rt-obj-row{border-top:1px solid var(--rt-line);}
.rtv .rt-obj-null{background:var(--rt-danger-soft);color:var(--rt-danger);font-weight:700;}
.rtv .rt-path{display:flex;flex-direction:column;border:1px solid var(--rt-line);border-radius:8px;overflow:hidden;font-size:12px;}
.rtv .rt-path-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:3px 8px;font-family:${MONO};white-space:pre;}
.rtv .rt-path-row + .rt-path-row{border-top:1px solid var(--rt-line);}
.rtv .rt-path-row .rt-ln{color:var(--rt-faint);margin-right:0;}
.rtv .rt-path-last{background:var(--rt-danger-soft);}
.rtv .rt-path-note{font-family:"Noto Sans TC",system-ui,sans-serif;color:var(--rt-danger);font-weight:700;white-space:normal;}
.rtv .rt-skip{color:var(--rt-faint);}
.rtv .rt-tower{display:flex;flex-direction:column;gap:3px;}
.rtv .rt-frame{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 8px;border:1px solid var(--rt-struct);border-radius:6px;background:#fff;padding:3px 8px;font-size:12px;}
.rtv .rt-frame-red{border-color:var(--rt-danger);background:var(--rt-danger-soft);}
.rtv .rt-frame-zero{border-color:var(--rt-hl-strong);background:var(--rt-hl-soft);}
.rtv .rt-frame-depth{color:var(--rt-faint);font-size:11px;}
.rtv .rt-frame-note{width:100%;color:var(--rt-danger);font-weight:700;font-size:11.5px;}
.rtv .rt-frame-zero .rt-frame-note{color:#7a5c00;}
.rtv .rt-gap{text-align:center;color:var(--rt-soft);font-size:12px;padding:2px 0;}
`;

function ensureCss() {
  if (typeof document === "undefined" || document.getElementById("rt-view-css")) return;
  const el = document.createElement("style");
  el.id = "rt-view-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * 程式碼只在空白處換行。瀏覽器預設會在「-」後面斷行，cur->next->val 會被拆開；
 * 所以每一段不含空白的字包成不斷行（太長的字不包，免得撐破面板）。
 */
function nb(s: string): React.ReactNode {
  const t = String(s == null ? "" : s);
  if (!/\S/.test(t)) return t;
  return t
    .split(/(\s+)/)
    .map((part, i) => (i % 2 === 1 || !part || part.length > 40 ? part : <span key={i} className="rt-nobr">{part}</span>));
}

/** 反引號包住的部分畫成程式碼。 */
function rich(text: string): React.ReactNode[] {
  return String(text || "")
    .split("`")
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{nb(part)}</code> : <span key={i}>{part}</span>));
}

/** 負號改用 −（設計稿的寫法，數字比較好讀）。 */
const minus = (s: string) => String(s).replace(/(^|[=( ])-(?=\d)/g, "$1−");

function cellText(v: any, isString?: boolean): string {
  if (v === undefined) return "?";
  if (isString) return `'${v}'`;
  if (v === null) return "null";
  if (typeof v === "object") return "{…}";
  if (v === "<ptr>") return "ptr";
  return String(v);
}

function Section(props: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rt-sec">
      <div className="rt-sec-head" data-testid="rt-sec-head">
        <span className="rt-sec-num">{props.n}</span>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

function CodeLine({ d }: { d: RtDiag }) {
  // 行尾的註解（教案的 //@ 註記、// 說明）不是學生要看的程式，這裡不顯示；編輯器裡照樣看得到
  const code = stripComment(d.code);
  const lead = code.length - code.replace(/^\s+/, "").length;
  let body: React.ReactNode = nb(code.slice(lead) || " ");
  if (d.bad && d.bad[0] >= lead && d.bad[1] > d.bad[0] && d.bad[1] <= code.length) {
    // 出錯的那一段連同它所在的整個字（例如 cur->next->val）放在同一行，不從中間斷開
    let p0 = d.bad[0];
    while (p0 > lead && !/\s/.test(code[p0 - 1])) p0--;
    let p1 = d.bad[1];
    while (p1 < code.length && !/\s/.test(code[p1])) p1++;
    const bad = (
      <span className="rt-bad" data-testid="rt-bad">
        {code.slice(d.bad[0], d.bad[1])}
      </span>
    );
    body = (
      <>
        {nb(code.slice(lead, p0))}
        {p1 - p0 <= 40 ? (
          <span className="rt-nobr">
            {code.slice(p0, d.bad[0])}
            {bad}
            {code.slice(d.bad[1], p1)}
          </span>
        ) : (
          <>
            {code.slice(p0, d.bad[0])}
            {bad}
            {code.slice(d.bad[1], p1)}
          </>
        )}
        {nb(code.slice(p1))}
      </>
    );
  }
  return (
    <div className="rt-code rt-mono" data-testid="rt-code">
      <span className="rt-ln">{d.line}</span>
      {body}
    </div>
  );
}

function What({ d }: { d: RtDiag }) {
  return (
    <>
      {d.what.map((t, i) => (
        <p key={i} className="rt-p">
          {rich(t)}
        </p>
      ))}
    </>
  );
}

// ── 每一種錯誤的圖 ──────────────────────────────────────────

function Operand(props: { label: string; value: string; hit?: boolean; unknown?: boolean }) {
  // 設計稿：名稱寫在格子下面；除數（出事的那一格）和「算不出來」用紅字
  const ascii = /^[\x20-\x7e]+$/.test(props.label);
  return (
    <div className="rt-opnd">
      <div className={props.unknown ? "rt-outcell" : "rt-cell" + (props.hit ? " rt-cell-hit" : "")} style={props.unknown ? { marginTop: 0 } : undefined}>
        {props.value}
      </div>
      <div className={"rt-cap" + (ascii ? " rt-mono" : "") + (props.hit || props.unknown ? " rt-red" : "")}>{props.label}</div>
    </div>
  );
}

function DivPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <div className="rt-eq">
      <Operand label={p.lhsText || "被除數"} value={String(p.lhs)} />
      <div className="rt-opsym">{p.op === "%" ? "%" : "÷"}</div>
      <Operand label={p.rhsText || "除數"} value={String(p.rhs)} hit />
      <div className="rt-opsym">=</div>
      <Operand label="算不出來" value="？" unknown />
    </div>
  );
}

function NumLine({ p }: { p: any }) {
  const ex = Number(p.exact);
  const st = Number(p.stored);
  const mn = Number(p.min);
  const mx = Number(p.max);
  const hasStored = p.stored !== "?" && isFinite(st);
  // 型別的範圍照比例畫；正確答案畫在範圍外面一點（真正的距離放不進面板），虛線弧從它繞回存進去的值
  const above = ex > mx;
  const W = 330;
  const y = 46;
  const r0 = above ? 12 : 92;
  const r1 = above ? 238 : 318;
  const xE = above ? 314 : 16;
  const xS = hasStored ? r0 + ((st - mn) / (mx - mn || 1)) * (r1 - r0) : null;
  const amount = String(p.wrapAmount || "");
  const wrapText = amount ? (amount[0] === "-" ? `繞回：加上 ${amount.slice(1)}` : `繞回：減掉 ${amount}`) : "";
  const mid = xS !== null ? Math.min(W - 72, Math.max(72, (xE + xS) / 2)) : 0;
  return (
    <div className="rt-numline" data-testid="rt-numline">
      <svg className="rt-nl-svg" viewBox={`0 0 ${W} 58`} width="100%" role="img"
        aria-label={`${p.type} 的範圍 ${p.min} 到 ${p.max}；正確答案 ${p.exact}${hasStored ? `；存進去的 ${p.stored}` : ""}`}>
        <line x1={4} y1={y} x2={W - 4} y2={y} stroke="#c9c4dc" strokeWidth={1} />
        <rect x={r0} y={y - 5} width={r1 - r0} height={10} rx={5} fill="#ece9f8" stroke="#4a3aa0" strokeWidth={1} />
        {xS !== null && wrapText ? (
          <>
            <path d={`M ${xE} ${y - 7} C ${xE} ${y - 36}, ${xS} ${y - 36}, ${xS} ${y - 13}`} fill="none" stroke="#b42318" strokeWidth={1.5} strokeDasharray="4 3" />
            <polygon points={`${xS - 4},${y - 15} ${xS + 4},${y - 15} ${xS},${y - 8}`} fill="#b42318" />
            <text x={mid} y={10} textAnchor="middle" fontSize={11} fontWeight={700} fill="#b42318">
              {wrapText}
            </text>
          </>
        ) : null}
        <circle cx={xE} cy={y} r={5} fill="#b42318" />
        {xS !== null ? <circle cx={xS} cy={y} r={5} fill="#4a3aa0" /> : null}
      </svg>
      <div className="rt-nl-legend">
        <span>
          <i className="rt-nl-key" style={{ background: "var(--rt-accent-soft)", border: "1px solid var(--rt-accent)" }} />
          {p.type} 放得下的範圍：{minus(p.min)} ～ {p.max}
        </span>
        <span className="rt-red">
          <i className="rt-nl-key rt-nl-dot" style={{ background: "var(--rt-danger)" }} />
          正確答案 {minus(p.exact)}（超出 {p.type} 範圍）
        </span>
        {hasStored ? (
          <span>
            <i className="rt-nl-key rt-nl-dot" style={{ background: "var(--rt-accent)" }} />
            存進去的 {minus(p.stored)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function bitsExplain(p: any): string {
  const cut = p.exactBits.length - p.width;
  const neg = p.storedBits[0] === "1";
  const sign = `剩下 ${p.width} 格的第一格是正負號，這裡是 ${neg ? "1，所以存進去的 " + minus(p.stored) + " 變成負數。" : "0，所以結果還是正數，只是錯了。"}`;
  if (cut <= 0) return `正確答案剛好用滿 ${p.width} 格，可是 ${p.type} 的第一格是正負號：這裡是 1，所以存進去的 ${minus(p.stored)} 變成負數。`;
  const what = cut === 1 ? "那一位" : "切掉的部分";
  const head = `最左邊${cut === 1 ? "那一位" : `的 ${cut} 位`}放不進 ${p.width} 格，被切掉了（紅色虛線）。`;
  if (neg) return head + sign;
  return head + `${what}代表 ${p.wrapAmount}，所以存進去的是 ${p.exact} − ${p.wrapAmount} = ${p.stored}。` + sign;
}

function OverflowPic({ d, status }: { d: RtDiag; status: RtStatus }) {
  const p = d.pic;
  const cut = p.exactBits ? Math.max(0, p.exactBits.length - p.width) : 0;
  return (
    <>
      <NumLine p={p} />
      {p.exactBits && p.storedBits ? (
        <div className="rt-bitsbox">
          <div className="rt-cap">
            正確答案 {p.exact}：要 {p.exactBits.length} 個位元（bit）
          </div>
          <div className="rt-bits" data-testid="rt-bits-exact">
            {String(p.exactBits)
              .split("")
              .map((b: string, i: number) => (
                <span key={i} className={"rt-bit" + (i < cut ? " rt-bit-cut" : "")}>
                  {b}
                </span>
              ))}
          </div>
          <div className="rt-cap">
            {p.type} 只有 {p.width} 格，存進{p.assignTo ? ` ${p.assignTo} ` : "去"}的是 {minus(p.stored)}
          </div>
          <div className="rt-bits" data-testid="rt-bits-stored">
            {Array.from({ length: cut }).map((_, i) => (
              <span key={"pad" + i} className="rt-bitpad" />
            ))}
            {String(p.storedBits)
              .split("")
              .map((b: string, i: number) => (
                <span key={i} className={"rt-bit" + (i === 0 ? " rt-bit-sign" + (b === "1" ? " rt-bit-neg" : "") : "")}>
                  {b}
                </span>
              ))}
          </div>
          <p className="rt-cap">{bitsExplain(p)}</p>
        </div>
      ) : null}
      {p.assignTo && !d.fatal ? (
        <p className="rt-p">
          {status === "paused" ? "按「繼續」之後，" : "這一行執行完，"}
          <code>{nb(p.assignTo)}</code>
          {status === "paused" ? " 就是 " : " 存進去的值是 "}
          {minus(p.stored)}。
        </p>
      ) : null}
    </>
  );
}

function CellRow(props: { cells: any[] | null; size: number; index: number | undefined; indexText: string; isString?: boolean; sizeEdge?: string }) {
  const n = isFinite(props.size) ? props.size : props.cells ? props.cells.length : 0;
  const shown: (number | null)[] = [];
  if (n <= 12) for (let i = 0; i < n; i++) shown.push(i);
  else shown.push(0, 1, 2, null, n - 3, n - 2, n - 1);
  const index = props.index;
  const outLeft = index !== undefined && index < 0;
  const out =
    index === undefined ? null : (
      <div className="rt-cellbox">
        <div className="rt-outcell" data-testid="rt-out-cell">
          ？
        </div>
        <div className="rt-idx rt-red">{index}</div>
      </div>
    );
  return (
    <>
      <div className="rt-cellrow">
        {outLeft ? out : null}
        {outLeft && (index as number) < -1 ? <div className="rt-farcell">⋯</div> : null}
        <div className="rt-cells" data-testid="rt-cells">
          {shown.map((i, k) =>
            i === null ? (
              <div key={k} className="rt-cellbox">
                <div className="rt-cellgap">⋯</div>
                <div className="rt-idx" />
              </div>
            ) : (
              <div key={k} className="rt-cellbox">
                <div className="rt-cell">{cellText(props.cells ? props.cells[i] : undefined, props.isString)}</div>
                <div className="rt-idx">{i}</div>
              </div>
            )
          )}
        </div>
        {props.sizeEdge ? (
          <div className="rt-size-edge" data-testid="rt-size-edge">
            {props.sizeEdge}
          </div>
        ) : null}
        {!outLeft && index !== undefined && index > n ? <div className="rt-farcell">⋯</div> : null}
        {!outLeft ? out : null}
      </div>
      {index !== undefined ? (
        <div className="rt-cap">
          <span className="rt-red">↑ {/^[A-Za-z_]\w*$/.test(props.indexText) ? `${props.indexText} = ${index}` : `索引 ${index}`}</span>：在框外
        </div>
      ) : null}
    </>
  );
}

function afterText(p: any): string {
  const a = p.after;
  const o = a.overwritten[0];
  if (!o) return "這次寫出去的位置沒有碰到其他看得見的變數，但那塊記憶體可能是別的東西在用。";
  const change = `原本的 ${cellText(o.from)} 被蓋成 ${cellText(o.to)}`;
  if (o.sibling) return `struct 的成員照宣告的順序排在記憶體裡，${a.target} 落在 ${o.path} 上：${o.path} ${change}。`;
  if (o.sameArray) return `二維陣列的每一列在記憶體裡緊接著排，${a.target} 就是 ${o.path}：${change}。`;
  return `${a.target} 落在 ${o.path} 上：${change}。`;
}

function ArrayPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <>
      <div className="rt-cap rt-mono">
        {p.arrayText}（{p.typeText}）
      </div>
      <CellRow cells={p.cells} size={p.size} index={p.index} indexText={p.indexText} />
    </>
  );
}

/** 陣列越界的第二張圖（記憶體排列，示意）：走過寫出去的那一步才畫，之前只預告；放在說明文字之後（設計稿）。 */
function ArrayAfter({ d, stepNow, status }: { d: RtDiag; stepNow: number | null; status: RtStatus }) {
  const p = d.pic;
  if (!p || !p.after) return null;
  // 程式跑完了：越界的那一次寫入一定發生過
  const afterOn = status === "ended" || (stepNow !== null && stepNow >= p.after.step);
  if (!afterOn)
    return (
      <p className="rt-cap">
        {status === "stopped" ? "重新執行、停在這一行時按「繼續」，" : "按「繼續」之後，"}這裡會多一張圖：記憶體排列（示意）。
      </p>
    );
  return (
    <div className="rt-after" data-testid="rt-after">
      <div className="rt-after-tag">記憶體排列（示意）</div>
      <div className="rt-mem">
        <div className="rt-memcell">
          {p.arrayText}[0]～[{p.size - 1}]
        </div>
        {p.after.overwritten.length ? (
          p.after.overwritten.map((o: any, i: number) => (
            <div key={i} className="rt-memcell rt-memhit">
              <div>{o.path}</div>
              <div>
                {cellText(o.from)} → <b>{cellText(o.to)}</b>
              </div>
            </div>
          ))
        ) : (
          <div className="rt-memcell rt-memhit">{p.after.target}</div>
        )}
      </div>
      <p className="rt-cap">{afterText(p)}</p>
    </div>
  );
}

function ContainerPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <>
      <div className="rt-cap rt-mono">
        {p.name}（{p.typeText}
        {p.capacity !== null && p.capacity !== undefined ? `，capacity = ${p.capacity}` : ""}）
      </div>
      <CellRow cells={p.cells} size={p.size} index={p.index} indexText={p.indexText} isString={p.isString} sizeEdge={`size = ${p.size}`} />
    </>
  );
}

function EmptyPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <div className="rt-emptybox">
      <div className="rt-cells rt-cells-empty">
        <span className="rt-mono" style={{ fontWeight: 700 }}>
          {p.name}
        </span>
        <span className="rt-cap">size = 0</span>
      </div>
      <div className="rt-red rt-mono">
        {nb(p.call)} ✕ 沒有東西可以{/^pop/.test(p.method) ? "拿走" : "拿"}
      </div>
    </div>
  );
}

function NullPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <>
      <div className="rt-objs">
        {p.objects.map((o: any) => (
          <div key={"o" + o.name} className="rt-obj" data-testid="rt-obj">
            <div className="rt-obj-head rt-mono">
              {o.name} : {o.type}
            </div>
            {o.fields.map((f: any) => (
              <div key={f.name} className={"rt-obj-row" + (f.isNull ? " rt-obj-null" : "")} data-null={f.isNull ? "1" : undefined}>
                <span>{f.name}</span>
                <span>{f.value}</span>
              </div>
            ))}
          </div>
        ))}
        {p.pointers.map((ptr: any) => (
          <div key={"p" + ptr.name} className="rt-obj" data-testid="rt-obj" data-null={ptr.isNull ? "1" : undefined}>
            <div className="rt-obj-head rt-mono">
              {ptr.name} : {ptr.type}
            </div>
            <div className={"rt-obj-row" + (ptr.isNull ? " rt-obj-null" : "")}>
              <span>{ptr.isNull ? "nullptr" : "不是 nullptr"}</span>
            </div>
          </div>
        ))}
      </div>
      {p.baseText ? (
        <div className="rt-red">
          <code>{nb(p.baseText)}</code> 是 nullptr ✕ 沒有東西可以{p.tck === 1 ? "寫" : "讀"}
        </div>
      ) : null}
      <p className="rt-cap">圖上不畫箭頭：目前只知道指標是不是 nullptr，不知道它指向哪一個物件。</p>
    </>
  );
}

function PathPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <div className="rt-path">
      {p.sig ? (
        <div className="rt-path-row">
          <span className="rt-ln">{p.sig.line}</span>
          <span>{p.sig.code}</span>
        </div>
      ) : null}
      {p.path.map((r: any, i: number) => (
        <div key={i} className={"rt-path-row" + (r.last ? " rt-path-last" : "")}>
          <span className="rt-ln">{r.line}</span>
          <span>
            {r.skip ? (
              <>
                {r.code.slice(0, r.skip[0])}
                <s className="rt-skip">{r.code.slice(r.skip[0], r.skip[1])}</s>
                {r.code.slice(r.skip[1])}
              </>
            ) : (
              r.code
            )}
          </span>
          {r.note ? <span className="rt-path-note">{r.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

function Frame({ f }: { f: any }) {
  return (
    <div className={"rt-frame" + (f.red ? " rt-frame-red" : "") + (f.zero ? " rt-frame-zero" : "")} data-testid="rt-frame">
      <span className="rt-mono">{minus(f.label)}</span>
      <span className="rt-frame-depth">第 {f.depth} 層</span>
      {f.note ? <div className="rt-frame-note">{f.note}</div> : null}
    </div>
  );
}

function TowerPic({ d }: { d: RtDiag }) {
  const p = d.pic;
  return (
    <div className="rt-tower">
      {p.top.map((f: any) => (
        <Frame key={"t" + f.depth} f={f} />
      ))}
      {p.gap > 0 ? (
        <div className="rt-gap" data-testid="rt-gap">
          ⋮　中間 {p.gap} 層{p.perLevel ? `，${p.perLevel}` : ""}
        </div>
      ) : null}
      {p.bottom.map((f: any) => (
        <Frame key={"b" + f.depth} f={f} />
      ))}
    </div>
  );
}

function Picture({ d, stepNow, status }: { d: RtDiag; stepNow: number | null; status: RtStatus }) {
  const p = d.pic || {};
  switch (d.kind) {
    case "div-by-zero":
      return <DivPic d={d} />;
    case "signed-overflow":
      return <OverflowPic d={d} status={status} />;
    case "array-bounds":
      return <ArrayPic d={d} />;
    case "container-index":
      return p.cells ? <ContainerPic d={d} /> : null;
    case "empty-container":
      return p.name ? <EmptyPic d={d} /> : null;
    case "null-deref":
      return p.objects ? <NullPic d={d} /> : null;
    case "missing-return":
      return p.path ? <PathPic d={d} /> : null;
    case "stack-overflow":
      return p.top ? <TowerPic d={d} /> : null;
    default:
      return null;
  }
}

function Origins({ d, onJump, status }: { d: RtDiag; onJump: (step: number) => void; status: RtStatus }) {
  // 程式已經結束或停止（回到編輯模式）就沒有可以跳的步；按鈕按了也沒反應，所以不畫，改成一行說明
  const canJump = status === "paused";
  const jumpable = d.origins.some((o: RtOrigin) => o.step !== d.step);
  return (
    <div className="rt-origins">
      {d.origins.map((o: RtOrigin, i: number) => (
        <div key={i} className="rt-origin">
          <div className={"rt-origin-v" + (o.red ? " rt-red" : "")}>{nb(o.label)}</div>
          <div className="rt-origin-d">
            ← {rich(o.desc)}
            {canJump && o.step !== d.step ? (
              <button type="button" className="rt-jump" data-testid="rt-jump" onClick={() => onJump(o.step)}>
                跳到第 {o.line} 行
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {d.originNote ? <p className="rt-cap">{d.originNote}</p> : null}
      {!canJump && jumpable ? (
        <p className="rt-cap" data-testid="rt-nojump">
          程式已經{status === "ended" ? "結束" : "停止"}，重新執行之後才能跳到這幾步。
        </p>
      ) : null}
    </div>
  );
}

const CHIP: { [k in RtStatus]: [string, string] } = {
  paused: ["已暫停，可以按「繼續」", "rt-chip-pause"],
  ended: ["程式已經結束", "rt-chip-done"],
  stopped: ["程式已經停止", "rt-chip-done"],
};

export function RuntimeErrorView(props: RuntimeErrorViewProps) {
  ensureCss();
  const d = props.diag;
  const known = d.kind !== "other";
  const status: RtStatus = props.status || "paused";
  const [chipText, chipCls] = d.fatal ? ["程式在這裡結束", "rt-chip-stop"] : CHIP[status];
  return (
    <div className="rtv" data-testid="rt-view" data-kind={d.kind}>
      <div className="rt-meta">
        <span>{d.family}</span>
        <span className={"rt-chip " + chipCls} data-testid="rt-chip">
          {chipText}
        </span>
      </div>
      <h3 className="rt-title" data-testid="rt-title">
        {d.title}
        {d.en ? <span className="rt-en">{d.en}</span> : null}
      </h3>
      <CodeLine d={d} />
      {known ? (
        <>
          <Section n={1} title="發生了什麼">
            {/* 順序照設計稿：溢位先講正確答案為什麼放不下，再畫數線；其他先畫圖再說明 */}
            {d.kind === "signed-overflow" ? <What d={d} /> : null}
            <Picture d={d} stepNow={props.stepNow} status={status} />
            {d.kind === "signed-overflow" ? null : <What d={d} />}
            {d.kind === "array-bounds" ? <ArrayAfter d={d} stepNow={props.stepNow} status={status} /> : null}
          </Section>
          <Section n={2} title="值從哪裡來">
            <Origins d={d} onJump={props.onJump} status={status} />
          </Section>
          <Section n={3} title="怎麼改">
            {d.fix ? (
              <>
                <p className="rt-p">{rich(d.fix.text)}</p>
                {d.fix.code.length ? (
                  <div className="rt-fix">
                    {d.fix.code.map((l, i) => (
                      <div key={i} className={l.add ? "rt-add" : undefined}>
                        {l.text ? nb(l.text) : " "}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </Section>
        </>
      ) : (
        <What d={d} />
      )}
      {d.native ? (
        <div className="rt-native">
          <b>和原生 Linux 比較：</b>
          {d.native}
        </div>
      ) : null}
      <details className="rt-raw" data-testid="rt-raw">
        <summary>原始錯誤訊息（{d.rawWhere}）</summary>
        <pre>{d.raw}</pre>
        {d.rawNote ? <p className="rt-cap">{d.rawNote}</p> : null}
      </details>
    </div>
  );
}

export default RuntimeErrorView;
