/* global initial_data */
/* global debug */
import constants from "./constants";

/**
 * The initial store data. Keys cannot be added after initialization.
 * All fields in here should be shared by > 1 component, otherwise they should
 * exist as local state for that component.
 */
const initial_store_data = {
  // environment
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'debug'.
  debug: debug, // if gdbgui is run in debug mode
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'initial_data'.
  gdbgui_version: initial_data.gdbgui_version,
  latest_gdbgui_version: "(not fetched)",
  gdb_version: "unknown", // this is parsed from gdb's output
  gdb_version_array: [], // this is parsed from gdb's output
  gdb_pid: undefined,
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'initial_data'.
  gdb_command: initial_data.gdb_command,
  can_fetch_register_values: true, // set to false if using Rust and gdb v7.12.x (see https://github.com/cs01/gdbgui/issues/64)
  show_settings: false,

  debug_in_reverse: false,
  reverse_supported: false,
  show_modal: false,
  modal_header: null,
  modal_body: null,

  show_tour_guide: true,
  tour_guide_step: 0,
  num_tour_guide_steps: 0,
  tooltip: { hidden: false, content: "placeholder", node: null, show_for_n_sec: null },
  textarea_to_copy_to_clipboard: {}, // will be replaced with textarea dom node

  // preferences
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'initial_data'.
  themes: initial_data.themes,
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'initial_data'.
  current_theme: localStorage.getItem("theme") || initial_data.themes[0],
  highlight_source_code: true, // get saved boolean to highlight source code
  max_lines_of_code_to_fetch: constants.default_max_lines_of_code_to_fetch,
  auto_add_breakpoint_to_main: true,
  autoplay_enabled: true, // 自動播放模式：TTS 結束後自動執行對應的 GDB 步驟指令
  autoplay_paused: false, // 暫停自動播放：保留進度，下次恢復時從該步驟繼續
  autoplay_pending_command: null as string | null, // 暫停時儲存的待執行指令
  tts_speed: 1.0, // TTS 播放速度（0.5x ~ 2.0x）
  edit_mode: true, // 編輯模式：顯示 Guide/TTS 輸入欄；按下 Run 自動切為 false

  pretty_print: true, // whether gdb should "pretty print" variables. There is an option for this in Settings
  refresh_state_after_sending_console_command: true, // If true, send commands to refresh GUI store after each command is sent from console
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name 'debug'.
  show_all_sent_commands_in_console: debug, // show all sent commands if in debug mode

  inferior_program: constants.inferior_states.unknown,
  inferior_pid: null,

  paused_on_frame: undefined,
  selected_frame_num: 0,
  current_thread_id: undefined,
  stack: [],
  locals: [],
  threads: [],
  call_graph_updated: 0,
  rbtree_updated: 0,


  // source files
  source_file_paths: [], // all the paths gdb says were used to compile the target binary
  language: "c_family", // assume langage of program is c or c++. Language is determined by source file paths. Used to turn on/off certain features/warnings.
  files_being_fetched: [],
  fullname_to_render: null,
  line_of_source_to_flash: null,
  current_assembly_address: null,
  // rendered_source: {},
  make_current_line_visible: false, // set to true when source code window should jump to current line
  cached_source_files: [], // list with keys fullname, source_code
  disassembly_for_missing_file: [], // mi response object. Only fetched when there currently paused frame refers to a file that doesn't exist or is undefined
  missing_files: [], // files that were attempted to be fetched but did not exist on the local filesystem
  source_code_state: constants.source_code_states.NONE_AVAILABLE,
  source_code_selection_state: constants.source_code_selection_states.PAUSED_FRAME,

  source_code_infinite_scrolling: false,
  source_linenum_to_display_start: 0,
  source_linenum_to_display_end: 0,

  // binary selection
  inferior_binary_path: null,
  inferior_binary_path_last_modified_unix_sec: null,

  // registers
  register_names: [],
  previous_register_values: {},
  current_register_values: {},

  // memory
  memory_cache: {},
  start_addr: "",
  end_addr: "",
  bytes_per_line: "8",

  // breakpoints
  breakpoints: [],

  // expressions
  expressions: [], // array of dicts. Key is expression, value has various keys. See Expressions component.
  root_gdb_tree_var: null, // draw tree for this variable

  waiting_for_response: false,

  gdb_mi_output: [],

  gdb_autocomplete_options: [],

  gdb_console_entries: [],

  // if we try to write something before the websocket is connected, store it here
  queuedGdbCommands: [],

  show_filesystem: false,
  middle_panes_split_obj: {},
  gdbguiPty: null,
  tts_subtitle: null,
  tts_focus_var: null as string | null,
  condition_overlay: null as any,
  program_input: "",
  compile_errors: [] as any[],
  // Canonical path of the user's last successfully compiled source file.
  // Unlike fullname_to_render (which GDB can change to library headers), this
  // never changes except when the user compiles a new file.
  user_source_fullname: null as string | null,

  // Token generated by the server on each compile. Included in every run_gdb_command emit
  // and validated against each gdb_response packet. Prevents stale/rogue packets from
  // being processed after a new run starts.
  run_token: null as string | null,
};

