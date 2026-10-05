/**
 * vgdb M1 layer B: run student code through the in-browser engine (gdbgui/static/engine) and the
 * LocalGdb GDB/MI emulation. It is the ONLY engine: there is no server-side GDB to fall back to.
 * Design and the list of wired call sites: localEngine.README.md.
 *
 * Security (contract §3): nothing here reads or forwards the CSRF token or cookies, talks to the
 * network (the engine itself fetches its own assets from same-origin /static/engine/assets), evaluates
 * student data, or touches the lesson APIs. Every HTML-bound string (/read_file) is escaped.
 */
import { store } from "statorgfc";

// ---------------------------------------------------------------------------------------------
// constants shared with the simulated endpoints
// ---------------------------------------------------------------------------------------------

/** Display path (`fullname`, `source_path`), same as the server's virtual path. */
export const SOURCE_PATH = "/workspace/main.cpp";
/** Pseudo "real" path (`file`, `gdb_source_path`; spec §12 N1). */
export const GDB_SOURCE_PATH = "/vgdb-wasm/main.cpp";
export const BINARY_PATH = "/vgdb-wasm/main.wasm";
/** mtime reported for both the source and the "binary": equal, so FileOps never shows the stale-binary modal. */
export const FIXED_MTIME = 1700000000;
const FILE_UNAVAILABLE_MESSAGE = "File not found or not accessible"; // http_routes.py _FILE_UNAVAILABLE_MESSAGE
const LOAD_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------------------------
// runtime loading of the engine (never bundled: webpack 4 cannot handle import.meta / module workers)
// ---------------------------------------------------------------------------------------------

export interface EngineModules {
  engine: { loadEngine: (opts?: any) => Promise<any> };
  localgdb: { createLocalGdb: (opts: any) => any; buildPrerunSnapshots: (model: any) => any[] };
}

let _modules: Promise<EngineModules> | null = null;

/**
 * Same-origin base URL of gdbgui/static/engine/. Derived from the page's own main.js <script> (the
 * template references it relative to the page, so an app mounted under a prefix keeps working);
 * falls back to /static/engine/. Anything that is not same-origin is refused.
 */
export function engineBaseUrl(): string {
  let base = "";
  try {
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) {
      const src = scripts[i].src || "";
      if (/\/static\/js\/main\.js(\?|$)/.test(src)) {
        base = new URL("../engine/", src).href;
        break;
      }
    }
  } catch (e) {
    base = "";
  }
  if (!base) base = new URL("/static/engine/", window.location.href).href;
  if (new URL(base).origin !== window.location.origin) {
    throw new Error("browser engine must be loaded from the page's own origin");
  }
  return base;
}

/**
 * Load /static/engine/index.js and /static/engine/localgdb/index.js as native ES modules by injecting
 * an inline <script type="module">. The script only contains the two same-origin URLs.
 */
export function loadModules(): Promise<EngineModules> {
  if (_modules) return _modules;
  _modules = new Promise<EngineModules>((resolve, reject) => {
    const w = window as any;
    let base: string;
    try {
      base = engineBaseUrl();
    } catch (e) {
      reject(e);
      return;
    }
    const readyEvent = "vgdb-engine-ready";
    let timer: any = null;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(readyEvent, onReady);
    };
    const onReady = () => {
      cleanup();
      const m = w.__vgdbEngine;
      try {
        delete w.__vgdbEngine;
      } catch (e) {
        w.__vgdbEngine = undefined;
      }
      if (m && m.engine && m.localgdb) resolve(m);
      else reject(new Error("browser engine modules did not initialise"));
    };
    window.addEventListener(readyEvent, onReady);
    const s = document.createElement("script");
    s.type = "module";
    s.textContent =
      `import * as e from ${JSON.stringify(base + "index.js")};\n` +
      `import * as l from ${JSON.stringify(base + "localgdb/index.js")};\n` +
      `window.__vgdbEngine = { engine: e, localgdb: l };\n` +
      `window.dispatchEvent(new Event(${JSON.stringify(readyEvent)}));\n`;
    s.onerror = () => {
      cleanup();
      reject(new Error("could not load " + base + "index.js"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out loading " + base + "index.js"));
    }, LOAD_TIMEOUT_MS);
    document.head.appendChild(s);
  });
  _modules.catch(() => {
    _modules = null; // allow a retry on the next Run
  });
  return _modules;
}

