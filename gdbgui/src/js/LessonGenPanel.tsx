import React from "react";
import { LessonCfg, applyPreset, loadCfg, saveCfg, buildRequestBody } from "./lessonGen";

type Props = { getSource: () => string; onApply: (code: string) => void; onClose: () => void };
type State = {
  cfg: LessonCfg;
  instruction: string;
  loading: boolean;
  error: string;
  preview: string | null;
};

const box: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", fontFamily: "monospace",
  fontSize: 13, border: "1px solid #ccc", borderRadius: 4, padding: "6px",
};

export default class LessonGenPanel extends React.Component<Props, State> {
  state: State = { cfg: loadCfg(), instruction: "", loading: false, error: "", preview: null };
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
    this.setState({ loading: true, error: "", preview: null });
    try {
      const resp = await fetch("/api/generate_lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(this.state.cfg, source, this.state.instruction)),
      });
      const data = await resp.json();
      if (!this._mounted) return;
      if (!resp.ok || data.message) throw new Error(data.message || `HTTP ${resp.status}`);
      this.setState({ preview: data.code });
    } catch (e: any) {
      if (!this._mounted) return;
      this.setState({ error: e.message || String(e) });
    } finally {
      if (!this._mounted) return;
      this.setState({ loading: false });
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
            <option value="zen">OpenCode Zen · big-pickle（免費，伺服器已設金鑰）</option>
            <option value="nvidia">NVIDIA NIM（需自備 key）</option>
            <option value="mistral">Mistral（需自備 key）</option>
            <option value="custom">自訂</option>
          </select>
        </div>
        <input style={{ ...box, marginBottom: 4 }} placeholder="base URL（https://…/v1）"
          value={cfg.baseUrl} onChange={(e) => this.setCfg({ baseUrl: e.target.value, preset: "custom" })} />
        <input style={{ ...box, marginBottom: 4 }} placeholder="model 名稱"
          value={cfg.model} onChange={(e) => this.setCfg({ model: e.target.value, preset: "custom" })} />
        <input style={{ ...box, marginBottom: 6 }} type="password"
          placeholder="API key（用 Zen 可留空；換別家要自己填，會存在此瀏覽器）"
          value={cfg.apiKey} onChange={(e) => this.setCfg({ apiKey: e.target.value })} />

        <textarea style={{ ...box, marginBottom: 6 }} rows={2} data-testid="lesson-instruction"
          placeholder="額外指示（選填，例：重點放在遞迴、TTS 語速放慢）"
          value={instruction} onChange={(e) => this.setState({ instruction: e.target.value })} />

        <button className="btn btn-primary btn-sm" disabled={loading} onClick={this.generate} data-testid="lesson-generate">
          {loading ? "生成中…（最長 2 分鐘）" : "生成教案"}
        </button>

        {error && (
          <div data-testid="lesson-error" style={{ marginTop: 6, color: "#ff6b6b", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {error}
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
