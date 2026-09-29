// localEngine 旗標在 GdbApi.tsx / FileOps.tsx 的接線：
//   旗標關閉 → 呼叫原本的 io.connect / $.ajax（行為不變）；
//   旗標開啟 → 不連網，走 localEngine（LocalSocket、模擬端點），Run 的命令送進 LocalGdb。
(global as any)._ = require("lodash");

jest.mock("socket.io-client", () => {
  const sock = { on: jest.fn(), emit: jest.fn(), close: jest.fn(), connected: false, disconnected: true };
  return { __esModule: true, default: { connect: jest.fn(() => sock) }, connect: jest.fn(() => sock) };
});
jest.mock("../Actions", () => {
  const fns: any = {};
  return {
    __esModule: true,
    default: new Proxy(fns, {
      get: (t: any, k: string) => (k in t ? t[k] : (t[k] = jest.fn())),
    }),
  };
});
jest.mock("../process_gdb_response", () => ({ __esModule: true, default: jest.fn() }));

import io from "socket.io-client";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import GdbApi from "../GdbApi";
import FileOps from "../FileOps";
import { _test, LocalSocket, SOURCE_PATH, GDB_SOURCE_PATH, BINARY_PATH, FIXED_MTIME, emptyRunResult } from "../localEngine";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const ajax = jest.fn();
(window as any).$ = { ajax };

function fakeGdb() {
  const listeners: { [ev: string]: Array<(p: any) => void> } = {};
  const g: any = {
    received: [] as any[],
    runToken: null,
    session: { pid: 4242 },
    socket: {
      on: (ev: string, cb: (p: any) => void) => (listeners[ev] = listeners[ev] || []).push(cb),
      emit: (ev: string, p: any) => g.received.push([ev, p]),
      close: () => undefined,
    },
    idle: () => Promise.resolve(),
    setRunToken: (t: string) => (g.runToken = t),
    close: () => undefined,
  };
  return g;
}

function useFakeEngine() {
  const created: any[] = [];
  const engine = { runProgram: jest.fn(() => Promise.resolve({ ...emptyRunResult(), steps: [{ line: 2, fn: "main", depth: 1, frame: 1, vars: {} }] })) };
  _test.setModules({
    engine: { loadEngine: jest.fn(() => Promise.resolve(engine)) },
    localgdb: {
      createLocalGdb: jest.fn((opts: any) => {
        const g = fakeGdb();
        created.push({ opts, gdb: g });
        return g;
      }),
      buildPrerunSnapshots: jest.fn((_model: any) => []),
    },
  });
  return { created, engine };
}

const CODE = "#include <cstdio>\nint main() { return 0; }\n";

beforeEach(() => {
  _test.reset();
  ajax.mockClear();
  ((io as any).connect as jest.Mock).mockClear();
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
  (window as any).gdbgui_get_editor_value = () => CODE;
  (window as any).gdbgui_get_editor_filename = () => SOURCE_PATH;
  store.set("breakpoints", []);
  store.set("missing_files", []);
  store.set("cached_source_files", []);
  store.set("run_token", null);
});

describe("旗標關閉：原路徑不變", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/?engine=gdb"); // 2026-09-30 起 wasm 是預設，明確退回伺服器引擎才會走這條路
  });

  test("GdbApi.init 用 io.connect('/gdb_listener', {query 含 csrf_token})", () => {
    GdbApi.init();
    expect((io as any).connect).toHaveBeenCalledTimes(1);
    const [url, opts] = ((io as any).connect as jest.Mock).mock.calls[0];
    expect(url).toBe("/gdb_listener");
    expect(opts.query.csrf_token).toBe("test-csrf");
    expect(GdbApi.getSocket()).not.toBeInstanceOf(LocalSocket);
  });

  test("Run → $.ajax /create_and_upload（帶 csrf_token，同一組回呼）", () => {
    GdbApi.click_run_button();
    expect(ajax).toHaveBeenCalledTimes(1);
    const req = ajax.mock.calls[0][0];
    expect(req.url).toBe("/create_and_upload");
    expect(req.type).toBe("POST");
    expect(req.data).toMatchObject({ code: CODE, csrf_token: "test-csrf" });
    expect(typeof req.success).toBe("function");
    expect(typeof req.error).toBe("function");
  });

  test("get_inferior_binary_last_modified_unix_sec → $.ajax /get_last_modified_unix_sec", () => {
    GdbApi.get_inferior_binary_last_modified_unix_sec("/x.a");
    expect(ajax).toHaveBeenCalledTimes(1);
    expect(ajax.mock.calls[0][0]).toMatchObject({ url: "/get_last_modified_unix_sec", method: "GET", data: { path: "/x.a" } });
  });

  test("FileOps 讀檔 → $.ajax /read_file", () => {
    store.set("fullname_to_render", SOURCE_PATH);
    FileOps.fetch_more_source_at_end();
    expect(ajax).toHaveBeenCalledTimes(1);
    expect(ajax.mock.calls[0][0].url).toBe("/read_file");
    expect(ajax.mock.calls[0][0].data.path).toBe(SOURCE_PATH);
    ajax.mock.calls[0][0].complete(); // 放開 FileFetcher 的「讀取中」旗標
  });
});

