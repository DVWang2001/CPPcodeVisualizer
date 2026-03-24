import React from "react";

import Actions from "./Actions";
import GdbApi from "./GdbApi";
import constants from "./constants";
import { store } from "statorgfc";

type State = any;

class ControlButtons extends React.Component<{}, State> {
  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, ["gdb_pid", "reverse_supported", "autoplay_enabled", "autoplay_paused", "edit_mode", "inferior_program"]);
  }
  render() {
    let btn_class = "btn btn-default btn-sm";

    return (
      <React.Fragment>
        <button
          id="run_button"
          onClick={() => GdbApi.click_run_button()}
          type="button"
          title="Start inferior program from the beginning keyboard shortcut: r"
          className={btn_class}
        >
          <span className="glyphicon glyphicon-repeat" />
        </button>

        <button
          id="continue_button"
          onClick={() => GdbApi.click_continue_button()}
          type="button"
          title={
            "Continue until breakpoint is hit or inferior program exits keyboard shortcut: c" +
            (this.state.reverse_supported ? ". shift + c for reverse." : "")
          }
          className={btn_class}
        >
          <span className="glyphicon glyphicon-play" />
        </button>

        <button
          onClick={() => { Actions.stop_tts(); Actions.send_signal("SIGINT", this.state.gdb_pid); }}
          type="button"
          title="Send Interrupt signal (SIGINT) to gdb process to pause it (if it's running)"
          className={btn_class}
        >
          <span className="glyphicon glyphicon-pause" />
        </button>

        <button
          id="next_button"
          onClick={() => GdbApi.click_next_button()}
          type="button"
          title={
            "Step over next function call keyboard shortcut: n or right arrow" +
            (this.state.reverse_supported ? ". shift + n for reverse." : "")
          }
          className={btn_class}
        >
          <span className="glyphicon glyphicon-step-forward" />
        </button>

        <button
          id="step_button"
          onClick={() => GdbApi.click_step_button()}
          type="button"
          title={
            "Step into next function call keyboard shortcut: s or down arrow" +
            (this.state.reverse_supported ? ". shift + s for reverse." : "")
          }
          className={btn_class}
        >
          <span className="glyphicon glyphicon-arrow-down" />
        </button>

        <button
          id="return_button"
          onClick={() => GdbApi.click_return_button()}
          type="button"
          title="Step out of current function keyboard shortcut: u or up arrow"
          className={btn_class}
        >
          <span className="glyphicon glyphicon-arrow-up" />
        </button>
        <button
          id="edit_mode_button"
          onClick={() => {
            const enteringEditMode = !this.state.edit_mode;
            if (enteringEditMode) {
              // 切回編輯模式時，先終止 inferior（被偵錯的程式）
              const inf = this.state.inferior_program;
              if (inf === "running" || inf === "paused") {
                // 在清除 paused_on_frame 之前，先把 selection state 切為 USER_SELECTION，
                // 避免 FileOps._store_change_callback 因 paused_frame_fullname=null
                // 而把 source_code_state 設成 NONE_AVAILABLE（顯示「no source code」）
                store.set(
                  "source_code_selection_state",
                  constants.source_code_selection_states.USER_SELECTION
                );
                // GDB kill 指令可在 running / paused 兩種狀態下直接終止 inferior
                GdbApi.run_gdb_command("kill");
                Actions.inferior_program_exited();
              }
            }
            store.set("edit_mode", enteringEditMode);
          }}
          type="button"
          title={this.state.edit_mode
            ? "編輯模式（點擊結束程式並切換至播放模式）"
            : "點擊終止程式並開啟編輯模式，顯示 Guide/TTS 輸入欄"}
          className={btn_class + (this.state.edit_mode ? " active" : "")}
          style={this.state.edit_mode ? { color: "#f0ad4e", fontWeight: "bold" } : { color: "#999" }}
        >
          Edit
        </button>

        <button
          id="autoplay_button"
          onClick={() => {
            const enabling = !this.state.autoplay_enabled;
            store.set("autoplay_enabled", enabling);
            // 重新開啟自動播放時，清除暫停狀態
            if (enabling) {
              store.set("autoplay_paused", false);
              store.set("autoplay_pending_command", null);
            }
          }}
          type="button"
          title={this.state.autoplay_enabled
            ? "自動播放已啟用：TTS 結束後自動執行下一步 (點擊關閉)"
            : "自動播放已關閉：開啟後 TTS 結束自動執行 [next]/[step-in] 等指令"}
          className={btn_class + (this.state.autoplay_enabled ? " active" : "")}
          style={this.state.autoplay_enabled ? { color: "#5cb85c", fontWeight: "bold" } : {}}
        >
          Auto
        </button>

        {this.state.autoplay_enabled && (
          <button
            id="autoplay_pause_button"
            onClick={() => {
              const pausing = !this.state.autoplay_paused;
              store.set("autoplay_paused", pausing);
              if (pausing) {
                // 暫停時儲存 TTS 剩餘文字，以便恢復時繼續朗讀
                Actions.pause_tts();
              } else {
                // 恢復時：先試著從中斷的 TTS 繼續朗讀
                const resumed = (window as any).gdbgui_resume_tts?.();
                if (!resumed) {
                  // 沒有 TTS 要恢復，直接執行待執行的 GDB 指令
                  const pending = store.get("autoplay_pending_command");
                  if (pending) {
                    store.set("autoplay_pending_command", null);
                    (window as any).gdbgui_run_autoplay_command(pending);
                  }
                }
              }
            }}
            type="button"
            title={this.state.autoplay_paused
              ? "自動播放已暫停，點擊繼續從目前進度播放"
              : "暫停自動播放，保留進度"}
            className={btn_class + (this.state.autoplay_paused ? " active" : "")}
            style={this.state.autoplay_paused ? { color: "#f0ad4e", fontWeight: "bold" } : { color: "#5cb85c" }}
          >
            <span className={this.state.autoplay_paused ? "glyphicon glyphicon-play" : "glyphicon glyphicon-pause"} />
          </button>
        )}

        {/* <div role="group" className="btn-group btn-group-xs">
          <button
            id="next_instruction_button"
            onClick={() => GdbApi.click_next_instruction_button()}
            type="button"
            title={
              "Next Instruction: Execute one machine instruction, stepping over function calls keyboard shortcut: m" +
              (this.state.reverse_supported ? ". shift + m for reverse." : "")
            }
            className="btn btn-default"
          >
            NI
          </button>
          <button
            id="step_instruction_button"
            onClick={() => GdbApi.click_step_instruction_button()}
            type="button"
            title={
              "Step Instruction: Execute one machine instruction, stepping into function calls keyboard shortcut: ','" +
              (this.state.reverse_supported ? ". shift + , for reverse." : "")
            }
            className="btn btn-default"
          >
            SI
          </button>
        </div> */}
      </React.Fragment>
    );
  }
}

export default ControlButtons;
