import React from "react";

import Actions from "./Actions";
import GdbApi from "./GdbApi";
import constants from "./constants";
import { store } from "statorgfc";
import { lessonQuizRuntime } from "./lessonQuizRuntime";

type State = any;

class ControlButtons extends React.Component<{}, State> {
  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, ["gdb_pid", "reverse_supported", "autoplay_enabled", "autoplay_paused", "edit_mode", "inferior_program", "tts_speed", "quiz_playback_gate"]);
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
          disabled={this.state.quiz_playback_gate}
        >
          <span className="glyphicon glyphicon-play" />
        </button>

        <button
          id="pause_button"
          // 訊號送給「被除錯的程式」而不是 gdb 本身。送給 gdb 沒有作用：
          // 這裡的 MI 是同步的，程式在跑的時候 gdb 根本沒在讀 MI pty，
          // 所以 -exec-interrupt 也一樣無效（兩者都實測過）。
          // 送給 inferior 則由 gdb 透過 ptrace 攔下並停住；SIGINT 的預設處置是
          // Stop=Yes Print=Yes Pass=No，所以不會轉交給程式，使用者自己註冊的
          // signal handler 不會被觸發（已實測：繼續執行後 handler 計數仍為 0）。
          onClick={() => { Actions.stop_tts(); Actions.send_signal("SIGINT", "inferior"); }}
          type="button"
          title="中斷正在執行的程式（送 SIGINT），回到除錯狀態"
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
          disabled={this.state.quiz_playback_gate}
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
          disabled={this.state.quiz_playback_gate}
        >
          <span className="glyphicon glyphicon-arrow-down" />
        </button>

        <button
          id="return_button"
          onClick={() => GdbApi.click_return_button()}
          type="button"
          title="Step out of current function keyboard shortcut: u or up arrow"
          className={btn_class}
          disabled={this.state.quiz_playback_gate}
        >
          <span className="glyphicon glyphicon-arrow-up" />
        </button>
        <button
          id="edit_mode_button"
          onClick={() => {
            const enteringEditMode = !this.state.edit_mode;
            if (enteringEditMode) {
              lessonQuizRuntime.deactivate();
              // 切回編輯模式時，先終止 inferior（被偵錯的程式）
              const inf = this.state.inferior_program;
              if (inf === "running" || inf === "paused") {
                store.set(
                  "source_code_selection_state",
                  constants.source_code_selection_states.USER_SELECTION
                );
                GdbApi.run_gdb_command("kill");
                Actions.inferior_program_exited();
              }
              // 明確還原到使用者的源碼檔案（user_source_fullname），
              // 不再用脆弱的 includes("uploads/") 路徑比對。
              // 若從未編譯過，回到空白狀態讓 Monaco 顯示預設模板。
              const userSrc: string | null = store.get("user_source_fullname") || null;
              store.set("fullname_to_render", userSrc);
              store.set("source_code_state", constants.source_code_states.NONE_AVAILABLE);
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

        {this.state.autoplay_enabled && (
          <span
            title="TTS 播放速度"
            style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "4px", verticalAlign: "middle" }}
          >
            <span style={{ fontSize: "11px", color: "#aaa", userSelect: "none" }}>
              {Number(this.state.tts_speed).toFixed(1)}x
            </span>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={this.state.tts_speed}
              onChange={(e) => {
                const speed = parseFloat(e.target.value);
                store.set("tts_speed", speed);
                // 若目前正在播放，立即套用新速度
                const audio = (window as any)._tts_api?._current?.();
                if (audio) audio.playbackRate = speed;
              }}
              style={{ width: "70px", cursor: "pointer", accentColor: "#5cb85c" }}
              title={`播放速度：${Number(this.state.tts_speed).toFixed(1)}x（拖曳調整 0.5x ~ 2.0x）`}
            />
          </span>
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
