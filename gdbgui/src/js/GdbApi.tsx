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
import { global_variable } from "./global_variable";
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
  log = function () {
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
let _pending_input_injection = false;
const GdbApi = {
  getSocket: function () {
    return socket;
  },
  init: function () {
    const TIMEOUT_MIN = 5;
    socket = io.connect(`/gdb_listener`, {
      timeout: TIMEOUT_MIN * 60 * 1000,
      query: {
        csrf_token: initial_data.csrf_token,
        gdbpid: initial_data.gdbpid,
        gdb_command: initial_data.gdb_command
      }
    });

    socket.on("connect", function () {
      log("connected");
      const queuedGdbCommands = store.get("queuedGdbCommands");
      if (queuedGdbCommands) {
        GdbApi.run_gdb_command(queuedGdbCommands);
        store.set("queuedGdbCommands", []);
      }
    });

    socket.on("gdb_response", function (response_array: any) {
      // @ts-expect-error ts-migrate(2769) FIXME: Argument of type 'null' is not assignable to param... Remove this comment to see the full error message
      clearTimeout(GdbApi._waiting_for_response_timeout);
      store.set("waiting_for_response", false);
      // console.log(`讀到的回傳陣列是${JSON.stringify(response_array)}`);
      process_gdb_response(response_array);
    });
    socket.on("fatal_server_error", function (data: { message: null | string }) {
      Actions.add_console_entries(
        `Message from server: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
      socket.close();
    });
    socket.on("error_running_gdb_command", function (data: { message: any }) {
      Actions.add_console_entries(
        `Error occurred on server when running gdb command: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
      socket.close();
    });

    socket.on("server_error", function (data: { message: any }) {
      Actions.add_console_entries(
        `Server message: ${data.message}`,
        constants.console_entry_type.STD_ERR
      );
    });

    socket.on("debug_session_connection_event", function (gdb_pid_obj: {
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

    socket.on("disconnect", function () {
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

    // State-driven input injection via polling:
    // When _pending_input_injection is set, poll every 300ms until the program pauses,
    // then inject the program_input to the PTY and stop polling.
    setInterval(() => {
      const state = store.get("inferior_program");
      if (_pending_input_injection) {
        console.log("[input-inject] polling: state=" + state + ", pending=" + _pending_input_injection);
      }
      if (_pending_input_injection && state === constants.inferior_states.paused) {
        _pending_input_injection = false;
        const input = store.get("program_input") || localStorage.getItem("gdbgui_program_input") || "";
        console.log("[input-inject] INJECTING input: '" + input + "'");
        if (input) {
          const s = GdbApi.getSocket();
          if (s && !s.disconnected) {
            s.emit("pty_interaction", {
              data: { pty_name: "program_pty", key: input + "\n", action: "write" }
            });
            console.log("[input-inject] Sent to PTY successfully");
          } else {
            console.log("[input-inject] Socket not available");
          }
        }
      }
    }, 300);
  },
  _waiting_for_response_timeout: null,
  click_run_button: function () {
    // 在使用者點擊的當下解鎖瀏覽器音訊上下文（Autoplay Policy）。
    // 若不這樣做，編譯 + GDB 啟動後音訊上下文仍處於 suspended 狀態，
    // 第一句 TTS 的開頭會被瀏覽器靜默延遲而聽不到。
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => ctx.close());
      } else {
        ctx.close();
      }
    } catch (_) {}

    // 按下 Run：切換至播放模式（隱藏 Guide/TTS 輸入欄）
    store.set("edit_mode", false);

    // 將 GDB 數字格式的 breakpoints (number="1","2"...) 轉為 frontend_* 格式，
    // 使 F5 重整後再次 Run 時能重新注入這些斷點（GDB 格式會被過濾掉不注入）
    {
      const bkpts = store.get("breakpoints") || [];
      const hasGdbNumbered = bkpts.some((b: any) => {
        const num = String(b.number);
        return !num.startsWith('frontend_') && b.fullname_to_display && b.is_normal_breakpoint !== false && !b.is_child_breakpoint;
      });
      if (hasGdbNumbered) {
        // Deduplicate by fullname:line — GDB accumulates breakpoints across runs,
        // so we may have 194 entries for only 2 unique locations after 97 runs.
        const seen = new Set<string>();
        const unique: any[] = [];
        // First pass: keep existing frontend_* entries (already unique) and unique GDB-numbered ones
        for (const b of bkpts) {
          const num = String(b.number);
          const isGdbNumbered = !num.startsWith('frontend_') && b.fullname_to_display && b.is_normal_breakpoint !== false && !b.is_child_breakpoint;
          if (isGdbNumbered) {
            const key = `${b.fullname_to_display}:${b.line}`;
            if (!seen.has(key)) {
              seen.add(key);
              unique.push(b);
            }
            // else: skip duplicate location
          } else {
            // non-normal breakpoints (child, already frontend_*): keep as-is but deduplicate frontend_* too
            if (num.startsWith('frontend_') && b.fullname_to_display) {
              const key = `${b.fullname_to_display}:${b.line}`;
              if (!seen.has(key)) {
                seen.add(key);
                unique.push(b);
              }
            } else {
              unique.push(b);
            }
          }
        }
        // Second pass: renumber all normal entries as frontend_*
        let idx = 1;
        const normalized = unique.map((b: any) => {
          if (b.fullname_to_display && b.is_normal_breakpoint !== false && !b.is_child_breakpoint) {
            return { ...b, number: `frontend_${idx++}` };
          }
          return b;
        });
        store.set("breakpoints", normalized);
        localStorage.setItem("breakpoints", JSON.stringify(normalized));
      }
    }

    // Check if we have editor content to save
    const getEditorValue = (window as any).gdbgui_get_editor_value;
    const getEditorFilename = (window as any).gdbgui_get_editor_filename;
    let code = getEditorValue ? getEditorValue() : null;
    const program_input = store.get("program_input") || "";

    // Fallback: if code is empty (e.g. Monaco editor unmounted after program exit/assembly view),
    // try to recover the last saved code from localStorage
    if (!code || code.trim() === "") {
      const fn = getEditorFilename ? getEditorFilename() : null;
      if (fn) {
        const savedCode = localStorage.getItem("gdbgui_editor_code_" + fn);
        if (savedCode && savedCode.trim() !== "") {
          code = savedCode;
        }
      }
      // If still no code, try to find any saved editor code in localStorage
      if (!code || code.trim() === "") {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("gdbgui_editor_code_")) {
            const savedCode = localStorage.getItem(key);
            if (savedCode && savedCode.trim() !== "") {
              code = savedCode;
              break;
            }
          }
        }
      }
    }

    if (code && code.trim() !== "") {
        // Cache the newly compiling code
        (window as any).last_compiled_code = code;

        const csrf_token = (window as any).initial_data.csrf_token;
        const getEditorFilename = (window as any).gdbgui_get_editor_filename;
        const filepath = getEditorFilename ? getEditorFilename() : null;

        Actions.add_console_entries(
          "Compiling and uploading code...",
          constants.console_entry_type.GDBGUI_OUTPUT
        );

        // Call create_and_upload endpoint
        $.ajax({
          url: "/create_and_upload",
          type: "POST",
          data: {
            code: code,
            filepath: filepath,
            program_input: program_input,
            csrf_token: csrf_token
          },
          headers: {
            "Accept": "application/json"
          },
          success: function (response: any) {
            console.log("Compile response:", response); // Browser console

            // Debug logging to GDBGUI console
            let responseType = typeof response;
            if (responseType === 'string') {
              const preview = response.substring(0, 100).replace(/\n/g, ' ');
              Actions.add_console_entries(
                `Debug: Received string response (likely HTML): "${preview}..."`,
                constants.console_entry_type.GDBGUI_OUTPUT
              );
            } else {
              Actions.add_console_entries(
                `Debug: Received JSON response: ${JSON.stringify(response)}`,
                constants.console_entry_type.GDBGUI_OUTPUT
              );
            }

            let binaryPath = null;
            let sourcePath: string | null = null;
            if (response && response.status === "success" && response.binary_path) {
              binaryPath = response.binary_path;
              sourcePath = response.source_path || null;
              // 儲存編譯後的實際源碼路徑，供「code unchanged」重啟時使用
              if (sourcePath) {
                (window as any).gdbgui_current_source_path = sourcePath;
              }
            } else if (typeof response === 'string') {
              // Fallback: HTML returned
              const match = response.match(/initial_data\s*=\s*({[\s\S]*?})\n/);
              if (match && match[1]) {
                try {
                  const initData = JSON.parse(match[1]);
                  if (initData.initial_binary_and_args && initData.initial_binary_and_args.length > 0) {
                    binaryPath = initData.initial_binary_and_args[0];
                    Actions.add_console_entries(
                      `Debug: Extracted binary path from HTML: ${binaryPath}`,
                      constants.console_entry_type.GDBGUI_OUTPUT
                    );
                  }
                } catch (e) {
                  console.error("Failed to parse initial_data from HTML", e);
                }
              }
            }
            if (global_variable) {
              (global_variable as any).__guide = new Map();
              (global_variable as any).__containers_guide = new Map();
              (global_variable as any).__source_code = null;
              (global_variable as any).__source_code_fullname = null;
            }

            // 顯示沙箱警告（若靜態分析偵測到危險呼叫）
            if (response && Array.isArray(response.sandbox_warnings) && response.sandbox_warnings.length > 0) {
              for (const warn of response.sandbox_warnings) {
                Actions.add_console_entries(warn, constants.console_entry_type.STD_ERR);
              }
            }

            if (binaryPath) {
              Actions.add_console_entries(
                `Compilation successful. Loading binary: ${binaryPath}`,
                constants.console_entry_type.GDBGUI_OUTPUT
              );

              // Reload binary and run
              let cmds: string[] = [
                "-interpreter-exec console \"delete\"",
                `-file-exec-and-symbols ${binaryPath}`,
                store.get("auto_add_breakpoint_to_main") ? "-break-insert main" : ""
              ];

              // Insert frontend breakpoints — use actual source path to avoid GDB recording bare filename in DWARF
              let bkpts = store.get("breakpoints") || [];
              // Deduplicate by fullname:line before injection
              {
                const seen = new Set<string>();
                const deduped = bkpts.filter((b: any) => {
                  if (!(typeof b.number === 'string' && b.number.startsWith('frontend_'))) return true;
                  const key = `${b.fullname_to_display}:${b.line}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                if (deduped.length !== bkpts.length) {
                  bkpts = deduped;
                  store.set("breakpoints", bkpts);
                  localStorage.setItem("breakpoints", JSON.stringify(bkpts));
                }
              }
              let frontend_bkpts = bkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));
              for (let b of frontend_bkpts) {
                let cmd = "-break-insert -f";
                if (b.enabled !== "y") {
                  cmd += " -d";
                }
                if (b.cond) {
                  cmd += ` -c "${b.cond}"`;
                }
                const targetFile = sourcePath || (window as any).gdbgui_current_source_path || b.fullname_to_display;
                cmd += ` "${targetFile}:${b.line}"`;
                cmds.push(cmd);
              }
              // Remove frontend breakpoints from store so they don't duplicate when GDB returns real ones
              store.set("breakpoints", bkpts.filter((b: any) => !(typeof b.number === 'string' && b.number.startsWith('frontend_'))));

              cmds = cmds.concat([
                "-break-list",
                "-exec-run"
              ]).filter((c: string) => c !== "");

              // Clear Visualizer panel state
              if (global_variable) {
                (global_variable as any).__guide = new Map();
                (global_variable as any).__containers_guide = new Map();
                (global_variable as any).__source_code = null;
                (global_variable as any).__source_code_fullname = null;
              }

              GdbApi.run_gdb_command(cmds);

              _pending_input_injection = true; // will inject when program first pauses

              Actions.inferior_program_starting();
            } else {
              Actions.add_console_entries(
                "Error: Compilation succeeded but no binary path returned.",
                constants.console_entry_type.STD_ERR
              );
            }
          },
          error: function (xhr: any) {
            let msg = "Unknown error during compilation.";
            if (xhr.responseJSON && xhr.responseJSON.message) {
              msg = xhr.responseJSON.message;
            } else if (xhr.responseText) {
              try {
                const r = JSON.parse(xhr.responseText);
                if (r.message) msg = r.message;
              } catch (e) { }
            }
            Actions.add_console_entries(
              `Compilation failed: ${msg}`,
              constants.console_entry_type.STD_ERR
            );
            if (xhr.responseJSON && xhr.responseJSON.stderr) {
              Actions.add_console_entries(
                xhr.responseJSON.stderr,
                constants.console_entry_type.STD_ERR
              );
            }
          }
        });
        return;
      }

    // Fallback if no editor logic
    Actions.inferior_program_starting();
    GdbApi.run_gdb_command("-exec-run");
  },
  run_initial_commands: function () {
    Object.keys(global_variable).forEach(key => {
      if (key !== "__line" && key !== "__tts") {
        delete (global_variable as any)[key];
      }
    });
    const cmds = ["-list-features", "-list-target-features"];
    for (const src in initial_data.remap_sources) {
      const dst = initial_data.remap_sources[src];
      cmds.push(`set substitute-path "${src}" "${dst}"`);
    }
    GdbApi.run_gdb_command(cmds);
  },
  inferior_is_paused: function () {
    return (
      [constants.inferior_states.unknown, constants.inferior_states.paused].indexOf(
        store.get("inferior_program")
      ) !== -1
    );
  },
  click_continue_button: function (reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-continue" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_next_button: function (reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-next" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_step_button: function (reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-step" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_return_button: function () {
    // Modified: Previously ran `-exec-return` and `Actions.inferior_program_paused();`
    // which caused a race condition and React UI crashes (black screen) because `paused`
    // was forcefully triggered before GDB replied. Now uses the proper Step Out
    // implementation `-exec-finish` which executes the rest of the frame.
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command("-exec-finish");
  },
  click_next_instruction_button: function (reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-next-instruction" +
      (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_step_instruction_button: function (reverse = false) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-step-instruction" +
      (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_send_interrupt_button: function () {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command("-exec-interrupt");
  },
  send_autocomplete_command: function (command: string) {
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command("complete " + command);
  },
  click_gdb_cmd_button: function (e: {
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
  select_frame: function (framenum: any) {
    // TODO this command is deprecated (https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Stack-Manipulation.html)
    // This command in deprecated in favor of passing the ‘--frame’ option to every command.
    GdbApi.run_command_and_refresh_state(`-stack-select-frame ${framenum}`);
  },
  select_thread_id: function (thread_id: any) {
    // TODO this command is deprecated (http://www.sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Thread-Commands.html)
    // This command is deprecated in favor of explicitly using the ‘--thread’ option to each command.
    GdbApi.run_command_and_refresh_state(`-thread-select ${thread_id}`);
  },
  /**
   * Before sending a command, set a timeout to notify the user that something might be wrong
   * if a response from gdb is not received
   */
  waiting_for_response: function () {
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
  run_gdb_command: function (cmd: any) {
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
      console.log(`傳送封包到伺服器${JSON.stringify(cmd)}`);
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
  run_command_and_refresh_state: function (user_cmd: string | any[]) {
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
  backtrace: function () {
    let cmds = ["backtrace"];
    cmds = cmds.concat(GdbApi._get_refresh_state_for_pause_cmds());
    store.set("inferior_program", constants.inferior_states.paused);
    GdbApi.run_gdb_command(cmds);
  },
  /**
   * Get array of commands to send to gdb that refreshes everything in the
   * frontend
   */
  _get_refresh_state_for_pause_cmds: function () {
    let cmds = [
      // get info on current thread
      // TODO run -thread-list-ids to store list of thread id's and know
      // which thread is the current thread
      constants.IGNORE_ERRORS_TOKEN_STR + "-thread-info",
      // print the name, type and value for simple data types,
      // and the name and type for arrays, structures and unions.
      constants.IGNORE_ERRORS_TOKEN_STR + "-stack-list-variables --simple-values",
      // Fetch arguments for all frames
      constants.IGNORE_ERRORS_TOKEN_STR + "-stack-list-arguments 1"
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
    return cmds;
  },
  refresh_breakpoints: function () {
    GdbApi.run_gdb_command([GdbApi.get_break_list_cmd()]);
  },
  get_inferior_binary_last_modified_unix_sec(path: any) {
    $.ajax({
      beforeSend: function (xhr: { setRequestHeader: (arg0: string, arg1: any) => void }) {
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
  get_insert_break_cmd: function (fullname: any, line: any) {
    return [`-break-insert "${fullname}:${line}"`];
  },
  get_delete_break_cmd: function (bkpt_num: any) {
    return `-break-delete ${bkpt_num}`;
  },
  get_break_list_cmd: function () {
    return "-break-list";
  },
  get_load_binary_and_arguments_cmds(binary: any, args: any) {
    // tell gdb which arguments to use when calling the binary, before loading the binary
    let cmds: string[] = [
      `-exec-arguments ${args}`, // Set the inferior program arguments, to be used in the next `-exec-run`
      `-file-exec-and-symbols ${binary}` // Specify the executable file to be debugged. This file is the one from which the symbol table is also read.
    ];
    // add breakpoint if we don't already have one
    if (store.get("auto_add_breakpoint_to_main")) {
      cmds.push("-break-insert main");
    }

    let bkpts = store.get("breakpoints") || [];
    let frontend_bkpts = bkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));
    for (let b of frontend_bkpts) {
      let cmd = "-break-insert -f";
      if (b.enabled !== "y") cmd += " -d";
      if (b.cond) cmd += ` -c "${b.cond}"`;
      cmd += ` "${b.fullname_to_display}:${b.line}"`;
      cmds.push(cmd);
    }
    store.set("breakpoints", bkpts.filter((b: any) => !(typeof b.number === 'string' && b.number.startsWith('frontend_'))));

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

// 自動播放指令執行器：由 VisualizerHelper 在 TTS 結束後呼叫
(window as any).gdbgui_execute_autoplay_command = (command: string) => {
  const delay: number = (window as any).gdbgui_autoplay_delay ?? 600;
  setTimeout(() => {
    // 再次確認自動播放仍啟用（使用者可能在 TTS 播放中途關閉）
    if (!store.get("autoplay_enabled")) return;
    // 若目前處於暫停狀態，儲存指令等待恢復後執行
    if (store.get("autoplay_paused")) {
      store.set("autoplay_pending_command", command);
      return;
    }
    (window as any).gdbgui_run_autoplay_command(command);
  }, delay);
};

// 從中斷點繼續播放 TTS，若有恢復資訊則播放並回傳 true，否則回傳 false
(window as any).gdbgui_resume_tts = (): boolean => {
  const resume = (window as any)._gdbgui_tts_resume;
  if (!resume || !resume.url) return false;
  (window as any)._gdbgui_tts_resume = null;

  // 恢復播放狀態，讓字幕顯示正確文字
  (window as any)._gdbgui_tts_playing = {
    fullText: resume.fullText ?? '',
    subtitleText: resume.fullText ?? '',
    autoplayCommand: resume.autoplayCommand,
    lastCharIndex: 0,
  };
  store.set("tts_subtitle", { text: resume.fullText ?? '', line: null, timestamp: Date.now() });

  // 使用 audio API 從暫停點繼續
  (window as any)._tts_api?.resume(
    { url: resume.url, currentTime: resume.currentTime },
    resume.autoplayCommand
  );
  return true;
};

// 執行自動播放指令（供暫停恢復時呼叫）
(window as any).gdbgui_run_autoplay_command = (command: string) => {
  switch (command) {
    case "next":     GdbApi.click_next_button();     break;
    case "step-in":  GdbApi.click_step_button();     break;
    case "step-out": GdbApi.click_return_button();   break;
    case "continue": GdbApi.click_continue_button(); break;
  }
};
export default GdbApi;
