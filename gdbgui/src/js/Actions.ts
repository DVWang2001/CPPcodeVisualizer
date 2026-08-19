import { store } from "statorgfc";
import { global_variable } from "./global_variable";
import GdbApi from "./GdbApi";
import SourceCode from "./SourceCode";
import Locals from "./Locals";
import Memory from "./Memory";
import constants from "./constants";
import React from "react";
import VisualizerHelper from "./VisualizerHelper";
import Visualizer from "./Visualizer";
import { parseForHeader, decideForSegment } from "./forHeader";
import { decideFastState, getFastForward, disarmFastForward } from "./fastForward";
import { lessonQuizRuntime } from "./lessonQuizRuntime";
import { clearStepWatchdog } from "./stepWatchdog";
void React; // using jsx implicity uses React

// ── for 迴圈三段式單步：每個真正的 GDB 停駐點重算一次 ──────────
// 停在能解析成 `for (A; B; C)` 的行上時，用 frame.addr 判定是初始化段(A)
// 還是遞增段(C)；其餘情況一律設 null，代表走現有行為。
// 條件段 B 不在這裡產生——GDB 永遠不會為它停下來，它是 GdbApi 的 UI 虛步。
function recompute_for_sub_step(frame: any) {
  const line = parseInt(frame?.line);
  // 會被快轉吃掉的停駐點一律不進虛步：GdbApi.click_next_button 同樣會跳過攔截，
  // 兩邊必須一致，否則每個 for 行要多花一個虛步、B 段高亮還會在無聲快轉中閃爍。
  // 反之「落地」的那一次（decideFastState 判 disarm）照常算段落——落地之後
  // 一切行為都要和沒有快轉時一模一樣。
  const _fast = getFastForward();
  if (_fast) {
    const _count = (global_variable as any).__line_visit_count?.[line] || 0;
    if (decideFastState(line, _count, _fast) === "hold") {
      store.set("for_sub_step", null);
      return;
    }
  }
  if (isNaN(line)) {
    store.set("for_sub_step", null);
    return;
  }
  const src = (global_variable as any).__source_text;
  const line_text = typeof src === "string" ? src.split("\n")[line - 1] : undefined;
  if (typeof line_text !== "string" || !parseForHeader(line_text)) {
    store.set("for_sub_step", null);
    return;
  }
  if (!(global_variable as any).__for_line_min_addr) {
    (global_variable as any).__for_line_min_addr = {};
  }
  const seg = decideForSegment(
    (global_variable as any).__for_line_min_addr,
    line,
    frame?.addr
  );
  store.set("for_sub_step", { line, seg });
}

