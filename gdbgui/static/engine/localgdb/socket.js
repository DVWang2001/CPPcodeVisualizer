// The subset of the socket.io-client Socket the gdbgui UI uses (spec §1, GdbApi.tsx / Terminals.tsx):
//   on(event, cb)  emit(event, payload)  connected  disconnected  close()
// plus small conveniences (once/off/disconnect). Delivery is asynchronous (microtask) so a caller can
// register handlers right after creation, exactly as with `io.connect(...)`.
// Plain ES module, no DOM / Node APIs.

export class LocalSocket {
  /** @param {{ onRunGdbCommand: (p: any) => void, onPtyInteraction: (p: any) => void }} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    this.connected = false;
    this.closed = false;
    /** @type {Map<string, Array<{ cb: (...a: any[]) => void, once: boolean }>>} */
    this.listeners = new Map();
    this.id = "local-gdb";
  }

  /** @param {string} ev @param {(...a: any[]) => void} cb */
  on(ev, cb) {
    const l = this.listeners.get(ev) || [];
    l.push({ cb, once: false });
    this.listeners.set(ev, l);
    return this;
  }

  /** @param {string} ev @param {(...a: any[]) => void} cb */
  once(ev, cb) {
    const l = this.listeners.get(ev) || [];
    l.push({ cb, once: true });
    this.listeners.set(ev, l);
    return this;
  }

  /** @param {string} [ev] @param {(...a: any[]) => void} [cb] */
  off(ev, cb) {
    if (ev === undefined) this.listeners.clear();
    else if (cb === undefined) this.listeners.delete(ev);
    else this.listeners.set(ev, (this.listeners.get(ev) || []).filter((x) => x.cb !== cb));
    return this;
  }
  removeListener(/** @type {string} */ ev, /** @type {(...a: any[]) => void} */ cb) { return this.off(ev, cb); }
  removeAllListeners(/** @type {string} */ ev) { return this.off(ev); }

  /** client -> server. @param {string} ev @param {any} payload */
  emit(ev, payload) {
    if (this.closed) return this;
    if (ev === "run_gdb_command") this.handlers.onRunGdbCommand(payload);
    else if (ev === "pty_interaction") this.handlers.onPtyInteraction(payload);
    // other client events (e.g. resize hints) have nothing to do here
    return this;
  }

  /** server -> client (internal). @param {string} ev @param {any} payload */
  deliver(ev, payload) {
    if (this.closed) return;
    const l = this.listeners.get(ev);
    if (!l) return;
    for (const x of [...l]) {
      if (x.once) this.off(ev, x.cb);
      try { x.cb(payload); } catch (e) { /* a throwing UI handler must not break the session */ if (typeof console !== "undefined") console.error(e); }
    }
  }

  /** socket.io-client: true until connected (Terminals.tsx / GdbApi.tsx test `socket.disconnected`). */
  get disconnected() { return !this.connected; }

  close() { this.closed = true; this.connected = false; return this; }
  disconnect() { return this.close(); }
}
