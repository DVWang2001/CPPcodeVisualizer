import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";

type TrackedVar = { scope: string; varName: string; fullExpr: string; address: string; value: string };
type Frame = { scope: string; vars: TrackedVar[] };

// ponytail: horizontal layout — frames side-by-side, vars stacked vertically inside each
const R = 20;
const FRAME_W = 86;
const ROW_H = 68;
const HEADER_H = 24;
const PAD = 6;
const GAP_X = 56;
const SCOPE_COLORS = ["#4F46E5", "#3AA76D", "#DC5B5B", "#E67E22", "#9B59B6"];
const REF_COLORS = ["#3AA76D", "#E67E22", "#9B59B6", "#E74C3C"];

class MemoryWatch extends React.Component<any, { trackedVars: TrackedVar[] }> {
  intervalId: any;
  constructor(props: any) { super(props); this.state = { trackedVars: [] }; }
  componentDidMount() { this.intervalId = setInterval(() => this.updateTrackedVars(), 500); }
  componentWillUnmount() { clearInterval(this.intervalId); }

  updateTrackedVars() {
    if (!global_variable.__active_visualizer_exprs) return;
    const expressions = store.get("expressions") || [];
    const tracked: TrackedVar[] = [];

    const baseExprs = Array.from(global_variable.__active_visualizer_exprs).filter(
      (e: any) => !e.startsWith("&(") && !e.startsWith('"') && !e.endsWith('"')
    );

    for (const expr of baseExprs) {
      // ponytail: accept undefined in_scope (newly created varobjs don't have it yet)
      const v = expressions.find((o: any) => o.expression === expr && o.in_scope !== "false" && o.in_scope !== "invalid");
      const a = expressions.find((o: any) => o.expression === `&(${expr})` && o.in_scope !== "false" && o.in_scope !== "invalid");
      if (!v) continue;
      let addr = a ? a.value || "" : "";
      if (!addr) {
        const s = String(v.expression).trim();
        if (/^-?\d+(\.\d+)?$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s) || /^'.'$/.test(s) || s === "true" || s === "false")
          addr = "const";
      }
      const { scope, varName } = this.parseScope(String(v.expression));
      tracked.push({ scope, varName, fullExpr: v.expression, address: addr, value: v.value || "{...}" });
    }

    if (global_variable.__static_strings) {
      for (const ss of global_variable.__static_strings) {
        const a = expressions.find((o: any) => o.expression === `"(void*)(\\"${ss}\\")"` && o.in_scope !== "false");
        let addr = a ? a.value || "" : ".rodata";
        if (!addr || addr.includes("Calculating")) addr = ".rodata";
        else if (addr.includes(" ")) addr = addr.split(" ")[0];
        tracked.push({ scope: ".rodata", varName: `"${ss}"`, fullExpr: `"${ss}"`, address: addr, value: `"${ss}"` });
      }
    }

    // Deduplicate: only merge when one is unscoped (floating varobj duplicate).
    // Both scoped = cross-scope reference, keep both.
    const seen = new Map<string, number>();
    const deduped: TrackedVar[] = [];
    for (const v of tracked) {
      const n = this.norm(v.address);
      if (n && seen.has(n)) {
        const idx = seen.get(n)!;
        const ex = deduped[idx];
        if (!ex.scope && v.scope) { deduped[idx] = v; }
        else if (ex.scope && !v.scope) { /* keep existing scoped */ }
        else { seen.set(n, deduped.length); deduped.push(v); }
      } else {
        if (n) seen.set(n, deduped.length);
        deduped.push(v);
      }
    }

