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
import { buildGhostFromSnapshots } from "./ghostTree";
import { isFastForwarding } from "./fastForward";
import { isQuizPlaybackBlocked } from "./lessonQuizRuntime";
import { armStepWatchdog } from "./stepWatchdog";

/**
 * 步進命令送出後掛上看門狗。逾時仍在 running 就是 GDB 卡死了（見 stepWatchdog.ts），
 * 關掉自動播放並告知使用者，而不是讓整個介面靜默變磚。
 */
function watchStep(command: string) {
  armStepWatchdog(command, {
    isStillRunning: () =>
      store.get("inferior_program") === constants.inferior_states.running,
    onWedged: (cmd, seconds) => {
      store.set("autoplay_enabled", false);
      store.set("autoplay_pending_command", null);
      const message =
        `除錯器對「${cmd}」超過 ${seconds} 秒沒有回應，這個除錯階段已經無法繼續。\n\n` +
        `自動播放已停止。請重新載入頁面或重新啟動除錯階段；\n` +
        `若教案在 main 開頭就宣告 STL 容器，重跑很可能會再次卡在同一行。`;
      // console 面板可能是收合的，光寫進去使用者不一定看得到——而這是「整個階段
      // 已經死掉」的狀態，必須擋不掉。
      Actions.add_console_entries(message, constants.console_entry_type.STD_ERR);
      window.alert(message);
    },
  });
}

/** Parse GCC/Clang stderr into structured error objects. */
function _parseCompileErrors(stderr: string): any[] {
  if (!stderr) return [];
  const re = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/;
  const result: any[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(re);
    if (m) {
      result.push({
        file: m[1],
        line: parseInt(m[2]),
        col: parseInt(m[3]),
        severity: m[4],
        message: m[5].trim(),
      });
    }
  }
  return result;
}
void React; // needed when using JSX, but not marked as used
/* global debug */

