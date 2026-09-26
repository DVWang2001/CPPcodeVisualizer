// GDB/MI helpers for LocalGdb: command-line parsing and the item shapes the UI receives inside
// `gdb_response.data` (shapes taken from the golden sample, spec §5 and §12 A6):
//   result   {type:"result", message:"done"|"error", payload, token: number|null, stream}
//   notify   {type:"notify", message, payload, token: null, stream}
//   output   {type:"output",  message:null, payload:"^done\r", stream}       (no `token` key)
//   console  {type:"console", message:null, payload:"text\n",  stream}       (no `token` key)
//   log      {type:"log",     message:null, payload:"text\n",  stream}       (no `token` key)
// Plain ES module, no DOM / Node APIs.

/** @typedef {{ type: string, message: string | null, payload: any, token?: number | null, stream: string }} MiItem */

/**
 * Split a command string into an optional numeric token, the MI/CLI command name and the rest.
 * `1-thread-info` -> {token:1, name:"-thread-info", rest:""}; `python exec("...")` -> CLI.
 * @param {string} raw
 * @returns {{ token: number | null, name: string, rest: string, mi: boolean, raw: string }}
 */
export function parseCommand(raw) {
  const s = String(raw).replace(/^\s+/, "");
  const m = /^(\d*)(-[A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(s);
  if (m) return { token: m[1] === "" ? null : Number(m[1]), name: m[2], rest: (m[3] || "").trim(), mi: true, raw: s };
  const c = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s);
  return { token: null, name: c ? c[1] : s, rest: c && c[2] ? c[2] : "", mi: false, raw: s };
}

/**
 * Tokenise MI arguments: whitespace separated, `"..."` quoting with backslash escapes.
 * @param {string} rest
 * @returns {Array<{ value: string, quoted: boolean }>}
 */
export function splitArgs(rest) {
  /** @type {Array<{ value: string, quoted: boolean }>} */
  const out = [];
  let i = 0;
  const n = rest.length;
  while (i < n) {
    while (i < n && /\s/.test(rest[i])) i++;
    if (i >= n) break;
    if (rest[i] === '"') {
      i++;
      let v = "";
      while (i < n && rest[i] !== '"') {
        if (rest[i] === "\\" && i + 1 < n) { i++; v += rest[i] === "n" ? "\n" : rest[i] === "t" ? "\t" : rest[i]; } else v += rest[i];
        i++;
      }
      i++; // closing quote
      out.push({ value: v, quoted: true });
    } else {
      let v = "";
      while (i < n && !/\s/.test(rest[i])) { v += rest[i]; i++; }
      out.push({ value: v, quoted: false });
    }
  }
  return out;
}

const STREAM = "stdout";

/** @param {any} payload @param {number | null} [token] @returns {MiItem} */
export const resultItem = (payload, token = null) => ({ type: "result", message: "done", payload, token, stream: STREAM });
/** @param {string} msg @param {number | null} [token] @param {object} [extra] @returns {MiItem} */
export const errorItem = (msg, token = null, extra = {}) => ({ type: "result", message: "error", payload: { msg, ...extra }, token, stream: STREAM });
/** @param {string} message @param {any} payload @returns {MiItem} */
export const notifyItem = (message, payload) => ({ type: "notify", message, payload, token: null, stream: STREAM });
/** @param {string} text @returns {MiItem} */
export const consoleItem = (text) => ({ type: "console", message: null, payload: text, stream: STREAM });
/** @param {string} text @returns {MiItem} */
export const logItem = (text) => ({ type: "log", message: null, payload: text, stream: STREAM });
/** Bare `^done` / `^running` records reach the UI as raw `output` items (golden: "^done\r"). @param {string} text @returns {MiItem} */
export const outputItem = (text) => ({ type: "output", message: null, payload: text, stream: STREAM });
/** A bare `^done` for a command that carried a numeric token keeps the token in the raw text. @param {number | null} token */
export const doneItem = (token) => outputItem((token === null ? "" : String(token)) + "^done\r");

/** Text of the "not supported" error every unsupported MI command / type / expression gets. */
export const UNSUPPORTED = "not supported by the browser engine";
/** @param {string} what */
export const unsupportedMsg = (what) => `${what} is ${UNSUPPORTED}`;

/** @param {number} n @returns {string} 16-digit zero padded hex address as GDB prints it in MI */
export const hex16 = (n) => "0x" + n.toString(16).padStart(16, "0");
