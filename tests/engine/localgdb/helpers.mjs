// Shared helpers for the LocalGdb tests: driving a session the way the UI does and small hand-made runs.
import { createLocalGdb } from "../../../gdbgui/static/engine/localgdb/index.js";

/** Send one MI/CLI command (or several in one message) and return the items of its gdb_response packet. */
export async function send(gdb, cmd, extra = {}) {
  const cmds = Array.isArray(cmd) ? cmd : [cmd];
  const before = gdb.session.subcommandLog.length;
  gdb.__rid = (gdb.__rid || 0) + 1;
  gdb.socket.emit("run_gdb_command", { cmd: cmds, run_token: null, request_id: gdb.__rid, ...extra });
  await gdb.idle();
  const subs = gdb.session.subcommandLog.slice(before);
  const items = subs.flatMap((s) => s.items);
  return Object.assign(items, { subs });
}

/** The single `result` payload of a one-command send. */
export const payloadOf = (items, i = 0) => items.filter((x) => x.type === "result")[i].payload;
export const stopped = (items) => items.find((x) => x.type === "notify" && x.message === "stopped");
export const frameLine = (items) => Number(stopped(items).payload.frame.line);

export function newGdb(run, source, o = {}) {
  return createLocalGdb({ source, runResult: run, sourcePath: "/workspace/main.cpp", gdbFilePath: "/srv/x/main_real.cpp", recordSubcommands: true, ...o });
}

export const SMALL_SRC = "int main() {\n  int x = 1;\n  x = 2;\n  return 0;\n}\n";

/** A tiny hand-made engine result (4 stops in main). */
export function smallRun(over = {}) {
  const st = (line, vars) => ({ line, fn: "main", depth: 1, frame: 1, vars });
  return {
    ok: true, engine: "wasm", instrumented: true,
    steps: [st(2, {}), st(3, { x: 1 }), st(4, { x: 2 }), st(5, { x: 2 })],
    rawSteps: 4, decls: { main: { x: "int" } }, globals: {}, functions: { main: { line: 1, closeLine: 5, params: [], vars: ["x"] } },
    uninitDecls: [], stdout: "out\n", stderr: "", exit: { reason: "exit", code: 0 }, errors: [],
    ...over,
  };
}