// 自動播放時，for 迴圈的虛步（條件段 B）停留多久才自己接續下一步。
// 與現有動畫結果停留時間一致。
const FOR_SUBSTEP_DWELL_MS = 800;

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
let _injection_start_time = 0;
let _next_request_id = 1;
let _response_packet_buffer: any[] = [];
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

    socket.on("gdb_response", function (packet: any) {
      // @ts-expect-error ts-migrate(2769) FIXME: Argument of type 'null' is not assignable to param... Remove this comment to see the full error message
      clearTimeout(GdbApi._waiting_for_response_timeout);
      store.set("waiting_for_response", false);

      // Server wraps responses as {run_token, data}. Validate token and extract data.
      let response_array: any;
      let req_id = 0;
      let pkt_seq = 0;
      if (packet && !Array.isArray(packet) && typeof packet === "object" && "data" in packet) {
        const expected = store.get("run_token");
        if (expected !== null && packet.run_token !== expected) {
          // Stale response from a previous run — discard.
          //
          // 不再靜默：run_token 是 debug session 層級的單一值，卻被最後一個
          // 送命令的 client 覆寫（app.py 的 debug_session.run_token = client_token）。
          // 同一個帳號掛著兩個 client 時，回應會被蓋上其中一個的章，另一個就把
          // 完全合法的回應丟掉，畫面卡住卻沒有任何線索。
          console.warn(
            `[gdb_response] 丟棄回應：run_token 不符 (收到 ${packet.run_token} / 預期 ${expected})，` +
              `request_id=${packet.request_id}`
          );
          return;
        }
        response_array = packet.data;
        req_id = typeof packet.request_id === 'number' ? packet.request_id : 0;
        pkt_seq = typeof packet.packet_seq_num === 'number' ? packet.packet_seq_num : 0;
      } else {
        // Fallback for legacy/pre-token packets
        response_array = packet;
      }

      // 將封包存入緩衝區並優先處理序號較前的封包
      _response_packet_buffer.push({
        req_id,
        pkt_seq,
        response_array,
      });

      // 依照 request_id 升冪排序，若相同則依照 packet_seq_num 升冪排序
      _response_packet_buffer.sort((a, b) => {
        if (a.req_id !== b.req_id) return a.req_id - b.req_id;
        return a.pkt_seq - b.pkt_seq;
      });

      // 依序處理排在前面的所有封包
      while (_response_packet_buffer.length > 0) {
        const nextPacket = _response_packet_buffer.shift();
        process_gdb_response(nextPacket.response_array);
      }
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
    // When _pending_input_injection is set, poll every 300ms.
    // Inject when paused (hit a breakpoint) OR when still running after
    // STDIN_INJECT_DELAY_MS — the latter handles programs that block on
    // stdin before reaching any breakpoint.
    const STDIN_INJECT_DELAY_MS = 800;

    const doInject = () => {
      _pending_input_injection = false;
      const input = store.get("program_input") || localStorage.getItem("gdbgui_program_input") || "";
      console.log("[input-inject] INJECTING input: '" + input + "'");
      const s = GdbApi.getSocket();
      if (s && !s.disconnected) {
        // Flush leftover data from previous run before writing new input.
        // Socket.IO delivers messages in order, so flush arrives before write.
        s.emit("pty_interaction", {
          data: { pty_name: "program_pty", action: "flush" }
        });
      }
      if (input) {
        if (s && !s.disconnected) {
          s.emit("pty_interaction", {
            data: { pty_name: "program_pty", key: input + "\n\x04", action: "write" }
          });
          console.log("[input-inject] Sent to PTY successfully");
        } else {
          console.log("[input-inject] Socket not available");
        }
      }
    };

    setInterval(() => {
      const state = store.get("inferior_program");
      if (_pending_input_injection) {
        console.log("[input-inject] polling: state=" + state + ", pending=" + _pending_input_injection);
        if (state === constants.inferior_states.paused) {
          // Program hit a breakpoint — inject immediately.
          doInject();
        } else if (state === constants.inferior_states.running &&
                   Date.now() - _injection_start_time >= STDIN_INJECT_DELAY_MS) {
          // Program is still running after the delay — likely blocked on stdin.
          doInject();
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

    // Synchronously flush Monaco editor content to localStorage before switching modes.
    // The auto-save is debounced 300ms; if Run is clicked quickly, or if fullname_to_render=""
    // (NONE_AVAILABLE state), the current code would be lost on compile error.
    try {
      const _editorVal: string = (window as any).gdbgui_get_editor_value?.() || "";
      if (_editorVal.trim()) {
        const _currentFn: string = store.get("fullname_to_render") || "";
        const _userSrc: string = store.get("user_source_fullname") || "";
        const _saveKey = _currentFn || _userSrc;
        if (_saveKey) {
          localStorage.setItem("gdbgui_editor_code_" + _saveKey, _editorVal);
          localStorage.setItem("gdbgui_editor_filename_" + _saveKey, _saveKey);
        }
        // Always keep last-edited so NONE_AVAILABLE fallback works
        localStorage.setItem("gdbgui_last_edited_filename", _saveKey || "__pending__");
        if (!_saveKey) {
          localStorage.setItem("gdbgui_editor_code___pending__", _editorVal);
          localStorage.setItem("gdbgui_editor_filename___pending__", "__pending__");
        }
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
            // Clear any previous compile errors on successful compile
            store.set("compile_errors", []);
            const registry = (window as any).gdbgui_collapser_registry || {};
            if (registry["compile_errors"]) registry["compile_errors"].close();

            let binaryPath = null;
            let sourcePath: string | null = null;   // virtual display path (/workspace/main.cpp)
            let gdbSourcePath: string | null = null; // real filesystem path (for GDB commands)
            let execWrapper: string = "";
            let gdbSubstCmd: string = "";
            if (response && response.status === "success" && response.binary_path) {
              binaryPath = response.binary_path;
              sourcePath = response.source_path || null;
              gdbSourcePath = response.gdb_source_path || sourcePath;
              execWrapper = response.exec_wrapper || "";
              gdbSubstCmd = response.gdb_subst_cmd || "";
              // Store real source path for GDB operations (breakpoint insertion, re-runs)
              if (gdbSourcePath) {
                (window as any).gdbgui_real_source_path = gdbSourcePath;
                localStorage.setItem("gdbgui_gdb_source_path", gdbSourcePath);
              }
              // Store real source path for GDB "code unchanged" re-run
              if (gdbSourcePath) {
                (window as any).gdbgui_current_source_path = gdbSourcePath;
              }
              // Persist substitute-path so F5 reload can configure the new GDB session
              if (gdbSubstCmd) {
                localStorage.setItem("gdbgui_gdb_subst_cmd", gdbSubstCmd);
              }
              // Virtual display path is the single source of truth for UI state keying
              if (sourcePath) {
                store.set("user_source_fullname", sourcePath);
              }
              // Store the run token so it can be attached to every GDB command and
              // validated against every GDB response.
              if (response.run_token) {
                store.set("run_token", response.run_token);
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
              (global_variable as any).__rbtree_data = {};
              // __source_code is intentionally kept so Visualizer stays visible during run
            }

            // 顯示沙箱警告（若靜態分析偵測到危險呼叫）
            if (response && Array.isArray(response.sandbox_warnings) && response.sandbox_warnings.length > 0) {
              for (const warn of response.sandbox_warnings) {
                Actions.add_console_entries(warn, constants.console_entry_type.STD_ERR);
              }
            }

            if (binaryPath) {
              Actions.add_console_entries(
                `Compilation successful. Source: ${sourcePath || binaryPath}`,
                constants.console_entry_type.GDBGUI_OUTPUT
              );

              // Reload binary and run
              const safeBinaryPath = binaryPath.replace(/\\/g, '/');
              const safeWrapper = execWrapper.replace(/\\/g, '/');
              let cmds: string[] = [
                "-interpreter-exec console \"delete\"",
                // Clear any previous exec-wrapper before loading the new binary
                "-gdb-set exec-wrapper \"\"",
                `-file-exec-and-symbols "${safeBinaryPath}"`,
                // Clear any stale substitute-path rules from previous sessions, then apply new one
                `-interpreter-exec console "unset substitute-path"`,
                gdbSubstCmd ? `-interpreter-exec console "${gdbSubstCmd}"` : "",
                // Set chroot exec-wrapper so every -exec-run spawns the inferior inside the jail
                safeWrapper ? `-gdb-set exec-wrapper "${safeWrapper}"` : "",
                store.get("auto_add_breakpoint_to_main") ? "-break-insert -f main" : ""
              ];

              // Breakpoints are editor markers decoupled from any specific binary.
              // Drop GDB-confirmed numeric entries (ephemeral); keep only frontend_* (persistent markers).
              {
                const allBkpts = store.get("breakpoints") || [];
                const frontendOnly = allBkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));
                if (frontendOnly.length !== allBkpts.length) {
                  store.set("breakpoints", frontendOnly);
                  localStorage.setItem("breakpoints", JSON.stringify(frontendOnly));
                }
              }

              // De-duplicate frontend_* by line number, then filter out-of-bounds lines.
              let bkpts = store.get("breakpoints") || [];
              {
                const seen = new Set<number>();
                const deduped = bkpts.filter((b: any) => {
                  if (!(typeof b.number === 'string' && b.number.startsWith('frontend_'))) return true;
                  const ln = parseInt(b.line);
                  if (seen.has(ln)) return false;
                  seen.add(ln);
                  return true;
                });
                if (deduped.length !== bkpts.length) {
                  bkpts = deduped;
                  store.set("breakpoints", bkpts);
                  localStorage.setItem("breakpoints", JSON.stringify(bkpts));
                }
              }
              let frontend_bkpts = bkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));

              // Remove frontend breakpoints beyond the current file's line count to avoid
              // GDB relocating them all to the last line and creating phantom breakpoints.
              try {
                const _ev: string = (window as any).gdbgui_get_editor_value?.() || "";
                const _lineCount = _ev ? _ev.split(/\r?\n/).length : 0;
                if (_lineCount > 0) {
                  const _inBounds = frontend_bkpts.filter((b: any) => parseInt(b.line) <= _lineCount);
                  if (_inBounds.length !== frontend_bkpts.length) {
                    const _outNums = new Set(frontend_bkpts.filter((b: any) => parseInt(b.line) > _lineCount).map((b: any) => b.number));
                    bkpts = bkpts.filter((b: any) => !_outNums.has(b.number));
                    store.set("breakpoints", bkpts);
                    localStorage.setItem("breakpoints", JSON.stringify(bkpts));
                    frontend_bkpts = _inBounds;
                  }
                }
              } catch (_) {}

              for (let b of frontend_bkpts) {
                let cmd = "-break-insert -f";
                if (b.enabled !== "y") cmd += " -d";
                if (b.cond) cmd += ` -c "${b.cond}"`;
                // Use real filesystem path for GDB breakpoint insertion (virtual path not in DWARF)
                const targetFile = gdbSourcePath || (window as any).gdbgui_real_source_path || b.fullname_to_display;
                cmd += ` "${targetFile.replace(/\\/g, '/')}:${b.line}"`;
                cmds.push(cmd);
              }
              // frontend_* breakpoints are kept in the store — they are persistent editor markers.

              cmds = cmds.concat([
                "-break-list",
                "-exec-run"
              ]).filter((c: string) => c !== "");

              // Clear per-run state; keep __source_code so Visualizer stays visible
              if (global_variable) {
                (global_variable as any).__guide = new Map();
                (global_variable as any).__containers_guide = new Map();
                (global_variable as any).__rbtree_data = {};
                (global_variable as any).__visited_lines = new Set<number>();
                (global_variable as any).__line_visit_count = {};
              }

              // Ghost pre-run: fetch the complete call tree so layout never shifts (spec F7).
              const gv0 = (window as any).gdbgui_global_variable;
              if (gv0) gv0.__ghost = null;
              // Every POST is CSRF-checked in a global before_request; the token
              // must ride in the x-csrftoken header (same as create_and_upload,
              // FileOps, Actions). Without it the request 415s on request.json
              // and the ghost silently never loads.
              fetch("/api/prerun_calltree", {
                method: "POST",
                credentials: "same-origin",
                headers: { "x-csrftoken": (window as any).initial_data.csrf_token },
              })
                .then(r => (r.ok ? r.json() : null))
                .then(data => {
                  const gv = (window as any).gdbgui_global_variable;
                  if (!gv || !data || !data.ok) return;
                  const ghost = buildGhostFromSnapshots(data.snapshots);
                  if (ghost) {
                    gv.__ghost = ghost;
                    store.set("call_graph_updated", Date.now());
                  }
                })
                .catch(() => { /* graceful fallback: live layout */ });

              GdbApi.run_gdb_command(cmds);

              _pending_input_injection = true;
              _injection_start_time = Date.now();

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
            const stderr = (xhr.responseJSON && xhr.responseJSON.stderr) ? xhr.responseJSON.stderr : "";
            if (stderr) {
              Actions.add_console_entries(stderr, constants.console_entry_type.STD_ERR);
            }
            // Parse structured errors and store them; auto-open the error panel
            const errors = _parseCompileErrors(stderr);
            store.set("compile_errors", errors);
            if (errors.length > 0) {
              const registry = (window as any).gdbgui_collapser_registry || {};
              if (registry["compile_errors"]) registry["compile_errors"].open();
            }
            // Return to edit mode so the user sees their code (with error markers), not "no source code"
            store.set("edit_mode", true);
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
      if (key !== "__line" && key !== "__tts" && key !== "__layout") {
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
    if (isQuizPlaybackBlocked(store)) return;
    Actions.inferior_program_resuming();
    GdbApi.run_gdb_command(
      "-exec-continue" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  // for 迴圈三段式單步：A/C 已經是真正的 GDB 停駐點，B（條件段）沒有對應的
  // 停駐位址，所以做成 UI 虛步——這一次點擊只換高亮、不送 -exec-next，再點一次
  // 才真的走。反向單步完全跳過這個機制。
  //
  // opts.autoplay：自動播放模式下，虛步不會產生 GDB pause → 不會觸發新的 TTS →
  // 沒有人排下一個命令，播放會卡死。所以被虛步消耗掉的那一次要自己排接續。
  // 手動點擊不排接續（使用者自己按下一步）。
  click_next_button: function (reverse = false, opts: { autoplay?: boolean } = {}) {
    if (isQuizPlaybackBlocked(store)) return;
    // 快轉期間完全繞過 for 虛步：否則每個 for 行要多花一個虛步（多一次 dwell），
    // B 段高亮還會在無聲快轉中閃爍。
    if (!reverse && !store.get("debug_in_reverse") && !isFastForwarding()) {
      const sub = store.get("for_sub_step");
      if (sub && (sub.seg === "A" || sub.seg === "C")) {
        // 虛步：只換高亮，不送 GDB 命令
        store.set("for_sub_step", { line: sub.line, seg: "B" });
        if (opts.autoplay) {
          setTimeout(() => {
            // 停留期間使用者可能關掉或暫停自動播放，比照 gdbgui_execute_autoplay_command
            if (!store.get("autoplay_enabled")) return;
            if (store.get("autoplay_paused")) {
              store.set("autoplay_pending_command", "next");
              return;
            }
            GdbApi.click_next_button(false, { autoplay: true });
          }, FOR_SUBSTEP_DWELL_MS);
        }
        return;
      }
      // 目前是 B → 清空，送出真正的 -exec-next（下一個 pause 會重算段落）
      if (sub) {
        store.set("for_sub_step", null);
      }
    }
    Actions.inferior_program_resuming();
    watchStep("下一步");
    GdbApi.run_gdb_command(
      "-exec-next" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_step_button: function (reverse = false) {
    if (isQuizPlaybackBlocked(store)) return;
    Actions.inferior_program_resuming();
    watchStep("步入");
    GdbApi.run_gdb_command(
      "-exec-step" + (store.get("debug_in_reverse") || reverse ? " --reverse" : "")
    );
  },
  click_return_button: function () {
    if (isQuizPlaybackBlocked(store)) return;
    // Modified: Previously ran `-exec-return` and `Actions.inferior_program_paused();`
    // which caused a race condition and React UI crashes (black screen) because `paused`
    // was forcefully triggered before GDB replied. Now uses the proper Step Out
    // implementation `-exec-finish` which executes the rest of the frame.
    Actions.inferior_program_resuming();
    watchStep("步出");
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
      const current_request_id = _next_request_id++;
      console.log(`傳送封包到伺服器${JSON.stringify(cmd)} (request_id: ${current_request_id})`);
      socket.emit("run_gdb_command", { cmd: cmds, run_token: store.get("run_token"), request_id: current_request_id });
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
      // List the frames currently on the stack.
      // MUST come before -stack-list-variables: MI responses arrive FIFO, and
      // Threads.update_stack (driven by this response) advances gv.__active_path
      // and freezes returning nodes' retValue from their still-clean lastResult.
      // If -stack-list-variables' response were ingested first, Locals.save_locals
      // would attribute the new (parent) frame's locals to the stale __active_path
      // from the previous pause, clobbering a child node's lastResult right before
      // it gets frozen as retValue (see callTree.ts ingestStack/recordResultLocal).
      constants.IGNORE_ERRORS_TOKEN_STR + "-stack-list-frames",
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

    // Restore substitute-path from previous compile so GDB can resolve virtual paths
    // (lost on F5 since the compile AJAX response only sets it as a window property)
    const _savedSubstCmd = localStorage.getItem("gdbgui_gdb_subst_cmd");
    if (_savedSubstCmd) {
      cmds.push(`-interpreter-exec console "unset substitute-path"`);
      cmds.push(`-interpreter-exec console "${_savedSubstCmd}"`);
    }

    // add breakpoint if we don't already have one
    if (store.get("auto_add_breakpoint_to_main")) {
      cmds.push("-break-insert -f main");
    }

    // Drop GDB-confirmed numeric breakpoints (ephemeral); keep only frontend_* (persistent markers).
    {
      const allBkpts = store.get("breakpoints") || [];
      const frontendOnly = allBkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));
      if (frontendOnly.length !== allBkpts.length) {
        store.set("breakpoints", frontendOnly);
        localStorage.setItem("breakpoints", JSON.stringify(frontendOnly));
      }
    }

    let bkpts = store.get("breakpoints") || [];
    const frontend_bkpts = bkpts.filter((b: any) => typeof b.number === 'string' && b.number.startsWith('frontend_'));

    // Prefer real filesystem path for GDB (virtual /workspace paths are not in DWARF)
    const _realSrcForBkpt = (window as any).gdbgui_real_source_path
      || localStorage.getItem("gdbgui_gdb_source_path")
      || "";
    for (let b of frontend_bkpts) {
      let cmd = "-break-insert -f";
      if (b.enabled !== "y") cmd += " -d";
      if (b.cond) cmd += ` -c "${b.cond}"`;
      const bkptFile = _realSrcForBkpt || b.fullname_to_display;
      cmd += ` "${bkptFile.replace(/\\/g, '/')}:${b.line}"`;
      cmds.push(cmd);
    }
    // frontend_* breakpoints are kept in the store — they are persistent editor markers.

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
  if (isQuizPlaybackBlocked(store)) return;
  // 快轉時零延遲：GDB round trip 本身就是這個模式唯一的成本，不再額外等停頓
  const delay: number = isFastForwarding() ? 0 : ((window as any).gdbgui_autoplay_delay ?? 600);
  setTimeout(async () => {
    if (isQuizPlaybackBlocked(store)) return;
    // 再次確認自動播放仍啟用（使用者可能在 TTS 播放中途關閉）
    if (!store.get("autoplay_enabled")) return;
    // 若目前處於暫停狀態，儲存指令等待恢復後執行
    if (store.get("autoplay_paused")) {
      store.set("autoplay_pending_command", command);
      return;
    }
    // 等待 BST 插入比對動畫完成，再繼續執行 GDB 指令
    const barrier = (window as any).gdbgui_bst_anim_done as Promise<void> | null | undefined;
    if (barrier) await barrier;
    if (isQuizPlaybackBlocked(store)) return;
    // 動畫結束後再次確認狀態（使用者可能在動畫期間關閉 autoplay 或暫停）
    if (!store.get("autoplay_enabled")) return;
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
    subtitleText: resume.subtitleText ?? resume.fullText ?? '',
    autoplayCommand: resume.autoplayCommand,
    lastCharIndex: 0,
  };
  store.set("tts_subtitle", { text: resume.subtitleText ?? resume.fullText ?? '', line: null, timestamp: Date.now() });

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
    // autoplay: true —— for 虛步不會產生 GDB pause，被虛步消耗掉的這一次
    // 必須由 click_next_button 自行排接續，否則播放會卡在條件段
    case "next":     GdbApi.click_next_button(false, { autoplay: true }); break;
    case "step-in":  GdbApi.click_step_button();     break;
    case "step-out": GdbApi.click_return_button();   break;
    case "continue": GdbApi.click_continue_button(); break;
  }
};
export default GdbApi;
