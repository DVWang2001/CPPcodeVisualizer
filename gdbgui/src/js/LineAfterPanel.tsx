// S5: right-sidebar panel "執行這行的結果" — what the line at the current stop did (after-state, S3/S4).
// Listens to the window event that GdbApi forwards from the engine's vg_line_after side event.
import React from "react";
import { global_variable } from "./global_variable";
import { describeLineAfter, LineAfterPayload } from "./lineAfterText";

type State = { last: LineAfterPayload | null };

class LineAfterPanel extends React.Component<{}, State> {
  state: State = { last: null };

  onAfter = (e: Event) => {
    this.setState({ last: (e as CustomEvent).detail as LineAfterPayload });
  };

  componentDidMount() {
    window.addEventListener("gdbgui-line-after", this.onAfter);
  }

  componentWillUnmount() {
    window.removeEventListener("gdbgui-line-after", this.onAfter);
  }

  render() {
    const last = this.state.last;
    if (!last) {
      return <div className="line-after-panel">按下執行並停在某一行後，這裡會說明那一行做了什麼。</div>;
    }
    // the teacher's @bug note for this line (why it is wrong), if the lesson has one
    const bug: string | undefined = ((global_variable as any).__bug || {})[String(last.line)];
    return (
      <div className="line-after-panel">
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