const Actions = {
  clear_program_state: function () {
    store.set("line_of_source_to_flash", undefined);
    store.set("for_sub_step", null);
    store.set("paused_on_frame", undefined);
    store.set("selected_frame_num", 0);
    store.set("current_thread_id", undefined);
    store.set("stack", []);
    store.set("threads", []);
    Memory.clear_cache();
    Locals.clear();
    Visualizer.clear();
  },
  stop_tts: function () {
    (window as any)._gdbgui_tts_playing = null;
    (window as any)._gdbgui_tts_resume = null;
    (window as any)._tts_api?.cancel();
    store.set("tts_subtitle", null);
  },
  pause_tts: function () {
    const playing = (window as any)._gdbgui_tts_playing;
    const audioInfo = (window as any)._tts_api?.pause(); // 暫停 audio 並取得 url + currentTime
    if (audioInfo && playing) {
      // 儲存恢復所需資訊：audio 位置 + autoplayCommand + 字幕文字
      (window as any)._gdbgui_tts_resume = {
        url: audioInfo.url,
        currentTime: audioInfo.currentTime,
        autoplayCommand: playing.autoplayCommand,
        fullText: playing.subtitleText ?? playing.fullText,
      };
    }
    (window as any)._gdbgui_tts_playing = null;
    // 保留字幕，讓使用者看到目前播放到哪句話
  },
  inferior_program_starting: function () {
    lessonQuizRuntime.clearGate();
    Actions.stop_tts();
    // 執行代數：只有真正重新執行才遞增。ContainerVisualizer 的輪詢用它判斷
    // 「該把 plugin 狀態清掉了」，而不能用 inferior_program === "running"
    // ——後者在每一次單步時都會短暫成立，輪詢只要剛好落在那個窗就會把已經
    // 累積好的 BST 插入順序清光，接著被 render 的 lazy-init 用排序值捏造回來
    // （樹會變成一條退化鏈）。
    (global_variable as any).__run_generation =
      ((global_variable as any).__run_generation || 0) + 1;
    // 舊 GDB process 被 kill 時，in-flight 的 -var-create 不會有回應，
    // 導致 VarCreator._is_fetching 永遠為 true，卡死所有後續變數建立。
    // 透過 window 橋接（避免 Actions↔GdbVariable 循環 import）在此 reset。
    (window as any).gdbgui_reset_var_queue?.();
    // 清空 UML 物件圖狀態，否則重跑時面板會殘留上一次的物件框（中止在途輪詢 + 清 __latest_uml）
    (window as any).gdbgui_reset_uml_state?.();
    // 重新執行＝開一堂新的即時課堂（勾選了才會有反應）。橋接的理由同上：
    // LiveQuizPanel 才知道怎麼開課與收尾，Actions 不該認識它。
    //
    // ★ 這個鉤子曾經在這裡把程式殺掉過 ★
    // 開課與收課的副作用原本包含重載教案（connect → applyProjectBundle、
    // 收課 → loadLessonFromServer）。在這個時間點重載會把原始碼與 binary 從剛啟動的
    // inferior 底下抽走，下一步就得到 "The program is not being run."。
    // 兩條路徑現在都有守衛：版本沒變不重載（needsLessonVersionReload），換課途中
    // 不做收課的收尾（restartingRef）。動到那兩處守衛之前，先想清楚這裡。
    (window as any).gdbgui_live_quiz_restart?.();
    // 程式重新開始，重置每行的進入計數
    (global_variable as any).__line_visit_count = {};
    // 快轉綁在 __line_visit_count 上，計數歸零就必須解除（之後會再武裝一次）
    disarmFastForward();
    // 重置 for 行看過的最小位址（A/C 判定的依據），否則上一次執行的位址會殘留
    (global_variable as any).__for_line_min_addr = {};
    // 重置呼叫樹，避免上一次執行的節點殘留
    delete (global_variable as any).__call_tree;
    (global_variable as any).__call_graph_nodes = [];
    (global_variable as any).__call_graph_edges = [];
    (global_variable as any).__active_node_id = null;
    (global_variable as any).__active_path = [];
    store.set("inferior_program", constants.inferior_states.running);
    window.dispatchEvent(new Event('gdbgui:clear_program_output'));
    Actions.clear_program_state();
  },
  inferior_program_resuming: function () {
    Actions.stop_tts();
    store.set("inferior_program", constants.inferior_states.running);
  },
  inferior_program_paused: function (frame = {}) {
    clearStepWatchdog();
    store.set("inferior_program", constants.inferior_states.paused);
    store.set(
      "source_code_selection_state",
      constants.source_code_selection_states.PAUSED_FRAME
    );
    store.set("paused_on_frame", frame);
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'fullname' does not exist on type '{}'.
    store.set("fullname_to_render", frame.fullname);
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'line' does not exist on type '{}'.
    store.set("line_of_source_to_flash", parseInt(frame.line));
    // 遞增此行的進入計數（供 TTS/Guide | 語法使用）
    // @ts-expect-error
    const _visitLine = parseInt(frame.line);
    if (!isNaN(_visitLine)) {
      if (!(global_variable as any).__line_visit_count) (global_variable as any).__line_visit_count = {};
      (global_variable as any).__line_visit_count[_visitLine] =
        ((global_variable as any).__line_visit_count[_visitLine] || 0) + 1;
      // 記錄已執行行號供 Visualizer 使用
      if (!(global_variable as any).__visited_lines) (global_variable as any).__visited_lines = new Set<number>();
      (global_variable as any).__visited_lines.add(_visitLine);
    }
    // for 迴圈三段式單步：每次真正停下來都重算一次目前段落（A 或 C，或 null）
    recompute_for_sub_step(frame);
    const quizMatched = lessonQuizRuntime.onGdbPause(frame);
    if (lessonQuizRuntime.state().pendingTable) {
      const latestContainers = (global_variable as any).__latest_containers as Map<string, any> | undefined;
      if (latestContainers) latestContainers.clear();
      else (global_variable as any).__latest_containers = new Map();
    }
    if (quizMatched) {
      Actions.stop_tts();
      // 這裡以前是直接清成 null，於是收卷後閘門開了也沒東西可以續播，教師看到的是
      // 「收卷之後畫面就停在那裡」。改成寄放給 runtime，questionClosed 時交還。
      lessonQuizRuntime.stashAutoplay(store.get("autoplay_pending_command"));
      store.set("autoplay_pending_command", null);
    }
    // 讀取指導，如果存在指導並且當前的frame有line這個資訊
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'line' does not exist on type '{}'.
    VisualizerHelper.processing_guide(frame.line, frame.func);
    // 前瞻偵測 BST 容器 find/count 操作，在 TTS 開始前設好動畫 barrier
    // @ts-expect-error
    VisualizerHelper.detect_container_op(frame.line, frame.func);
    // 播放 TTS 語音
    // @ts-expect-error
    if (!quizMatched) VisualizerHelper.play_tts(frame.line, frame.func);
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'addr' does not exist on type '{}'.
    store.set("current_assembly_address", frame.addr);
    store.set("source_code_infinite_scrolling", false);
    SourceCode.make_current_line_visible();
    Actions.refresh_state_for_gdb_pause();
  },
  inferior_program_exited: function () {
    clearStepWatchdog();
    lessonQuizRuntime.clearGate();
    Actions.stop_tts();
    // 程式結束就沒有停駐點能解除快轉了，一律在這裡收掉
    disarmFastForward();
    store.set("inferior_program", constants.inferior_states.exited);
    store.set("disassembly_for_missing_file", []);
    store.set("root_gdb_tree_var", null);
    store.set("previous_register_values", {});
    store.set("current_register_values", {});
    store.set("inferior_pid", null);
    Actions.clear_program_state();
    store.set("edit_mode", true);
  },
  /**
   * Request relevant store information from gdb to refresh UI
   */
  refresh_state_for_gdb_pause: function () {
    GdbApi.run_gdb_command(GdbApi._get_refresh_state_for_pause_cmds());
  },
  execute_console_command: function (command: any) {
    if (store.get("refresh_state_after_sending_console_command")) {
      GdbApi.run_command_and_refresh_state(command);
    } else {
      GdbApi.run_gdb_command(command);
    }
  },
  onConsoleCommandRun: function () {
    if (store.get("refresh_state_after_sending_console_command")) {
      GdbApi.run_gdb_command(GdbApi._get_refresh_state_for_pause_cmds());
    }
  },
  clear_console: function () {
    store.set("gdb_console_entries", []);
  },
  add_console_entries: function (entries: any, type: any) {
    if (type === constants.console_entry_type.STD_OUT) {
      // ignore
      return;
    }
    if (!Array.isArray(entries)) {
      entries = [entries];
    }

    const pty = store.get("gdbguiPty");
    if (pty) {
      entries.forEach((data: string) => {
        const entriesToIgnore = [
          // No registers. appears when refresh commands are run when program hasn't started.
          // TODO The real fix for this is to not refresh commands when the program is not running.
          "No registers."
        ];
        if (entriesToIgnore.indexOf(data) > -1) {
          return;
        }
        // @ts-expect-error ts-migrate(2339) FIXME: Property 'colorTypeMap' does not exist on type 'Re... Remove this comment to see the full error message
        pty.write(constants.colorTypeMap[type] ?? constants.xtermColors["reset"]);
        pty.writeln(data);
        pty.write(constants.xtermColors["reset"]);
      });
    } else {
      console.error("Pty not available. New entries are:", entries);
    }
  },
  add_gdb_response_to_console(mi_obj: any) {
    if (!mi_obj) {
      return;
    }
    // Update status
    let entries = [],
      error = false;
    if (mi_obj.message) {
      if (mi_obj.message === "error") {
        error = true;
      } else {
        entries.push(mi_obj.message);
      }
    }
    if (mi_obj.payload) {
      const interesting_keys = ["msg", "reason", "signal-name", "signal-meaning"];
      for (let k of interesting_keys) {
        if (mi_obj.payload[k]) {
          entries.push(mi_obj.payload[k]);
        }
      }

      if (mi_obj.payload.frame) {
        for (let i of ["file", "func", "line", "addr"]) {
          if (i in mi_obj.payload.frame) {
            entries.push(`${i}: ${mi_obj.payload.frame[i]}`);
          }
        }
      }
    }
    let type = error
      ? constants.console_entry_type.STD_ERR
      : constants.console_entry_type.STD_OUT;
    Actions.add_console_entries(entries, type);
  },
  toggle_modal_visibility() {
    store.set("show_modal", !store.get("show_modal"));
  },
  show_modal(header: any, body: any) {
    store.set("modal_header", header);
    store.set("modal_body", body);
    store.set("show_modal", true);
  },
  set_gdb_binary_and_arguments(binary: any, args: any) {
    // remove list of source files associated with the loaded binary since we're loading a new one
    store.set("source_file_paths", []);
    store.set("language", "c_family");
    store.set("inferior_binary_path", null);
    Actions.inferior_program_exited();
    let cmds = GdbApi.get_load_binary_and_arguments_cmds(binary, args);
    GdbApi.run_gdb_command(cmds);
    GdbApi.get_inferior_binary_last_modified_unix_sec(binary);
  },
  connect_to_gdbserver(user_input: any) {
    // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Target-Manipulation.html#GDB_002fMI-Target-Manipulation
    store.set("source_file_paths", []);
    store.set("language", "c_family");
    store.set("inferior_binary_path", null);
    Actions.inferior_program_exited();
    GdbApi.run_gdb_command([`-target-select remote ${user_input}`]);
  },
  remote_connected() {
    Actions.inferior_program_paused();
    let cmds = [];
    if (store.get("auto_add_breakpoint_to_main")) {
      Actions.add_console_entries(
        "Connected to remote target! Adding breakpoint to main, then continuing target execution.",
        constants.console_entry_type.GDBGUI_OUTPUT
      );
      cmds.push("-break-insert main");
      cmds.push("-exec-continue");
      cmds.push(GdbApi.get_break_list_cmd());
    } else {
      Actions.add_console_entries(
        'Connected to remote target! Add breakpoint(s), then press "continue" button (do not press "run").',
        constants.console_entry_type.GDBGUI_OUTPUT
      );
    }
    GdbApi.run_gdb_command(cmds);
  },
  attach_to_process(user_input: any) {
    // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Target-Manipulation.html#GDB_002fMI-Target-Manipulation
    GdbApi.run_gdb_command(`-target-attach ${user_input}`);
  },
  fetch_source_files() {
    store.set("source_file_paths", []);
    GdbApi.run_gdb_command("-file-list-exec-source-files");
  },
  view_file(fullname: any, line: any) {
    store.set("fullname_to_render", fullname);
    store.set("source_code_infinite_scrolling", false);
    Actions.set_line_state(line);
  },
  set_line_state(line: any) {
    store.set("source_code_infinite_scrolling", false);
    store.set(
      "source_code_selection_state",
      constants.source_code_selection_states.USER_SELECTION
    );
    store.set("line_of_source_to_flash", parseInt(line));
    store.set("make_current_line_visible", true);
  },
  clear_cached_assembly() {
    store.set("disassembly_for_missing_file", []);
    let cached_source_files = store.get("cached_source_files");
    for (let file of cached_source_files) {
      file.assembly = {};
    }
    store.set("cached_source_files", cached_source_files);
  },
  update_max_lines_of_code_to_fetch(new_value: any) {
    if (new_value <= 0) {
      new_value = constants.default_max_lines_of_code_to_fetch;
    }
    store.set("max_lines_of_code_to_fetch", new_value);
    localStorage.setItem("max_lines_of_code_to_fetch", JSON.stringify(new_value));
  },
  /**
   * Send a signal to one of *this session's own* processes.
   *
   * `target` names which process the server should signal — "gdb" or
   * "inferior" — and the server resolves the pid itself from the debug
   * session this browser session owns. The client deliberately cannot supply
   * a pid: the old endpoint took one from the form and os.kill()'d it as root,
   * which let any user signal PID 1, the gdbgui server, or another user's gdb.
   */
  send_signal(signal_name: any, target: "gdb" | "inferior") {
    $.ajax({
      beforeSend: function (xhr) {
        xhr.setRequestHeader(
          "x-csrftoken",
          // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'initial_data'.
          initial_data.csrf_token
        ); /* global initial_data */
      },
      url: "/send_signal",
      cache: false,
      type: "POST",
      data: { signal_name: signal_name, target: target },
      success: function (response) {
        Actions.add_console_entries(
          response.message,
          constants.console_entry_type.GDBGUI_OUTPUT
        );
      },
      error: function (response) {
        if (response.responseJSON && response.responseJSON.message) {
          Actions.add_console_entries(
            // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
            _.escape(response.responseJSON.message),
            constants.console_entry_type.STD_ERR
          );
        } else {
          Actions.add_console_entries(
            `${response.statusText} (${response.status} error)`,
            constants.console_entry_type.STD_ERR
          );
        }
        console.error(response);
      },
      complete: function () { }
    });
  }
};

export default Actions;