function get_stored(key: any, default_val: any) {
  try {
    if (localStorage.hasOwnProperty(key)) {
      // @ts-expect-error ts-migrate(2345) FIXME: Type 'null' is not assignable to type 'string'.
      let cached = JSON.parse(localStorage.getItem(key));
      if (typeof cached === typeof default_val) {
        return cached;
      }
      return default_val;
    }
  } catch (err) {
    console.error(err);
  }
  localStorage.removeItem(key);
  return default_val;
}

// restore saved localStorage data
for (let key in initial_store_data) {
  // @ts-expect-error ts-migrate(7053) FIXME: No index signature with a parameter of type 'strin... Remove this comment to see the full error message
  let default_val = initial_store_data[key];
  // @ts-expect-error ts-migrate(7053) FIXME: No index signature with a parameter of type 'strin... Remove this comment to see the full error message
  initial_store_data[key] = get_stored(key, default_val);
}

// ─── F5 還原：唯一依據是 gdbgui_autosave JSON snapshot ───
// get_stored() 因型別不符（null vs string）無法還原 fullname_to_render；
// breakpoints 也必須從 autosave 讀取，才能完整保留所有斷點。
try {
  const _as = JSON.parse(localStorage.getItem("gdbgui_autosave") || "null");
  if (_as && _as.version) {
    // 1. 還原 fullname_to_render
    if (_as.fullname_to_render) {
      (initial_store_data as any).fullname_to_render = _as.fullname_to_render;
    }

    // 2. 還原所有斷點（autosave 是唯一依據，覆蓋 get_stored 讀到的舊值）
    const _ftr: string = _as.fullname_to_render || "";
    if (Array.isArray(_as.breakpoints)) {
      // autosave.breakpoints 存在（含空陣列）→ 使用 autosave，不使用舊 localStorage["breakpoints"]
      (initial_store_data as any).breakpoints = _as.breakpoints
        .filter((b: any) => b.is_normal_breakpoint !== false && !b.is_child_breakpoint && !b.is_parent_breakpoint)
        .map((b: any) => {
          const isAlreadyFrontend = typeof b.number === 'string' && b.number.startsWith('frontend_');
          return {
            fullname: _ftr,
            fullname_to_display: _ftr,
            line: b.line,
            number: isAlreadyFrontend ? b.number : `frontend_${Math.random().toString(36).substr(2, 9)}`,
            enabled: b.enabled || "y",
            ...(b.cond !== undefined ? { cond: b.cond } : {}),
            is_parent_breakpoint: false,
            is_child_breakpoint: false,
            is_normal_breakpoint: true,
          };
        });
    }
    // autosave.breakpoints 不存在（舊格式 autosave）→ 保留 get_stored 讀到的值，不覆蓋

    // 3. 還原 program_input（若有）
    if (typeof _as.program_input === 'string') {
      (initial_store_data as any).program_input = _as.program_input;
    }
  }
} catch (_) {}

// Fallback：沒有 autosave 時，從 gdbgui_last_edited_filename 還原 fullname_to_render
if ((initial_store_data as any).fullname_to_render === null) {
  try {
    const _lastFn = localStorage.getItem("gdbgui_last_edited_filename");
    if (_lastFn && _lastFn !== "__pending__") {
      (initial_store_data as any).fullname_to_render = _lastFn;
    }
  } catch (_) {}
}

// Fallback：沒有 autosave 時，將舊 localStorage["breakpoints"] 轉換為 frontend_* 格式
// （只在 autosave 不存在時才執行，避免覆蓋上方的 autosave 還原結果）
if (!localStorage.getItem("gdbgui_autosave")) {
  const _restoredFtr: string = (initial_store_data as any).fullname_to_render || "";
  if (Array.isArray((initial_store_data as any).breakpoints)) {
    (initial_store_data as any).breakpoints = (initial_store_data as any).breakpoints
      .filter((b: any) => b.is_normal_breakpoint !== false && !b.is_child_breakpoint && !b.is_parent_breakpoint)
      .map((b: any) => {
        const isAlreadyFrontend = typeof b.number === 'string' && b.number.startsWith('frontend_');
        return {
          fullname: _restoredFtr,
          fullname_to_display: _restoredFtr,
          line: b.line,
          number: isAlreadyFrontend ? b.number : `frontend_${Math.random().toString(36).substr(2, 9)}`,
          enabled: b.enabled || "y",
          ...(b.cond !== undefined ? { cond: b.cond } : {}),
          is_parent_breakpoint: false,
          is_child_breakpoint: false,
          is_normal_breakpoint: true,
        };
      });
  }
}

if (localStorage.hasOwnProperty("max_lines_of_code_to_fetch")) {
  // @ts-expect-error ts-migrate(2345) FIXME: Type 'null' is not assignable to type 'string'.
  let savedval = JSON.parse(localStorage.getItem("max_lines_of_code_to_fetch"));
  // @ts-expect-error ts-migrate(2304) FIXME: Cannot find name '_'.
  if (_.isInteger(savedval) && savedval > 0) {
    if (savedval > 150) savedval = 150; // 強制蓋過舊有的過大快取值
    initial_store_data["max_lines_of_code_to_fetch"] = savedval;
  }
}

export default initial_store_data;
