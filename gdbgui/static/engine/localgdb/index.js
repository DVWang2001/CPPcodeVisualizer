// LocalGdb: a GDB/MI emulation driven by the in-browser engine's trace (milestone M1, layer A).
// See README.md for the API, the command matrix and the allowed differences to real GDB.
// Plain ES module, no DOM / Node APIs: runs in Node (tests) and in a page.

import { LocalGdbSession } from "./session.js";
import { LocalSocket } from "./socket.js";

export { FEATURES } from "./session.js";
export { parseFastForward } from "./fastforward.js";

/**
 * @param {{
 *   source: string,                 C++ source text that was run (used for GDB's block/scope structure)
 *   stdin?: string,                 stdin given to the run (informational; `pty_interaction` write is only acknowledged)
 *   runResult: any,                 result of engine.runProgram(source, stdin) with ok === true
 *   sourcePath?: string,            display path reported as `fullname` (default "/workspace/main.cpp")
 *   gdbFilePath?: string,           pseudo real path reported as `file` (default: sourcePath)
 *   pid?: number,                   pseudo process id
 *   now?: () => number,             reserved: no packet field carries a timestamp
 *   recordSubcommands?: boolean,    keep `session.subcommandLog` (one entry per MI/CLI command; used by the replay test)
 *   autoConnect?: boolean,          default true: emit `connect` + `debug_session_connection_event` on the next tick
 * }} opts
 */
export function createLocalGdb(opts) {
  /** @type {LocalSocket} */
  let socket;
  const session = new LocalGdbSession(opts, (ev, payload) => socket.deliver(ev, payload));
  socket = new LocalSocket({
    onRunGdbCommand: (p) => session.onRunGdbCommand(p),
    onPtyInteraction: (p) => session.onPtyInteraction(p),
  });
  const api = {
    socket,
    session,
    /** Emit `connect` and `debug_session_connection_event` (done automatically unless autoConnect === false). */
    connect() {
      if (socket.connected || socket.closed) return;
      socket.connected = true;
      socket.deliver("connect", undefined);
      socket.deliver("debug_session_connection_event", { ok: true, started_new_gdb_process: true, message: `Started new gdb process, pid ${session.pid}`, pid: session.pid });
    },
    /** Resolves when every queued command has been answered. */
    idle: () => session.idle(),
    /** Only commands carrying this run_token (or null) are processed; others are dropped (spec §4). @param {string | null} t */
    setRunToken(t) { session.runToken = t; },
    /** Everything written to the program pty by the UI (stdin acknowledgement). */
    get stdinReceived() { return session.stdinReceived; },
    close() { socket.close(); },
  };
  if (opts.autoConnect !== false) Promise.resolve().then(() => api.connect());
  return api;
}
