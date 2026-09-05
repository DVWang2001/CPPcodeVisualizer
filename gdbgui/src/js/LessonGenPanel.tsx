import React from "react";
import { LessonCfg, applyPreset, loadCfg, saveCfg, buildRequestBody, takeCompleteLines } from "./lessonGen";

type Props = { getSource: () => string; onApply: (code: string) => void; onClose: () => void };
type State = {
  cfg: LessonCfg;
  instruction: string;
  loading: boolean;
  error: string;
  preview: string | null;
  /** 串流中已收到的教案文字（只有 content，不含推理過程）。 */
  streamed: string;
  /** 模型的思考過程。推理階段長達數分鐘，沒有它畫面會整整幾分鐘空白。 */
  thinking: string;
};

const box: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", fontFamily: "monospace",
  fontSize: 13, border: "1px solid #ccc", borderRadius: 4, padding: "6px",
};

export default class LessonGenPanel extends React.Component<Props, State> {
  state: State = { cfg: loadCfg(), instruction: "", loading: false, error: "", preview: null, streamed: "", thinking: "" };
  _mounted = false;

  componentDidMount() {
    this._mounted = true;
  }

  componentWillUnmount() {
    this._mounted = false;
  }

  setCfg = (patch: Partial<LessonCfg>) => {
    const cfg = { ...this.state.cfg, ...patch };
    this.setState({ cfg });
    saveCfg(cfg);
  };

  onPreset = (preset: string) => {
    const cfg = applyPreset(this.state.cfg, preset);
    this.setState({ cfg });
    saveCfg(cfg);
  };

  generate = async () => {
    const source = this.props.getSource();
    if (!source.trim()) {
      this.setState({ error: "編輯器沒有程式碼" });
      return;
    }
    this.setState({ loading: true, error: "", preview: null, streamed: "", thinking: "" });
    try {
      const resp = await fetch("/api/generate_lesson", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 少了這一行，全域的 before_request 會在請求碰到路由之前就 403，
          // 而且畫面上只看得到一個沒頭沒尾的錯誤。其他每個 POST 都帶了。
          "x-csrftoken": (window as any).initial_data.csrf_token,
        },
        body: JSON.stringify(buildRequestBody(this.state.cfg, source, this.state.instruction)),
      });
      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => "");
        throw new Error(detail.slice(0, 300) || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      // 逐塊讀。stream: true 讓 decoder 保留被切一半的多位元組字元，
      // 否則中文會在切塊邊界變成問號。
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { events, rest } = takeCompleteLines(buffer);
        buffer = rest;
        for (const ev of events) {
          if (!this._mounted) return;
          if ("error" in ev) throw new Error(ev.error);
          if ("thinking" in ev) {
            this.setState((prev) => ({ thinking: prev.thinking + ev.thinking }));
          } else if ("delta" in ev) {
            this.setState((prev) => ({ streamed: prev.streamed + ev.delta }));
          } else if ("done" in ev) {
            done = true;
            this.setState({ preview: ev.code });
          }
        }
      }
      if (!done && this._mounted) {
        throw new Error("串流中斷，教案沒有收完整");
      }
    } catch (e: any) {
      if (!this._mounted) return;
      this.setState({ error: e.message || String(e) });
    } finally {
      if (this._mounted) this.setState({ loading: false });
    }
  };

  render() {
    const { cfg, instruction, loading, error, preview } = this.state;
    return (
      <div
        data-testid="lesson-gen-panel"
        style={{
          position: "absolute", top: 34, right: 8, zIndex: 60, width: 440,
          maxHeight: "75%", overflowY: "auto", border: "1px solid #8b5cf6",
          borderRadius: 6, background: "var(--paper,#1e1e1e)", color: "#cbd0d8",
          padding: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        }}
        onKeyDown={(e) => { if (e.key === "Escape") this.props.onClose(); }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong style={{ fontSize: 13, color: "#8b5cf6" }}>🤖 AI 生成教案</strong>
          <button onClick={this.props.onClose}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 12, whiteSpace: "nowrap" }}>模型</label>
          <select value={cfg.preset} onChange={(e) => this.onPreset(e.target.value)} data-testid="lesson-preset">
            <option value="nvidia">NVIDIA NIM（伺服器已設金鑰）</option>
            <option value="zen">OpenCode Zen · big-pickle（很慢，需自備 key）</option>
            <option value="mistral">Mistral（需自備 key）</option>
            <option value="custom">自訂</option>
          </select>
        </div>
        <input style={{ ...box, marginBottom: 4 }} placeholder="base URL（https://…/v1）"
          value={cfg.baseUrl} onChange={(e) => this.setCfg({ baseUrl: e.target.value, preset: "custom" })} />
        <input style={{ ...box, marginBottom: 4 }} placeholder="model 名稱"
          value={cfg.model} onChange={(e) => this.setCfg({ model: e.target.value, preset: "custom" })} />
        <input style={{ ...box, marginBottom: 6 }} type="password"
          placeholder="API key（用 NVIDIA 可留空；換別家要自己填，會存在此瀏覽器）"
          value={cfg.apiKey} onChange={(e) => this.setCfg({ apiKey: e.target.value })} />

        <textarea style={{ ...box, marginBottom: 6 }} rows={2} data-testid="lesson-instruction"
          placeholder="額外指示（選填，例：重點放在遞迴、TTS 語速放慢）"
          value={instruction} onChange={(e) => this.setState({ instruction: e.target.value })} />

        <button className="btn btn-primary btn-sm" disabled={loading} onClick={this.generate} data-testid="lesson-generate">
          {loading
            ? this.state.streamed
              ? `生成中…已寫 ${this.state.streamed.length} 字`
              : `思考中…${this.state.thinking.length} 字`
            : "生成教案"}
        </button>

        {error && (
          <div data-testid="lesson-error" style={{ marginTop: 6, color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: "#8b5cf6", marginBottom: 4 }}>
              生成中（模型會先思考再動筆，整份約十分鐘起跳；請勿關閉此面板）
            </div>
            {this.state.streamed ? (
              <textarea readOnly value={this.state.streamed} rows={14}
                style={{ ...box, whiteSpace: "pre" }} data-testid="lesson-stream" />
            ) : (
              <textarea readOnly value={this.state.thinking} rows={8} data-testid="lesson-thinking"
                style={{ ...box, whiteSpace: "pre-wrap", opacity: 0.65, fontStyle: "italic" }} />
            )}
          </div>
        )}

        {preview !== null && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: "#8b5cf6", marginBottom: 4 }}>預覽（尚未套用）</div>
            <textarea readOnly value={preview} rows={14} style={{ ...box, whiteSpace: "pre" }} data-testid="lesson-preview" />
            <div style={{ marginTop: 6, textAlign: "right" }}>
              <button className="btn btn-default btn-sm" style={{ marginRight: 6 }} onClick={() => this.setState({ preview: null })}>
                取消
              </button>
              <button className="btn btn-primary btn-sm" data-testid="lesson-apply"
                onClick={() => this.props.onApply(this.state.preview as string)}>
                套用到編輯器
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
}