// ---------------------------------------------------------------------------------------------
// LocalSocket: the socket object GdbApi uses (a socket.io-client look-alike backed by the in-browser engine)
// ---------------------------------------------------------------------------------------------

type Listener = { cb: (payload?: any) => void; once: boolean };

/** Events a LocalGdb session sends that are forwarded to the UI (connect/connection events are ours). */
const FORWARDED_EVENTS = [
  "gdb_response",
  "program_pty_response",
  "user_pty_response",
  "error_running_gdb_command",
];

/** Minimal shape of what createLocalGdb returns that the facade relies on. */
export interface LocalGdbLike {
  socket: {
    on: (ev: string, cb: (p: any) => void) => any;
    emit: (ev: string, p: any) => any;
    close: () => any;
  };
  session?: { pid?: number; model?: any };
  idle: () => Promise<void>;
  setRunToken: (t: string | null) => void;
  close: () => void;
}

/**
 * socket.io-client subset (on/once/off/emit/connected/disconnected/close) that exists from page load.
 * `run_gdb_command` / `pty_interaction` are buffered until a LocalGdb session is attached and then
 * delegated strictly in arrival order (FIFO, spec §4). A session attached later replaces the current
 * one; the old one keeps delivering until it has answered everything it had already received.
 */
export class LocalSocket {
  connected = false;
  closed = false;
  id = "vgdb-local-socket";
  private listeners: { [ev: string]: Listener[] } = {};
  private buffer: Array<[string, any]> = [];
  private delegate: LocalGdbLike | null = null;

  get disconnected(): boolean {
    return !this.connected;
  }

  /** The LocalGdb session currently answering commands, or null before one is attached. */
  get currentGdb(): LocalGdbLike | null {
    return this.delegate;
  }

  on(ev: string, cb: (payload?: any) => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push({ cb, once: false });
    return this;
  }

  once(ev: string, cb: (payload?: any) => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push({ cb, once: true });
    return this;
  }

  off(ev?: string, cb?: (payload?: any) => void) {
    if (ev === undefined) this.listeners = {};
    else if (cb === undefined) delete this.listeners[ev];
    else this.listeners[ev] = (this.listeners[ev] || []).filter((l) => l.cb !== cb);
    return this;
  }

  removeListener(ev: string, cb: (payload?: any) => void) {
    return this.off(ev, cb);
  }

  removeAllListeners(ev?: string) {
    return this.off(ev);
  }

  /** client -> "server" */
  emit(ev: string, payload?: any) {
    if (this.closed) return this;
    if (ev !== "run_gdb_command" && ev !== "pty_interaction") return this;
    if (this.delegate) this.delegate.socket.emit(ev, payload);
    else this.buffer.push([ev, payload]);
    return this;
  }

