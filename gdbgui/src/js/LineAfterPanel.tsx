// S5: right-sidebar panel "執行這行的結果" — what the line at the current stop did (after-state, S3/S4).
// Listens to the window event that GdbApi forwards from the engine's vg_line_after side event.
import React from "react";
import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import { describeLineAfter, LineAfterPayload } from "./lineAfterText";

type State = { last: LineAfterPayload | null; runtime_error: any };

class LineAfterPanel extends React.Component<{}, State> {
  state: State = { last: null, runtime_error: store.get("runtime_error") };
  private unsubscribe: (() => void) | null = null;

  onAfter = (e: Event) => {
    this.setState({ last: (e as CustomEvent).detail as LineAfterPayload });
  };

  componentDidMount() {
    window.addEventListener("gdbgui-line-after", this.onAfter);
    // 停在執行錯誤那一步時多一行錯誤標記（runtimeErrorState 寫 store 的 runtime_error）
    this.unsubscribe = (store as any).subscribeToKeys(["runtime_error"], () => this.setState({ runtime_error: store.get("runtime_error") }));
  }

  componentWillUnmount() {
    window.removeEventListener("gdbgui-line-after", this.onAfter);
    if (this.unsubscribe) this.unsubscribe();
  }

  render() {
    const last = this.state.last;
    const rt = this.state.runtime_error;
    const rtLine =
      rt && rt.here && rt.diag ? <div className="line-after-rterror" style={{ color: "#b42318", fontWeight: 700 }}>這一行發生執行錯誤：{rt.diag.title}（見「執行錯誤」面板）</div> : null;
    if (!last) {
      return (
        <div className="line-after-panel">
          {rtLine}
          按下執行並停在某一行後，這裡會說明那一行做了什麼。
        </div>
      );
    }
    // the teacher's @bug note for this line (why it is wrong), if the lesson has one
    const bug: string | undefined = ((global_variable as any).__bug || {})[String(last.line)];
    return (
      <div className="line-after-panel">
        {rtLine}
        {bug ? <div className="line-after-bug">錯誤診斷：{bug}</div> : null}
        {describeLineAfter(last).map((text, i) => (
          <div key={i} className={i === 0 ? "line-after-title" : "line-after-row"}>
            {text}
          </div>
        ))}
      </div>
    );
  }
}

export default LineAfterPanel;