    this.setState({ trackedVars: deduped });
  }

  private parseScope(e: string) {
    const i = e.lastIndexOf("::"); return i > 0 ? { scope: e.slice(0, i), varName: e.slice(i + 2) } : { scope: "", varName: e };
  }
  private norm(raw: string): string | null {
    const m = raw.match(/0x([0-9a-fA-F]+)/); return m ? "0x" + parseInt(m[1], 16).toString(16) : null;
  }
  private truncVal(v: string) { return v.length <= 5 ? v : v.slice(0, 4) + "…"; }
  private shortAddr(a: string) {
    if (!a) return "";
    const m = a.match(/[0-9a-fA-F]{4,}$/);
    return m ? ".." + m[0].slice(-4) : a;
  }

  render() {
    const { trackedVars } = this.state;
    if (trackedVars.length === 0)
      return <div style={{ fontStyle: "italic", color: "var(--ink-soft, #6b7280)", textAlign: "center", padding: "16px" }}>尚無觀測變數</div>;

    // Group by scope, order by GDB stack (callee first = left)
    const fm = new Map<string, TrackedVar[]>();
    for (const v of trackedVars) { if (!fm.has(v.scope)) fm.set(v.scope, []); fm.get(v.scope)!.push(v); }
    const stack: any[] = store.get("stack") || [];
    const so = stack.map((f: any) => (f.func || "").replace(/\(.*\)/, ""));
    const frames: Frame[] = [];
    for (const s of so) { if (fm.has(s)) { frames.push({ scope: s, vars: fm.get(s)! }); fm.delete(s); } }
    for (const [scope, vars] of fm) frames.push({ scope, vars });

    // Horizontal layout: frames side by side
    const maxRows = Math.max(...frames.map(f => f.vars.length), 1);
    const svgH = HEADER_H + 2 * PAD + maxRows * ROW_H;
    const frameX: number[] = [];
    let cx = 0;
    for (let i = 0; i < frames.length; i++) { frameX.push(cx); cx += FRAME_W + (i < frames.length - 1 ? GAP_X : 0); }
    const svgW = cx;

    const pos = (fi: number, vi: number) => ({
      cx: frameX[fi] + FRAME_W / 2,
      cy: HEADER_H + PAD + vi * ROW_H + ROW_H / 2,
    });

    // Address map
    const addrMap = new Map<string, [number, number]>();
    frames.forEach((f, fi) => f.vars.forEach((v, vi) => { const n = this.norm(v.address); if (n) addrMap.set(n, [fi, vi]); }));

    // Pointer links
    type Link = { from: [number, number]; to: [number, number] };
    const links: Link[] = [];
    const ptrSrc = new Set<string>();
    frames.forEach((f, fi) => f.vars.forEach((v, vi) => {
      const n = this.norm(v.value);
      if (n) { const t = addrMap.get(n); if (t && !(t[0] === fi && t[1] === vi)) { links.push({ from: [fi, vi], to: t }); ptrSrc.add(`${fi}:${vi}`); } }
    }));

    // Reference groups → alias detection (callee = alias, caller = original)
    const rg = new Map<string, [number, number][]>();
    frames.forEach((f, fi) => f.vars.forEach((v, vi) => { const n = this.norm(v.address); if (n) { if (!rg.has(n)) rg.set(n, []); rg.get(n)!.push([fi, vi]); } }));
    const refColor = new Map<string, string>();
    const aliasSet = new Set<string>();
    const refLines: { from: [number, number]; to: [number, number]; color: string }[] = [];
    let rci = 0;
    rg.forEach(members => {
      if (members.length > 1 && members.some(([fi]) => fi !== members[0][0])) {
        const c = REF_COLORS[rci++ % REF_COLORS.length];
        const maxFi = Math.max(...members.map(([fi]) => fi));
        const orig = members.find(([fi]) => fi === maxFi)!;
        members.forEach(([fi, vi]) => {
          refColor.set(`${fi}:${vi}`, c);
          if (fi !== maxFi) { aliasSet.add(`${fi}:${vi}`); refLines.push({ from: [fi, vi], to: orig, color: c }); }
        });
      }
    });

    return (
      <div style={{ padding: "4px" }}>
        <svg
          width="100%"
          viewBox={`-6 -6 ${svgW + 12} ${svgH + 12}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block", maxHeight: "300px" }}
        >
          <defs>
            <marker id="mw-ptr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--accent, #4F46E5)" /></marker>
            {REF_COLORS.map((c, i) => <marker key={i} id={`mw-ref${i}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill={c} /></marker>)}
          </defs>

          {/* Frame rectangles + circles */}
          {frames.map((frame, fi) => {
            const x = frameX[fi];
            const col = SCOPE_COLORS[fi % SCOPE_COLORS.length];
            return (
              <g key={fi}>
                <rect x={x} y={0} width={FRAME_W} height={svgH} rx={8} fill="var(--paper, #fff)" stroke="var(--struct-border, #D0D7DE)" strokeWidth={1.5} />
                <clipPath id={`fc${fi}`}><rect x={x} y={0} width={FRAME_W} height={svgH} rx={8} /></clipPath>
                <rect x={x} y={0} width={FRAME_W} height={HEADER_H} fill={col} clipPath={`url(#fc${fi})`} />
                <text x={x + 8} y={HEADER_H - 7} fill="#fff" fontSize="10" fontWeight="700" fontFamily="var(--font-mono, monospace)">{frame.scope ? `${frame.scope}()` : "(global)"}</text>

                {frame.vars.map((v, vi) => {
                  const k = `${fi}:${vi}`;
                  const p = pos(fi, vi);
                  const isPtr = ptrSrc.has(k);
                  const rc = refColor.get(k);
                  const alias = aliasSet.has(k);
                  const strokeC = rc || (isPtr ? "var(--accent, #4F46E5)" : "#999");
                  return (
                    <g key={vi}>
                      <circle cx={p.cx} cy={p.cy} r={R} fill={alias ? "none" : "var(--paper, #fff)"} stroke={strokeC} strokeWidth={2} strokeDasharray={alias ? "5,3" : "none"} />
                      <text x={p.cx} y={p.cy - R - 4} textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="var(--font-mono, monospace)" fill={rc || "var(--ink, #1a1a2e)"}>{v.varName}</text>
                      <text x={p.cx} y={p.cy + 4} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono, monospace)" fill={isPtr ? "var(--accent, #4F46E5)" : "var(--ink, #1a1a2e)"} fontWeight={isPtr ? 700 : 400}>{isPtr ? "●" : this.truncVal(v.value)}</text>
                      <text x={p.cx} y={p.cy + R + 10} textAnchor="middle" fontSize="7" fontFamily="var(--font-mono, monospace)" fill="var(--ink-soft, #6b7280)" opacity={0.45}>{this.shortAddr(v.address)}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* Pointer arrows — solid, horizontal between frames */}
          {links.map((lk, i) => {
            const a = pos(lk.from[0], lk.from[1]), b = pos(lk.to[0], lk.to[1]);
            const goRight = b.cx > a.cx;
            const x1 = a.cx + (goRight ? R : -R), y1 = a.cy;
            const x2 = b.cx + (goRight ? -R - 3 : R + 3), y2 = b.cy;
            const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2 - 12 - i * 8;
            return <path key={`p${i}`} d={`M${x1} ${y1} Q${midX} ${midY} ${x2} ${y2}`} fill="none" stroke="var(--accent, #4F46E5)" strokeWidth={2} markerEnd="url(#mw-ptr)" opacity={0.8} />;
          })}

          {/* Reference lines — dashed */}
          {refLines.map((rl, i) => {
            const a = pos(rl.from[0], rl.from[1]), b = pos(rl.to[0], rl.to[1]);
            const goRight = b.cx > a.cx;
            const x1 = a.cx + (goRight ? R : -R), y1 = a.cy;
            const x2 = b.cx + (goRight ? -R - 3 : R + 3), y2 = b.cy;
            const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2 + 12 + i * 8;
            const ci = REF_COLORS.indexOf(rl.color);
            return <path key={`r${i}`} d={`M${x1} ${y1} Q${midX} ${midY} ${x2} ${y2}`} fill="none" stroke={rl.color} strokeWidth={2} strokeDasharray="6,3" markerEnd={`url(#mw-ref${ci >= 0 ? ci : 0})`} opacity={0.7} />;
          })}
        </svg>
      </div>
    );
  }
}

export default MemoryWatch;
