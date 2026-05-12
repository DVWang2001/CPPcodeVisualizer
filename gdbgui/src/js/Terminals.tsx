import React from "react";
import GdbApi from "./GdbApi";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { store } from "statorgfc";
import "xterm/css/xterm.css";
import constants from "./constants";
import Actions from "./Actions";
import MonacoEditor from "@monaco-editor/react";

function customKeyEventHandler(config: {
  pty_name: string;
  pty: Terminal;
  canPaste: boolean;
  pidStoreKey: string;
}) {
  return async (e: KeyboardEvent): Promise<boolean> => {
    if (!(e.type === "keydown")) {
      return true;
    }
    if (e.shiftKey && e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === "c") {
        const toCopy = config.pty.getSelection();
        navigator.clipboard.writeText(toCopy);
        config.pty.focus();
        return false;
      } else if (key === "v") {
        if (!config.canPaste) {
          return false;
        }
        const toPaste = await navigator.clipboard.readText();

        GdbApi.getSocket().emit("pty_interaction", {
          data: { pty_name: config.pty_name, key: toPaste, action: "write" }
        });
        return false;
      }
    }
    return true;
  };
}

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export class Terminals extends React.Component<any, { programOutput: string; programInput: string; showTerminals: boolean }> {
  userPtyRef: React.RefObject<any>;
  programPtyRef: React.RefObject<any>;
  gdbguiPtyRef: React.RefObject<any>;
  _fitAddon: FitAddon | null = null;
  _gdbguiFitAddon: FitAddon | null = null;
  _userPty: Terminal | null = null;
  _gdbguiPty: Terminal | null = null;
  _pendingUserData: string[] = [];
  _pendingGdbguiData: string[] = [];
  _xtermOpened = false;
  _containerRef = React.createRef<HTMLDivElement>();
  _isDragging = false;
  _dragStartX = 0;
  _dragStartWidth = 0;

  constructor(props: any) {
    super(props);
    this.userPtyRef = React.createRef();
    this.programPtyRef = React.createRef();
    this.gdbguiPtyRef = React.createRef();
    this.terminal = this.terminal.bind(this);

    this.state = {
      programOutput: "",
      programInput: localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "",
      showTerminals: false,
      terminalWidthPct: 50,
    } as any;

    this.sendInputToPty = this.sendInputToPty.bind(this);
    // @ts-expect-error
    store.connectComponentState(this, ["tts_subtitle", "edit_mode"]);
  }

  sendInputToPty() {
    const input = this.state.programInput || store.get("program_input") || "";
    if (!input) {
      return;
    }
    const GdbApi = require("./GdbApi").default;
    const socket = GdbApi.getSocket();
    if (socket && !socket.disconnected) {
      socket.emit("pty_interaction", {
        data: { pty_name: "program_pty", key: input + "\n", action: "write" }
      });
    }
  }

  componentDidUpdate(prevProps: any, prevState: any) {
    const wasShown = (prevState as any).showTerminals;
    const isShown = (this.state as any).showTerminals;
    if (!wasShown && isShown) {
      if (!this._xtermOpened) {
        // 第一次顯示：現在容器可見，安全呼叫 open()
        this._xtermOpened = true;
        setTimeout(() => this._openXterm(), 0);
      } else {
        // 再次顯示：只需重算尺寸
        setTimeout(() => {
          try { this._fitAddon?.fit(); } catch (e) { }
          try { this._gdbguiFitAddon?.fit(); } catch (e) { }
        }, 50);
      }
    }
  }

  _openXterm() {
    const userPty = this._userPty!;
    const gdbguiPty = this._gdbguiPty!;

    // Open on now-visible containers
    userPty.open(this.userPtyRef.current!);
    gdbguiPty.open(this.gdbguiPtyRef.current!);

    // Flush buffered data
    for (const d of this._pendingUserData) { try { userPty.write(d); } catch (e) { } }
    this._pendingUserData = [];
    for (const d of this._pendingGdbguiData) { try { gdbguiPty.write(d); } catch (e) { } }
    this._pendingGdbguiData = [];

    setTimeout(() => {
      try { this._fitAddon?.fit(); } catch (e) { }
      try { this._gdbguiFitAddon?.fit(); } catch (e) { }
    }, 50);
  }

  terminal(ref: React.RefObject<any>) {
    return (
      <div style={{ flex: 1, minWidth: 0, position: "relative", backgroundColor: "black", height: "100%" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }} ref={ref} />
      </div>
    );
  }

  _onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    this._isDragging = true;
    this._dragStartX = e.clientX;
    this._dragStartWidth = (this.state as any).terminalWidthPct;

    const onMove = (ev: MouseEvent) => {
      if (!this._isDragging || !this._containerRef.current) return;
      const containerW = this._containerRef.current.getBoundingClientRect().width;
      const dx = ev.clientX - this._dragStartX;
      const newPct = Math.min(85, Math.max(15, this._dragStartWidth + (dx / containerW) * 100));
      (this as any).setState({ terminalWidthPct: newPct }, () => {
        // xterm canvas needs to re-fit after width change
        setTimeout(() => {
          try { this._fitAddon?.fit(); } catch (_) { }
          try { this._gdbguiFitAddon?.fit(); } catch (_) { }
        }, 0);
      });
    };
    const onUp = () => {
      this._isDragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  render() {
    const { showTerminals, terminalWidthPct } = this.state as any;
    const ttsSubtitle: { text: string; line?: number } | null = (this.state as any).tts_subtitle || null;
    const editMode: boolean = !!(this.state as any).edit_mode;

    return (
      <div className="w-full h-full relative flex flex-col">
        {/* 頂部工具列 */}
        <div style={{ flexShrink: 0, padding: "2px 6px", backgroundColor: "#1e1e1e", display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => (this as any).setState({ showTerminals: !showTerminals })}
            style={{
              fontSize: 11, padding: "1px 8px", cursor: "pointer",
              backgroundColor: showTerminals ? "#555" : "#333",
              color: "#ccc", border: "1px solid #666", borderRadius: 3
            }}
          >
            {showTerminals ? "隱藏 Terminal" : "查看 Terminal"}
          </button>
          {ttsSubtitle && (
            <span style={{ fontSize: 11, color: "#5cb85c", fontFamily: "sans-serif" }}>
              ▶ TTS 播放中
            </span>
          )}
        </div>

        {/* 主要內容區：terminal 欄 + Standard I/O */}
        <div ref={this._containerRef} className="flex-1 relative" style={{ minHeight: 0 }}>
          <div style={{ display: "flex", width: "100%", height: "100%" }}>
            {/* 兩個黑色 terminal：showTerminals 為 false 時用 display:none 隱藏但保留 DOM */}
            <div style={{ display: showTerminals ? "flex" : "none", width: `${terminalWidthPct}%`, flexShrink: 0, gap: 8 }}>
        {this.terminal(this.userPtyRef)}
        {/* <GdbGuiTerminal /> */}
        {this.terminal(this.gdbguiPtyRef)}
            </div>

            {/* Drag handle — terminal 顯示時才出現 */}
            {showTerminals && (
              <div
                onMouseDown={this._onDragStart}
                style={{
                  width: 5, flexShrink: 0, cursor: "col-resize",
                  backgroundColor: "#444",
                  transition: "background-color 0.15s",
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#888")}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#444")}
              />
            )}

            {/* Standard Input / Output 或 TTS 字幕 */}
            <div style={{ flex: 1, overflow: "hidden", minWidth: 0, position: "relative" }}>

              {/* ── TTS 大字幕（非 edit 模式時黑色背景常駐，文字僅在播放時顯示）── */}
              {!editMode && <div style={{
                position: "absolute", inset: 0, zIndex: 10,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                backgroundColor: "#0d1117",
                padding: "24px 48px",
              }}>
                {ttsSubtitle && ttsSubtitle.line !== undefined && (
                  <div style={{
                    marginBottom: "12px",
                    fontSize: "13px", color: "#58a6ff",
                    fontFamily: "monospace", letterSpacing: "0.05em",
                  }}>
                    第 {ttsSubtitle.line} 行
                  </div>
                )}
                {ttsSubtitle && (
                  <div style={{
                    textAlign: "center",
                    color: "#e6edf3",
                    fontSize: "clamp(18px, 2.4vw, 32px)",
                    fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif",
                    lineHeight: 1.8,
                    maxWidth: "90%",
                    fontWeight: 500,
                    textShadow: "0 1px 6px rgba(0,0,0,0.8)",
                  }}>
                    {ttsSubtitle.text}
                  </div>
                )}
              </div>}

              {/* ── Standard I/O（edit 模式時可見，否則被黑色字幕層覆蓋）── */}
              <div style={{ display: "flex", width: "100%", height: "100%", visibility: editMode ? "visible" : "hidden" }}
                className="bg-white">
                {/* Left: Standard Input */}
                <div className="flex-1 border-r-2 border-gray-300 flex flex-col">
                  <div className="bg-gray-100 text-xs font-bold text-gray-600 px-2 py-1 uppercase tracking-wider flex justify-between items-center">
                    <span>Standard Input</span>
                    <button
                      className="text-blue-500 hover:text-blue-700 cursor-pointer outline-none font-normal lowercase"
                      onClick={this.sendInputToPty}
                      title="Send input to the running program"
                    >
                      send input
                    </button>
                  </div>
                  <div className="flex-1 relative">
                    <MonacoEditor
                      height="100%"
                      language="plaintext"
                      theme="light"
                      value={this.state.programInput}
                      editorDidMount={(getValue: any, editor: any) => {
                        editor.onDidChangeModelContent(() => {
                          const val = getValue();
                          this.setState({ programInput: val });
                          store.set("program_input", val);
                          localStorage.setItem("gdbgui_program_input", val);
                        });
                      }}
                      options={{
                        readOnly: false, minimap: { enabled: false }, wordWrap: "on",
                        scrollBeyondLastLine: false, automaticLayout: true, fontFamily: "monospace",
                        renderLineHighlight: "none", cursorBlink: "solid",
                        matchBrackets: "never", hideCursorInOverviewRuler: true, overviewRulerLanes: 0
                      } as any}
                    />
                  </div>
                </div>

                {/* Right: Standard Output */}
                <div className="flex-1 flex flex-col">
                  <div className="bg-gray-100 text-xs font-bold text-gray-600 px-2 py-1 flex justify-between uppercase tracking-wider">
                    <span>Standard Output</span>
                    <button
                      className="text-blue-500 hover:text-blue-700 cursor-pointer outline-none font-normal lowercase"
                      onClick={() => this.setState({ programOutput: "" })}
                    >
                      clear
                    </button>
                  </div>
                  <div className="flex-1 relative">
                    <MonacoEditor
                      height="100%"
                      language="plaintext"
                      theme="light"
                      value={this.state.programOutput}
                      editorDidMount={() => {}}
                      options={{
                        readOnly: true, minimap: { enabled: false }, wordWrap: "on",
                        scrollBeyondLastLine: false, automaticLayout: true, fontFamily: "monospace",
                        renderLineHighlight: "none", cursorBlink: "solid",
                        matchBrackets: "never", hideCursorInOverviewRuler: true, overviewRulerLanes: 0
                      } as any}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  componentDidMount() {
    // ── 原第一個 componentDidMount 的邏輯 ──────────────────────────────
    (window as any).gdbgui_flush_program_input = () => { this.sendInputToPty(); };
    const savedInput = localStorage.getItem("gdbgui_program_input") || "";
    if (savedInput) { store.set("program_input", savedInput); }

    // ── xterm 初始化 ───────────────────────────────────────────────────
    window.addEventListener('gdbgui:clear_program_output', () => {
      this.setState({ programOutput: "" });
    });

    // ── FitAddon（先建立，open() 之後才真正有用）─────────────────────
    this._fitAddon = new FitAddon();
    this._gdbguiFitAddon = new FitAddon();

    // ── userPty：建立但先不 open()，等 showTerminals 首次為 true 時再 open ──
    const userPty = new Terminal({ cursorBlink: true, macOptionIsMeta: true, scrollback: 9999 });
    userPty.loadAddon(this._fitAddon);
    userPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({ pty_name: "user_pty", pty: userPty, canPaste: true, pidStoreKey: "gdb_pid" })
    );
    userPty.onKey((data) => {
      GdbApi.getSocket().emit("pty_interaction", { data: { pty_name: "user_pty", key: data.key, action: "write" } });
      if (data.domEvent.code === "Enter") { Actions.onConsoleCommandRun(); }
    });
    // 先 buffer，open() 後再 flush
    GdbApi.getSocket().on("user_pty_response", (data: string) => {
      if (this._xtermOpened) { userPty.write(data); }
      else { this._pendingUserData.push(data); }
    });
    this._userPty = userPty;

    // ── gdbguiPty：同上，先不 open() ─────────────────────────────────
    const gdbguiPty = new Terminal({ cursorBlink: false, macOptionIsMeta: true, scrollback: 9999, disableStdin: true });
    gdbguiPty.loadAddon(this._gdbguiFitAddon);
    gdbguiPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({ pty_name: "unused", pty: gdbguiPty, canPaste: false })
    );
    // 初始歡迎訊息先 buffer
    this._pendingGdbguiData.push(
      constants.xtermColors.grey,
      `running command: ${store.get("gdb_command")}\r\n`,
      "gdbgui output (read-only)\r\n",
      "Copy/Paste: ctrl+shift+c / ctrl+shift+v\r\n",
      constants.xtermColors.reset
    );
    store.set("gdbguiPty", gdbguiPty); // 讓其他模組可以 write（會在 open 後才真正顯示）
    this._gdbguiPty = gdbguiPty;

    // ── program_pty_response → Standard Output Monaco ─────────────────
    GdbApi.getSocket().on("program_pty_response", (pty_response: string) => {
      const cleanText = pty_response.replace(ansiRegex, '');
      this.setState(prev => ({ programOutput: prev.programOutput + cleanText }));
    });

    // ── 定期 fit + winsize ─────────────────────────────────────────────
    setInterval(() => {
      if (!this._xtermOpened) return;
      try { this._fitAddon?.fit(); } catch (e) { }
      try { this._gdbguiFitAddon?.fit(); } catch (e) { }
      const socket = GdbApi.getSocket();
      if (socket.disconnected) return;
      socket.emit("pty_interaction", {
        data: { pty_name: "user_pty", rows: userPty.rows, cols: userPty.cols, action: "set_winsize" }
      });
    }, 2000);
  }
}