  /** "server" -> client (internal) */
  deliver(ev: string, payload?: any) {
    if (this.closed) return;
    const l = this.listeners[ev];
    if (!l) return;
    const copy = l.slice();
    for (let i = 0; i < copy.length; i++) {
      if (copy[i].once) this.off(ev, copy[i].cb);
      try {
        copy[i].cb(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Make `gdb` the session that answers from now on; flush the buffer into it (FIFO). */
  attach(gdb: LocalGdbLike) {
    const old = this.delegate;
    this.delegate = gdb;
    for (let i = 0; i < FORWARDED_EVENTS.length; i++) {
      const ev = FORWARDED_EVENTS[i];
      gdb.socket.on(ev, (p: any) => {
        // only the current session, or an old one still answering what it already received
        this.deliver(ev, p);
      });
    }
    const pending = this.buffer;
    this.buffer = [];
    for (let i = 0; i < pending.length; i++) gdb.socket.emit(pending[i][0], pending[i][1]);
    if (old) retire(old);
  }

  /** Drop the current session (commands are buffered again until the next attach). */
  detach() {
    const old = this.delegate;
    this.delegate = null;
    if (old) retire(old);
  }

  /** Undo close() (the UI closes the socket when the handshake reported a failure). */
  reopen() {
    this.closed = false;
    this.connected = false;
    this.buffer = [];
    this.delegate = null;
  }

  hasSession(): boolean {
    return this.delegate !== null;
  }

  /** Like the server's handshake: `connect`, then `debug_session_connection_event` (spec §1/§4). */
  announce(pid: number) {
    if (this.closed || this.connected) return;
    this.connected = true;
    this.deliver("connect");
    this.deliver("debug_session_connection_event", {
      ok: true,
      started_new_gdb_process: true,
      pid,
      message: `Started new gdb process, pid ${pid} (browser engine)`,
    });
  }

  /** Handshake failure path (the UI prints the message and closes the socket). */
  announceFailure(message: string) {
    if (this.closed) return;
    this.connected = true;
    this.deliver("connect");
    this.deliver("debug_session_connection_event", {
      ok: false,
      started_new_gdb_process: false,
      pid: null,
      message,
    });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.buffer = [];
    const d = this.delegate;
    this.delegate = null;
    if (d) retire(d);
    return this;
  }

  disconnect() {
    return this.close();
  }
}

/** Close a replaced session once it has answered every command it already received. */
function retire(gdb: LocalGdbLike) {
  let p: Promise<void>;
  try {
    p = gdb.idle();
  } catch (e) {
    p = Promise.resolve();
  }
  p.then(
    () => gdb.close(),
    () => gdb.close()
  );
}

// ---------------------------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------------------------

let _socket: LocalSocket | null = null;
let _enginePromise: Promise<any> | null = null;
let _generation = 0;
let _inFlight = false;
let _abortCurrent: (() => void) | null = null;
let _supersedeCurrent: (() => void) | null = null;
/** Source text of the attached session (what the engine compiled): /read_file serves it. */
let _sessionSource: string | null = null;

/** A trace-less "no program loaded yet" run: LocalGdb answers pre-Run commands from it. */
export function emptyRunResult(): any {
  return {
    ok: true,
    engine: "wasm",
    instrumented: true,
    steps: [],
    decls: {},
    globals: {},
    functions: {},
    uninitDecls: [],
    stdout: "",
    stderr: "",
    exit: { reason: "exit", code: 0 },
    errors: [],
  };
}

function createBootstrap(mods: EngineModules): LocalGdbLike {
  return mods.localgdb.createLocalGdb({
    source: "",
    stdin: "",
    runResult: emptyRunResult(),
    sourcePath: SOURCE_PATH,
    gdbFilePath: GDB_SOURCE_PATH,
    autoConnect: false,
  });
}

/**
 * The socket GdbApi.init() uses when the flag is on. Created once; loading the (small) JS modules and
 * the "no program" session starts immediately, the handshake is emitted when they are ready.
 */
export function getSocket(): LocalSocket {
  if (_socket) return _socket;
  const sock = new LocalSocket();
  _socket = sock;
  loadModules().then(
    (mods) => {
      let boot: LocalGdbLike;
      try {
        boot = createBootstrap(mods);
      } catch (e) {
        sock.announceFailure("瀏覽器引擎初始化失敗：" + errText(e));
        return;
      }
      if (!sock.hasSession()) sock.attach(boot);
      const pid = boot.session && boot.session.pid ? boot.session.pid : 4242;
      sock.announce(pid);
    },
    (e) => sock.announceFailure("瀏覽器引擎載入失敗：" + errText(e))
  );
  return sock;
}

function errText(e: any): string {
  return e && e.message ? String(e.message) : String(e);
}

function randomToken(): string {
  const bytes: number[] = [];
  const c: any = (window as any).crypto;
  if (c && c.getRandomValues) {
    const a = new Uint8Array(16);
    c.getRandomValues(a);
    for (let i = 0; i < a.length; i++) bytes.push(a[i]);
  } else {
    for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  }
  return bytes.map((b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

// ---------------------------------------------------------------------------------------------
// simulated /create_and_upload
// ---------------------------------------------------------------------------------------------

export interface CreateAndUploadRequest {
  code: string;
  filepath?: string | null;
  program_input?: string;
}

/**
 * Map an engine result that cannot be debugged to the server's compile-error response body
 * ({message, stderr}; CompileErrors parses `file:line:col: error: msg` lines of stderr).
 * Returns null when the result is debuggable.
 */
export function mapRunError(r: any): { message: string; stderr?: string } | null {
  if (!r) return { message: "瀏覽器引擎沒有回傳結果" };
  const errors: any[] = Array.isArray(r.errors) ? r.errors : [];
  const fatal = errors.filter((e) => e && e.kind !== "trace-truncated" && e.kind !== "width-warning");
  if (r.ok === false || fatal.length) {
    const e = fatal[0] || { kind: "internal-error", message: "unknown error" };
    switch (e.kind) {
      case "compile":
        return {
          message: "編譯失敗（瀏覽器引擎）",
          stderr: String(e.message || "").replace(/^main\.cpp:/gm, SOURCE_PATH + ":"),
        };
      case "unsupported": {
        const where = typeof e.line === "number" ? `，第 ${e.line} 行` : "";
        const out: { message: string; stderr?: string } = {
          message: `瀏覽器引擎不支援此語法（${e.construct}${where}）`,
        };
        if (typeof e.line === "number") {
          out.stderr = `${SOURCE_PATH}:${e.line}:1: error: 瀏覽器引擎不支援此語法：${e.construct}`;
        }
        return out;
      }
      case "compile-timeout":
        return { message: "瀏覽器引擎編譯逾時；請簡化程式" };
      case "link":
        return { message: "連結失敗（瀏覽器引擎）", stderr: String(e.message || "") };
      case "forbidden-import":
        return { message: "程式使用了瀏覽器引擎不允許的系統功能" };
      case "instrumentation-failed":
        return { message: "瀏覽器引擎無法分析這份程式（插樁失敗）" };
      default:
        return { message: `瀏覽器引擎內部錯誤（${e.kind}）` };
    }
  }
  const reason = r.exit && r.exit.reason;
  if (reason === "stack-overflow") {
    return { message: "瀏覽器引擎的遞迴深度不足（堆疊溢位），無法完整記錄這次執行" };
  }
  if (reason === "step-limit" || reason === "trace-limit") {
    return { message: "程式執行步數超過瀏覽器引擎的記錄上限；請縮小輸入" };
  }
  return null;
}

/** Non-fatal notes for `sandbox_warnings` (printed to the console as STD_ERR by the UI). */
export function runWarnings(r: any): string[] {
  const out: string[] = [];
  const errors: any[] = Array.isArray(r.errors) ? r.errors : [];
  if (errors.some((e) => e && e.kind === "trace-truncated")) {
    out.push("[瀏覽器引擎] 執行紀錄的最後一筆不完整，最後一步可能缺漏");
  }
  if (r.nosys && typeof r.nosys === "object") {
    const names = Object.keys(r.nosys);
    if (names.length) out.push("[瀏覽器引擎] 程式呼叫了瀏覽器不支援的系統功能：" + names.join(", "));
  }
  const widthErrors = errors.filter((e) => e && e.kind === "width-warning");
  if (widthErrors.length) {
    const kinds = Array.from(new Set(widthErrors.map((e) => String(e.construct))));
    const label: Record<string, string> = { long: "long", size_t: "size_t", "sizeof(pointer)": "sizeof(指標)" };
    const desc = kinds.map((k) => label[k] || k).join("、");
    out.push(
      `[瀏覽器引擎] 程式用到 ${desc}：瀏覽器引擎是 32 位元（4 bytes），與 64 位元環境（8 bytes）的數值可能不一致`
    );
  }
  const reason = r.exit && r.exit.reason;
  if (reason === "timeout") out.push("[瀏覽器引擎] 程式執行超過時間上限，已被終止");
  if (reason === "output-limit") out.push("[瀏覽器引擎] 程式輸出超過上限，已被終止");
  return out;
}

/** stdin exactly as the UI's pty injection would deliver it (GdbApi doInject: input + "\n", then EOF). */
export function stdinFor(programInput: string | undefined): string {
  let input = programInput || "";
  if (!input) {
    try {
      input = window.localStorage.getItem("gdbgui_program_input") || "";
    } catch (e) {
      input = "";
    }
  }
  return input ? input + "\n" : "";
}

/**
 * Compile + run in the browser, then attach a LocalGdb session for the result. Resolves with the
 * server's response body: {status:"success", ...} or {status:"error", message, stderr?}.
 */
export function createAndUpload(
  req: CreateAndUploadRequest,
  onProgress?: (msg: string) => void
): Promise<any> {
  const gen = ++_generation;
  _inFlight = true;
  const progress = (m: string) => {
    if (onProgress) onProgress(m);
  };
  const sock = getSocket();
  const code = typeof req.code === "string" ? req.code : "";
  const stdin = stdinFor(req.program_input);
  const cancelled = () => ({ status: "error", message: "已中斷（瀏覽器引擎）" });
  store.set("waiting_for_response", true);
  let interrupted = false;
  const finish = (body: any) => {
    if (gen !== _generation) {
      // Replaced by a newer Run: only the newest Run reports to the UI (an error here would flip the
      // UI back to edit mode after the newer Run succeeded). An explicit /send_signal still reports.
      return interrupted ? body : { status: "superseded" };
    }
    _inFlight = false;
    _abortCurrent = null;
    _supersedeCurrent = null;
    store.set("waiting_for_response", false);
    return body;
  };
  // sendSignal() resolves this: a disposed engine never answers the pending request.
  if (_supersedeCurrent) _supersedeCurrent(); // settle the Run this one replaces
  const aborted = new Promise<any>((resolve) => {
    _abortCurrent = () => {
      interrupted = true;
      resolve(cancelled());
    };
    _supersedeCurrent = () => resolve({ status: "superseded" });
  });
  const work = loadModules()
    .then((mods) => {
      if (gen !== _generation) return cancelled();
      if (!_enginePromise) {
        progress("瀏覽器引擎：正在載入編譯器（第一次需要下載，約數十秒；之後會快取）……");
        _enginePromise = mods.engine.loadEngine();
        _enginePromise.catch(() => {
          _enginePromise = null;
        });
      }
      return _enginePromise.then((engine: any) => {
        if (gen !== _generation) return cancelled();
        progress("瀏覽器引擎：正在編譯並執行程式……");
        return engine.runProgram(code, stdin).then((r: any) => {
          if (gen !== _generation) return cancelled();
          const err = mapRunError(r);
          if (err) return { status: "error", message: err.message, stderr: err.stderr || "" };
          const gdb: LocalGdbLike = mods.localgdb.createLocalGdb({
            source: code,
            stdin,
            runResult: r,
            sourcePath: SOURCE_PATH,
            gdbFilePath: GDB_SOURCE_PATH,
            autoConnect: false,
          });
          const token = randomToken();
          gdb.setRunToken(token);
          _sessionSource = code;
          // A transient load failure made the UI close the socket (ok:false event): re-open it and
          // repeat the handshake so the UI's own handlers (run_initial_commands ...) run again.
          const wasClosed = sock.closed;
          if (wasClosed) sock.reopen();
          sock.attach(gdb);
          if (!sock.connected) sock.announce(gdb.session && gdb.session.pid ? gdb.session.pid : 4242);
          return {
            status: "success",
            binary_path: BINARY_PATH,
            source_path: SOURCE_PATH,
            gdb_source_path: GDB_SOURCE_PATH,
            exec_wrapper: "",
            gdb_subst_cmd: "",
            sandbox_warnings: runWarnings(r),
            run_token: token,
          };
        });
      });
    })
    .catch((e: any) => ({ status: "error", message: "瀏覽器引擎錯誤：" + errText(e) }));
  return Promise.race([work, aborted]).then(finish);
}

// ---------------------------------------------------------------------------------------------
// other simulated endpoints
// ---------------------------------------------------------------------------------------------

/** Python html.escape(s, quote=True), which the server applies when it does not highlight. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * /read_file for the debugged source, same response body as http_routes.read_file (non-highlighted
 * branch: every line HTML-escaped, blank lines as " ", `split("\n")` line count, end_line clamped).
 */
export function readFile(data: any): { ok: true; body: any } | { ok: false; message: string } {
  const path = data && typeof data.path === "string" ? data.path : "";
  const start = parseInt(data && data.start_line, 10);
  const end = parseInt(data && data.end_line, 10);
  if (isNaN(start) || isNaN(end)) return { ok: false, message: FILE_UNAVAILABLE_MESSAGE };
  if (path !== SOURCE_PATH && path !== GDB_SOURCE_PATH) return { ok: false, message: FILE_UNAVAILABLE_MESSAGE };
  let text = _sessionSource;
  if (text === null) {
    const get = (window as any).gdbgui_get_editor_value;
    const v = typeof get === "function" ? get() : null;
    text = typeof v === "string" ? v : null;
  }
  if (text === null) return { ok: false, message: FILE_UNAVAILABLE_MESSAGE };
  const all = text.split("\n");
  const startLine = Math.max(1, start);
  const endLine = Math.min(all.length, end);
  const lines = all.slice(startLine - 1, Math.max(startLine - 1, endLine));
  return {
    ok: true,
    body: {
      source_code_array: lines.map((l) => escapeHtml(l === "" ? " " : l)),
      path,
      last_modified_unix_sec: FIXED_MTIME,
      highlighted: false,
      start_line: startLine,
      end_line: endLine,
      num_lines_in_file: all.length,
    },
  };
}

/**
 * /api/prerun_calltree. The real backend re-runs the already-compiled binary under `gdb --batch`
 * with a breakpoint on every function, recording one stack snapshot per call (prerun.py). LocalGdb
 * already has the complete trace from the Run that just finished (GdbApi fires this right after
 * create_and_upload resolves, so a session is always attached by now), so it derives the identical
 * `snapshots` shape directly — see ghostSnapshots.js for the correspondence.
 */
export function prerunCalltree(): Promise<any> {
  return loadModules().then(
    (mods) => {
      const gdb = _socket && _socket.currentGdb;
      const model = gdb && gdb.session && gdb.session.model;
      if (!model) return { ok: false, reason: "no_binary" };
      try {
        return { ok: true, snapshots: mods.localgdb.buildPrerunSnapshots(model) };
      } catch (e) {
        return { ok: false, reason: "prerun_failed" };
      }
    },
    () => ({ ok: false, reason: "prerun_failed" })
  );
}

/**
 * /send_signal. An in-flight compile/run is abandoned (engine disposed, the pending Run answers
 * "已中斷"). A recorded session is never "running", so SIGINT to the inferior has nothing to stop;
 * any other signal (or target "gdb") ends the session and returns to the "no program" state.
 */
export function sendSignal(signalName: string, target: string): Promise<string> {
  if (_inFlight) {
    _generation++;
    _inFlight = false;
    const abort = _abortCurrent;
    _abortCurrent = null;
    if (abort) abort();
    const p = _enginePromise;
    _enginePromise = null;
    if (p) {
      p.then(
        (engine: any) => {
          try {
            engine.dispose();
          } catch (e) {
            /* already gone */
          }
        },
        () => undefined
      );
    }
    store.set("waiting_for_response", false);
    return Promise.resolve(`瀏覽器引擎：已中斷編譯／執行（${signalName}）`);
  }
  if (signalName === "SIGINT" && target === "inferior") {
    return Promise.resolve("瀏覽器引擎：程式已預先執行完畢並停在除錯狀態，不需要中斷");
  }
  const sock = _socket;
  return loadModules().then(
    (mods) => {
      _sessionSource = null;
      if (sock && !sock.closed) sock.attach(createBootstrap(mods));
      return `瀏覽器引擎：已結束除錯階段（${signalName} → ${target}）`;
    },
    (e) => "瀏覽器引擎：" + errText(e)
  );
}

// ---------------------------------------------------------------------------------------------
// $.ajax-shaped router used by the flag branches (same callbacks, no network, no beforeSend)
// ---------------------------------------------------------------------------------------------

function fakeXhr(status: number, body: any): any {
  return {
    status,
    statusText: status >= 400 ? "error" : "success",
    responseJSON: body,
    responseText: JSON.stringify(body),
  };
}

function call(fn: any, args: any[]) {
  if (typeof fn === "function") fn.apply(null, args);
}

function respond(settings: any, p: Promise<{ status: number; body: any }>) {
  p.then((r) => {
    const xhr = fakeXhr(r.status, r.body);
    if (r.status < 400) call(settings.success, [r.body, "success", xhr]);
    else call(settings.error, [xhr, "error", xhr.statusText]);
    call(settings.complete, [xhr, r.status < 400 ? "success" : "error"]);
  });
}

/**
 * Serve one of the HTTP endpoints the flag replaces, calling the jQuery settings' success/error/complete
 * callbacks asynchronously like $.ajax. `beforeSend` (which sets the CSRF header) is never called and
 * `data.csrf_token` is never read.
 */
export function ajax(settings: any, onProgress?: (msg: string) => void): void {
  const data = (settings && settings.data) || {};
  const url = settings && settings.url;
  if (url === "/create_and_upload") {
    createAndUpload(
      { code: data.code, filepath: data.filepath, program_input: data.program_input },
      onProgress
    ).then((body) => {
      if (body.status === "superseded") return; // a newer Run owns the UI now: no callbacks at all
      respond(settings, Promise.resolve({ status: body.status === "success" ? 200 : 400, body }));
    });
  } else if (url === "/read_file") {
    const r = readFile(data);
    respond(settings, Promise.resolve(r.ok ? { status: 200, body: r.body } : { status: 400, body: { message: r.message } }));
  } else if (url === "/get_last_modified_unix_sec") {
    respond(settings, Promise.resolve({ status: 200, body: { path: data.path, last_modified_unix_sec: FIXED_MTIME } }));
  } else if (url === "/send_signal") {
    respond(settings, sendSignal(String(data.signal_name), String(data.target)).then((message) => ({ status: 200, body: { message } })));
  } else {
    respond(settings, Promise.resolve({ status: 404, body: { message: "瀏覽器引擎未提供此端點：" + String(url) } }));
  }
}

/** Test hooks (not used by the app). */
export const _test = {
  reset() {
    _modules = null;
    _socket = null;
    _enginePromise = null;
    _generation = 0;
    _inFlight = false;
    _abortCurrent = null;
    _supersedeCurrent = null;
    _sessionSource = null;
  },
  setModules(m: EngineModules) {
    _modules = Promise.resolve(m);
  },
  setSessionSource(s: string | null) {
    _sessionSource = s;
  },
};

export default {
  getSocket,
  ajax,
  createAndUpload,
  readFile,
  prerunCalltree,
  sendSignal,
  escapeHtml,
};
