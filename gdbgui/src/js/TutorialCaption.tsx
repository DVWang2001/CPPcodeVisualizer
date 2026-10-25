/**
 * 教學頁底部的全寬字幕帶（設計稿「字幕 1」）。
 * 原本字幕顯示在底部終端機區的黑底大字區（Terminals.tsx），教學頁把終端機拿掉後
 * 由這裡接手：同一份 store.tts_subtitle、同樣只在非編輯模式出現、播完才清掉。
 * 沒有開關——字幕是教學的一部分。編輯模式（沒有在跑程式）整條不出現。
 */
import React from "react";
import { store } from "statorgfc";

type Subtitle = { text: string; line?: number | null } | null;
type Visit = { line: number; k: number; n: number | null } | null;

class TutorialCaption extends React.Component<{}, any> {
  constructor(props: {}) {
    super(props);
    // @ts-expect-error statorgfc is untyped
    store.connectComponentState(this, ["tts_subtitle", "edit_mode"]);
    this.state = { ...(this.state || {}), visit: null as Visit };
  }

  _onVisit = (e: Event) => this.setState({ visit: (e as CustomEvent).detail || null });

  componentDidMount() {
    window.addEventListener("tutorial-visit", this._onVisit);
    this._syncBody();
  }
  componentWillUnmount() {
    window.removeEventListener("tutorial-visit", this._onVisit);
    document.body.classList.remove("tut-caption-on");
  }
  componentDidUpdate() {
    this._syncBody();
  }

  /** 字幕帶出現時，上面的練習區要讓出高度（見 tutorial.css）；Monaco 要重新量版面。 */
  _syncBody() {
    const on = !this.state.edit_mode;
    if (document.body.classList.contains("tut-caption-on") === on) return;
    document.body.classList.toggle("tut-caption-on", on);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
  }

  render() {
    if (this.state.edit_mode) return null;
    const sub: Subtitle = this.state.tts_subtitle || null;
    const visit: Visit = this.state.visit;
    const line = sub && sub.line !== undefined && sub.line !== null ? sub.line : visit ? visit.line : null;
    return (
      <div id="tutorial_caption" className="tut-caption" role="status" aria-live="polite">
        <div className="tut-cap-left">
          {line !== null && <span className="tut-cap-line">第 {line} 行</span>}
          {visit && visit.n && visit.n > 1 && (
            <span id="tutorial_visit" className="tut-cap-visit">
              第 {visit.k} / {visit.n} 次進入
            </span>
          )}
        </div>
        <div className="tut-cap-text">{sub ? sub.text : ""}</div>
        <div className="tut-cap-right">
          {sub && (
            <>
              <span className="tut-cap-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              朗讀中
            </>
          )}
        </div>
      </div>
    );
  }
}

export default TutorialCaption;
