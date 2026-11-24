// 右側欄「執行錯誤」面板（id runtime_errors）：畫出 store 的 runtime_error（runtimeErrorState 寫入）。
// 「跳到第 N 行」走 GdbApi.seek_to_step（-vg-seek-step），停下來後一般的停點處理會更新所有面板。
// 程式跑完或回到編輯模式後面板照樣顯示（RightSidebar 在編輯模式不鎖這個面板），只是不能再跳步。
import React from "react";
import { store } from "statorgfc";
import GdbApi from "./GdbApi";
import { RuntimeErrorView, RtStatus } from "./RuntimeErrorView";
import { RuntimeErrorState } from "./runtimeErrorState";

type State = { runtime_error: RuntimeErrorState | null; edit_mode: boolean };

class RuntimeErrorPanel extends React.Component<{}, State> {
  constructor(props: {}) {
    super(props);
    this.state = { runtime_error: store.get("runtime_error"), edit_mode: store.get("edit_mode") };
    // @ts-expect-error statorgfc's old declarations: connectComponentState is untyped
    store.connectComponentState(this, ["runtime_error", "edit_mode"]);
  }

  render() {
    const rt = this.state.runtime_error;
    if (!rt || !rt.diag) {
      return (
        <div style={{ padding: "10px 12px", fontSize: 13, lineHeight: 1.6, color: "#5c5873" }}>
          這次執行還沒有執行錯誤。程式執行時出錯（例如除以零、陣列越界、空指標），這裡會畫出發生了什麼、值從哪裡來、怎麼改。
        </div>
      );
    }
    // 跑完了（停點 exited）→ ended；沒跑完就回到編輯模式（例如停在錯誤那一步按「編輯」）→ stopped
    const status: RtStatus = rt.ended ? "ended" : this.state.edit_mode ? "stopped" : "paused";
    return <RuntimeErrorView diag={rt.diag} stepNow={rt.stepNow} status={status} onJump={(step: number) => GdbApi.seek_to_step(step)} />;
  }
}

export default RuntimeErrorPanel;
