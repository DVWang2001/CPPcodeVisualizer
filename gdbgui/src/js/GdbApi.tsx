/**
 * An object to manage the websocket connection to the python server that manages gdb,
 * to send various commands to gdb, to and to dispatch gdb responses to gdbgui.
 */
import { store } from "statorgfc";
import Registers from "./Registers";
import Memory from "./Memory";
import Actions from "./Actions";
import GdbVariable from "./GdbVariable";
import constants from "./constants";
import process_gdb_response from "./process_gdb_response";
import React from "react";
import io from "socket.io-client";
import Visualizerhelper from "./Visualizerhelper";
void React; // needed when using JSX, but not marked as used
/* global debug */

// print to console if debug is true
let log: {
  (arg0: string): void;
  (...data: any[]): void;
  (message?: any, ...optionalParams: any[]): void;
  (): void;
};
// @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'debug'.
if (debug) {
  log = console.info;
} else {
  log = function() {
    // stubbed out
  };
}

/**
 * This object contains methods to interact with
 * gdb, but does not directly render anything in the DOM.
 */
// @ts-expect-error ts-migrate(2339) FIXME: Property 'initial_data' does not exist on type 'Wi... Remove this comment to see the full error message
const initial_data = window.initial_data;
let socket: SocketIOClient.Socket;
const GdbApi = {
  getSocket: function() {
    return socket;
  },
  init: function() {
    const TIMEOUT_MIN = 5;
    socket = io.connect(`/gdb_listener`, {
      timeout: TIMEOUT_MIN * 60 * 1000,
      query: {
        csrf_token: initial_data.csrf_token,
        gdbpid: initial_data.gdbpid,
        gdb_command: initial_data.gdb_command
      }
    });

    socket.on("connect", function() {
      log("connected");
      const queuedGdbCommands = store.get("queuedGdbCommands");
      if (queuedGdbCommands) {
        GdbApi.run_gdb_command(queuedGdbCommands);
        store.set("queuedGdbCommands", []);
      }
    });
    
    socket.on("gdb_response", function(response_array: any) {
      // @ts-expect-error ts-migrate(2769) FIXME: Argument of type 'null' is not assignable to param... Remove this comment to see the full error message
      clearTimeout(GdbApi._waiting_for_response_timeout);
      store.set("waiting_for_response", false);
      // 收到 gdb 真正回應時，取消任何待處理的「樂觀移動」狀態
      GdbApi._optimistic_resume_pending = false;
      process_gdb_response(response_array,GdbApi._has_optimistic_resume);
      // Visualizerhelper.run(response_array);
    });
    socket.on("fatal_server_error", function(data: { message: null | string }) {
      Actions.add_console_entries(
        `Message from server: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
      socket.close();
    });
    socket.on("error_running_gdb_command", function(data: { message: any }) {
      Actions.add_console_entries(
        `Error occurred on server when running gdb command: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
      socket.close();
    });

    socket.on("server_error", function(data: { message: any }) {
      Actions.add_console_entries(
        `Server message: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
    });

    socket.on("debug_session_connection_event", function(gdb_pid_obj: {
      pid: number;
      message: string | void;
      ok: boolean;
      started_new_gdb_process: boolean;
    }) {
      const gdb_pid = gdb_pid_obj.pid;
      const message = gdb_pid_obj.message;
      const error = !gdb_pid_obj.ok;
      const started_new_gdb_process = gdb_pid_obj.started_new_gdb_process;

      if (message) {
        Actions.add_console_entries(
          message,
          error
            ? constants.console_entry_type.STD_ERR
            : constants.console_entry_type.GDBGUI_OUTPUT
        );
      }
      if (error) {
        socket.close();
        return;
      }
      store.set("gdb_pid", gdb_pid);

      if (started_new_gdb_process) {
        GdbApi.run_initial_commands();
      } else {
        Actions.refresh_state_for_gdb_pause();
      }
    });

    socket.on("disconnect", function() {
      // we no longer need to warn the user before they exit the page since the gdb process
      // on the server is already gone
      window.onbeforeunload = () => null;

      Actions.show_modal(
        "",
        <>
          <p>
            The connection to the gdb session has been closed. This tab will no longer
            function as expected.
          </p>
          <p className="font-bold">
            To start a new session or connect to a different session, go to the{" "}
            <a href="/dashboard">dashboard</a>.
          </p>
        </>
      );
      Actions.add_console_entries(
        `The connection to the gdb session has been closed. To start a new session, go to ${window.location.origin}/dashboard`,
        constants.console_entry_type.STD_ERR
      );

      // if (debug) {
      //   window.location.reload(true);
      // }
    });
  },
  _has_optimistic_resume: false,
  _waiting_for_response_timeout: null,
  _temp_payload_frame_line: undefined,
  // 當第一下按 step 並只是做 UI 往後推時，這個 flag 會被設為 true
  _optimistic_resume_pending: false,
  click_run_button: function() {
    Actions.inferior_program_starting();
    GdbApi.run_gdb_command("-exec-run");
  },
  run_initial_commands: function() {
    const cmds = ["-list-features", "-list-target-features"];
    for (const src in initial_data.remap_sources) {
      const dst = initial_data.remap_sources[src];
      cmds.push(`set substitute-path "${src}" "${dst}"`);
    }
    GdbApi.run_gdb_command(cmds);
  },
  inferior_is_paused: function() {
    return (
      [constants.inferior_states.unknown, constants.inferior_states.paused].indexOf(
        store.get("inferior_program")
      ) !== -1
    );
  },
  click_continue_button: function(reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-continue" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  _should_optimistic_resume: function() {
    try {
      const pausedEl = document.querySelector('.paused_on_line') as Element | null;
      if (!pausedEl) return false;

      const looksLikeClose = (text: string) => {
        const t = (text || "").trim();
        if (t === "") return false;
        return /^\s*[\}\)\]]/.test(t);
      };

      // 先嘗試以 tr.srccode 為單位：找 paused 行的最外層 tr，然後取下一個有 .srccode 的 tr
      const tr = (pausedEl as Element).closest('tr.srccode') || (pausedEl as Element).closest('tr');
      if (tr) {
        let next = tr.nextElementSibling as Element | null;
        while (next) {
          if (next.classList && next.classList.contains('srccode')) {
            // 找到下一個 srccode 行，檢查其 td.loc 的文字
            const loc = next.querySelector('td.loc');
            if (loc) {
              const txt = (loc.textContent || "").trim();
              return looksLikeClose(txt);
            }
            break;
          }
          next = next.nextElementSibling as Element | null;
        }
      }

      // fallback：遍歷 document 順序尋找下一個有內容的節點（保留之前的保險處理）
      const nextInDocument = (n: Node | null): Node | null => {
        if (!n) return null;
        if (n.firstChild) return n.firstChild;
        while (n) {
          if (n.nextSibling) return n.nextSibling;
          n = n.parentNode as Node | null;
        }
        return null;
      };

      let cur: Node | null = nextInDocument(pausedEl);
      while (cur) {
        if (pausedEl.contains(cur)) {
          cur = nextInDocument(cur);
          continue;
        }

        let txt = "";
        if (cur.nodeType === Node.TEXT_NODE) {
          txt = (cur.nodeValue || "").trim();
        } else if ((cur as Element).textContent !== undefined) {
          txt = ((cur as Element).textContent || "").trim();
        }

        if (txt !== "") {
          return looksLikeClose(txt);
        }

        cur = nextInDocument(cur);
      }

      return false;
    } catch (e) {
      console.error('_should_optimistic_resume error', e);
      return false;
    }
  },
  // 新增：清除先前樂觀移動的箭頭（只移除被標記過的）
  _clear_optimistic_arrow: function() {
    try {
      const moved = Array.from(document.querySelectorAll('[data-optimistic-moved="1"]'));
      let the_arrow_will_be_remove = null;
      // 若有 tr 帶有 srccode + paused_on_line，強制設為 class=""
      try {
        const leftovers = Array.from(document.querySelectorAll('tr.srccode.paused_on_line'));
        for (const t of leftovers) {
          the_arrow_will_be_remove = (t as HTMLElement);
          if ((t as Element).id === 'scroll_to_line') {
            (t as Element).removeAttribute('id');
          }
        }
        if (the_arrow_will_be_remove) {
          the_arrow_will_be_remove.className = "srccode";
        }
      } catch (e) {
        // ignore
      }
    } catch (e) {
      console.error('_clear_optimistic_arrow error', e);
    }
  },

  // 新增/修改：樂觀地把 paused_on_line 指標移到下一個 srccode 行
  _optimistically_advance_paused_line: function() {
    try {
      const pausedEl = document.querySelector('tr.srccode.paused_on_line') as Element | null
        || document.querySelector('.paused_on_line') as Element | null;
      if (!pausedEl) return;

      const tr = (pausedEl as Element).closest('tr') as Element | null;
      if (!tr) return;

      let next = tr.nextElementSibling as Element | null;
      while (next) {
        if (next.classList && next.classList.contains('srccode')) {
          break;
        }
        next = next.nextElementSibling as Element | null;
      }
      if (!next) return;

      // 移除舊的 paused_on_line，並加到下一行
      tr.classList.remove('paused_on_line');
      next.classList.add('paused_on_line');

      // 若原本有 scroll_to_line id，一併搬過去
      if (tr.id === 'scroll_to_line') {
        tr.removeAttribute('id');
        next.setAttribute('id', 'scroll_to_line');
      }

      // 嘗試把「顯示當前執行位置的箭頭」一併搬到下一行
      try {
        const arrowSelectors = [
          '#current_line_arrow',
          '.current-line-arrow',
          '.current_execution_arrow',
          '.exec_arrow',
          '.arrow_indicator',
          '.paused_arrow',
          '.current-arrow'
        ];
        for (const sel of arrowSelectors) {
          const arrow = document.querySelector(sel) as Element | null;
          if (arrow && tr.contains(arrow)) {
            // 標記為樂觀移動後再移動（以便稍後清除）
            arrow.setAttribute('data-optimistic-moved', '1');
            // 優先放到下一行的 td.loc，否則放到第一個 td
            const targetTd = (next.querySelector('td.loc') || next.querySelector('td')) as Element | null;
            if (targetTd) {
              targetTd.appendChild(arrow);
            } else {
              next.appendChild(arrow);
            }
            break;
          }
        }
      } catch (e) {
        // ignore arrow moving errors
      }

      // 保持下一行可見
      try {
        (next as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'auto' });
      } catch (e) {
        // ignore in non-browser env
      }
    } catch (e) {
      console.error('_optimistically_advance_paused_line error', e);
    }
  },
  click_next_button: function(reverse = false) {
    Visualizerhelper.log('CLICKNEXT');
    // - 第二次按僅定位不送gdb指令
    if (GdbApi._has_optimistic_resume) {
      GdbApi._optimistic_resume_pending = false;
      GdbApi._has_optimistic_resume = false;
      GdbApi._clear_optimistic_arrow();
      console.log(`實際上的行數為${GdbApi._temp_payload_frame_line}`);
      if (GdbApi._temp_payload_frame_line != undefined) {
        // 取消 suppress（避免其他邏輯阻止更新）
        store.set("suppress_paused_frame_update", false);
        // 取得目前 paused_on_frame（若無則建立最小 frame）
        const currentFrame = store.get("paused_on_frame") || {};
        // 設定為真實行（需為字串，以符合其他使用者程式）
        currentFrame.line = String(GdbApi._temp_payload_frame_line);
        // 傳 true 讓 Actions 實際更新 line_of_source_to_flash 與相關狀態
        Actions.inferior_program_paused(currentFrame, true);
        console.log(`快更新！暫存的行數為${GdbApi._temp_payload_frame_line}`);
        // 清掉暫存
        GdbApi._temp_payload_frame_line = undefined;
      }
      return;
    }
    // 若下一行第一個非空白字元是 '}'：
    // - 第一次按只做 UI 往後推（optimistic），送gdb指令
    if (GdbApi._should_optimistic_resume()) {
      if (!GdbApi._optimistic_resume_pending) {
        // Actions.inferior_program_resuming();
        GdbApi._optimistic_resume_pending = true;
        GdbApi._optimistically_advance_paused_line();
        GdbApi._has_optimistic_resume = true;
        Visualizerhelper.log('WAIT!');
        // 告訴前端在收到下一個 paused 回應時不要立刻用 payload 更新可見行
        store.set("suppress_paused_frame_update", true);
        GdbApi.run_gdb_command(
          "-exec-next" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
        );
        return;
      }
      Visualizerhelper.log('STEP!');
    }

    GdbApi.run_gdb_command(
      "-exec-next" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_step_button: function(reverse = false) {
    Visualizerhelper.log('CLICKSTEP');
    if (GdbApi._should_optimistic_resume()) {
      if (!GdbApi._optimistic_resume_pending) {
        Actions.inferior_program_resuming();
        GdbApi._optimistic_resume_pending = true;
        GdbApi._optimistically_advance_paused_line();
        Visualizerhelper.log('WAIT!');
        return;
      }
      Visualizerhelper.log('STEP!');
      GdbApi._optimistic_resume_pending = false;
      // GdbApi._clear_optimistic_arrow();
    }

    GdbApi.run_gdb_command(
      "-exec-step" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_return_button: function() {
    // From gdb mi docs (https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Program-Execution.html#GDB_002fMI-Program-Execution):
    // `-exec-return` Makes current function return immediately. Doesn't execute the inferior.
    // That means we do NOT dispatch the event `event_inferior_program_resuming`, because it's not, in fact, running.
    // The return also doesn't even indicate that it's paused, so we need to manually trigger the event here.
    GdbApi.run_gdb_command("-exec-return");
    Actions.inferior_program_paused();
  },
  click_next_instruction_button: function(reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-next-instruction" +
        (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_step_instruction_button: function(reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-step-instruction" +
        (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_send_interrupt_button: function() {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command("-exec-interrupt");
  },
  send_autocomplete_command: function(command: string) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command("complete " + command);
  },
  click_gdb_cmd_button: function(e: {
    currentTarget: { dataset: { [x: string]: any; cmd: undefined; cmd0: undefined } };
  }) {
    if (e.currentTarget.dataset.cmd !== undefined) {
      // run single command
      // i.e. <a data-cmd='cmd' />
      GdbApi.run_gdb_command(e.currentTarget.dataset.cmd);
    } else if (e.currentTarget.dataset.cmd0 !== undefined) {
      // run multiple commands
      // i.e. <a data-cmd0='cmd 0' data-cmd1='cmd 1' data-...>
      let cmds = [];
      let i = 0;
      let cmd = e.currentTarget.dataset[`cmd${i}`];
      // extract all commands into an array, then run them
      // (max of 100 commands)
      while (cmd !== undefined && i < 100) {
        cmds.push(cmd);
        i++;
        cmd = e.currentTarget.dataset[`cmd${i}`];
      }
      GdbApi.run_gdb_command(cmds);
    } else {
      console.error(
        "expected cmd or cmd0 [cmd1, cmd2, ...] data attribute(s) on element"
      );
    }
  },
  select_frame: function(framenum: any) {
    // TODO this command is deprecated (https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Stack-Manipulation.html)
    // This command in deprecated in favor of passing the ‘--frame’ option to every command.
    GdbApi.run_command_and_refresh_state(`-stack-select-frame ${framenum}`);
  },
  select_thread_id: function(thread_id: any) {
    // TODO this command is deprecated (http://www.sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Thread-Commands.html)
    // This command is deprecated in favor of explicitly using the ‘--thread’ option to each command.
    GdbApi.run_command_and_refresh_state(`-thread-select ${thread_id}`);
  },
  /**
   * Before sending a command, set a timeout to notify the user that something might be wrong
   * if a response from gdb is not received
   */
  waiting_for_response: function() {
    store.set("waiting_for_response", true);
    const WAIT_TIME_SEC = 10;
    // @ts-expect-error ts-migrate(2769) FIXME: Argument of type 'null' is not assignable to param... Remove this comment to see the full error message
    clearTimeout(GdbApi._waiting_for_response_timeout);
    // @ts-expect-error ts-migrate(2322) FIXME: Type 'Timeout' is not assignable to type 'null'.
    GdbApi._waiting_for_response_timeout = setTimeout(() => {
      Actions.clear_program_state();
      store.set("waiting_for_response", false);
      if (GdbApi.getSocket().disconnected) {
        return;
      }

      Actions.add_console_entries(
        `No gdb response received after ${WAIT_TIME_SEC} seconds.`,
        constants.console_entry_type.GDBGUI_OUTPUT
      );
      Actions.add_console_entries(
        "Possible reasons include:",
        constants.console_entry_type.GDBGUI_OUTPUT
      );
      Actions.add_console_entries(
        "1) gdbgui, gdb, or the debugged process is not running.",
        constants.console_entry_type.GDBGUI_OUTPUT
      );

      Actions.add_console_entries(
        "2) gdb or the inferior process is busy running and needs to be " +
          "interrupted (press the pause button up top).",
        constants.console_entry_type.GDBGUI_OUTPUT
      );

      Actions.add_console_entries(
        "3) Something is just taking a long time to finish and respond back to " +
          "this browser window, in which case you can just keep waiting.",
        constants.console_entry_type.GDBGUI_OUTPUT
      );
    }, WAIT_TIME_SEC * 1000);
  },
  /**
   * runs a gdb cmd (or commands) directly in gdb on the backend
   * validates command before sending, and updates the gdb console and status bar
   * @param cmd: a string or array of strings, that are directly evaluated by gdb
   * @return nothing
   */
  run_gdb_command: function(cmd: any) {
    // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
    if (_.trim(cmd) === "") {
      return;
    }

    let cmds = cmd;
    // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
    if (_.isString(cmds)) {
      cmds = [cmds];
    }

    if (socket.connected) {
      socket.emit("run_gdb_command", { cmd: cmds });
      GdbApi.waiting_for_response();
      // add the send command to the console to show commands that are
      // automatically run by gdb
      if (store.get("show_all_sent_commands_in_console")) {
        Actions.add_console_entries(cmds, constants.console_entry_type.SENT_COMMAND);
      }
    } else {
      log("queuing commands");
      const queuedGdbCommands = store.get("queuedGdbCommands").concat(cmds);
      store.set("queuedGdbCommands", queuedGdbCommands);
    }
  },
  run_command_and_refresh_state: function(user_cmd: string | any[]) {
    let cmds: any[] = [];
    if (Array.isArray(user_cmd)) {
      cmds = cmds.concat(user_cmd);
      // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
    } else if (_.isString(user_cmd) && user_cmd.length > 0) {
      cmds.push(user_cmd);
    }
    cmds = cmds.concat(GdbApi._get_refresh_state_for_pause_cmds());
    GdbApi.run_gdb_command(cmds);
  },
  backtrace: function() {
    let cmds = ["backtrace"];
    cmds = cmds.concat(GdbApi._get_refresh_state_for_pause_cmds());
    store.set("inferior_program", constants.inferior_states.paused);
    GdbApi.run_gdb_command(cmds);
  },
  /**
   * Get array of commands to send to gdb that refreshes everything in the
   * frontend
   */
  _get_refresh_state_for_pause_cmds: function(inclue_frames = true) {
    let cmds: string[] = []
    if (inclue_frames) {
      cmds = [
        // get info on current thread
        // TODO run -thread-list-ids to store list of thread id's and know
        // which thread is the current thread
        constants.IGNORE_ERRORS_TOKEN_STR + "-thread-info",
        // print the name, type and value for simple data types,
        // and the name and type for arrays, structures and unions.
        constants.IGNORE_ERRORS_TOKEN_STR + "-stack-list-variables --simple-values"
      ];
      // update all user-defined variables in gdb
      cmds.push(constants.IGNORE_ERRORS_TOKEN_STR + "-var-update --all-values *");
      // update registers
      cmds = cmds.concat(Registers.get_update_cmds());
      // re-fetch memory over desired range as specified by DOM inputs
      cmds = cmds.concat(Memory.get_gdb_commands_from_state());
      // refresh breakpoints
      cmds.push(GdbApi.get_break_list_cmd());
      // List the frames currently on the stack.
      // avoid the "no registers" error
      cmds.push(constants.IGNORE_ERRORS_TOKEN_STR + "-stack-list-frames");
    }
    return cmds;
  },
  refresh_breakpoints: function() {
    GdbApi.run_gdb_command([GdbApi.get_break_list_cmd()]);
  },
  get_inferior_binary_last_modified_unix_sec(path: any) {
    $.ajax({
      beforeSend: function(xhr: { setRequestHeader: (arg0: string, arg1: any) => void }) {
        xhr.setRequestHeader("x-csrftoken", initial_data.csrf_token);
      },
      url: "/get_last_modified_unix_sec",
      cache: false,
      method: "GET",
      data: { path: path },
      success: GdbApi._recieve_last_modified_unix_sec,
      error: GdbApi._error_getting_last_modified_unix_sec
    });
  },
  get_insert_break_cmd: function(fullname: any, line: any) {
    return [`-break-insert "${fullname}:${line}"`];
  },
  get_delete_break_cmd: function(bkpt_num: any) {
    return `-break-delete ${bkpt_num}`;
  },
  get_break_list_cmd: function() {
    return "-break-list";
  },
  get_load_binary_and_arguments_cmds(binary: any, args: any) {
    // tell gdb which arguments to use when calling the binary, before loading the binary
    let cmds = [
      `-exec-arguments ${args}`, // Set the inferior program arguments, to be used in the next `-exec-run`
      `-file-exec-and-symbols ${binary}` // Specify the executable file to be debugged. This file is the one from which the symbol table is also read.
    ];
    // add breakpoint if we don't already have one
    if (store.get("auto_add_breakpoint_to_main")) {
      cmds.push("-break-insert main");
    }
    cmds.push(GdbApi.get_break_list_cmd());
    return cmds;
  },
  set_assembly_flavor(flavor: string) {
    GdbApi.run_gdb_command(`set disassembly-flavor ${flavor}`);
  },
  _recieve_last_modified_unix_sec(data: { path: any; last_modified_unix_sec: any }) {
    if (data.path === store.get("inferior_binary_path")) {
      store.set(
        "inferior_binary_path_last_modified_unix_sec",
        data.last_modified_unix_sec
      );
    }
  },
  _error_getting_last_modified_unix_sec(data: any) {
    void data;
    store.set("inferior_binary_path", null);
  }
};
// @ts-expect-error ts-migrate(2339) FIXME: Property 'socket' does not exist on type '{ getSoc... Remove this comment to see the full error message
GdbApi.socket = socket;
export default GdbApi;