describe("旗標開啟（?engine=wasm）：不連網，走 localEngine", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/?engine=wasm");
  });

  test("init → LocalSocket、run_initial_commands 送進「尚未 Run」的 session；Run → 瀏覽器編譯、命令送進新 session", async () => {
    const { created, engine } = useFakeEngine();
    const fetchSpy = jest.fn();
    (window as any).fetch = fetchSpy;
    GdbApi.init();
    expect((io as any).connect).not.toHaveBeenCalled();
    const sock = GdbApi.getSocket() as any;
    expect(sock).toBeInstanceOf(LocalSocket);
    await flush();
    expect(sock.connected).toBe(true);
    const boot = created[0].gdb;
    const initial = boot.received.filter((r: any) => r[0] === "run_gdb_command").map((r: any) => r[1].cmd);
    expect(initial[0]).toEqual(["-list-features", "-list-target-features"]);

    store.set("breakpoints", [{ number: "frontend_1", line: 2, enabled: "y", fullname_to_display: SOURCE_PATH, is_normal_breakpoint: true }]);
    store.set("program_input", "7");
    GdbApi.click_run_button();
    await flush();
    await flush();
    expect(ajax).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // /api/prerun_calltree 也不連網
    expect(engine.runProgram).toHaveBeenCalledWith(CODE, "7\n");
    const run = created[1];
    expect(run.opts.source).toBe(CODE);
    expect(store.get("run_token")).toBe(run.gdb.runToken);
    expect(store.get("user_source_fullname")).toBe(SOURCE_PATH);
    const sent = run.gdb.received.filter((r: any) => r[0] === "run_gdb_command");
    expect(sent.length).toBe(1);
    expect(sent[0][1].run_token).toBe(run.gdb.runToken);
    const cmds: string[] = sent[0][1].cmd;
    expect(cmds).toContain(`-file-exec-and-symbols "${BINARY_PATH}"`);
    expect(cmds).toContain(`-break-insert -f "${GDB_SOURCE_PATH}:2"`);
    expect(cmds[cmds.length - 1]).toBe("-exec-run");
    expect(cmds.some((c) => c.indexOf("substitute-path /") !== -1)).toBe(false);
    delete (window as any).fetch;
  });

  test("get_inferior_binary_last_modified_unix_sec → 固定值，不連網", async () => {
    store.set("inferior_binary_path", BINARY_PATH);
    GdbApi.get_inferior_binary_last_modified_unix_sec(BINARY_PATH);
    await flush();
    expect(ajax).not.toHaveBeenCalled();
    expect(store.get("inferior_binary_path_last_modified_unix_sec")).toBe(FIXED_MTIME);
  });

  test("FileOps 讀檔 → 前端產生、HTML 跳脫後進快取，不連網", async () => {
    _test.setSessionSource("int a; // <img src=x onerror=alert(1)>\n");
    store.set("fullname_to_render", SOURCE_PATH);
    FileOps.fetch_more_source_at_end();
    await flush();
    expect(ajax).not.toHaveBeenCalled();
    const f = FileOps.get_source_file_obj_from_cache(SOURCE_PATH);
    expect(f).not.toBeNull();
    expect(f.source_code_obj[1]).toBe("int a; // &lt;img src=x onerror=alert(1)&gt;");
    expect(f.num_lines_in_file).toBe(2);
  });
});
