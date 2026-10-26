import React from "react";
import GdbApi from "./GdbApi";
import { store } from "statorgfc";
import MonacoEditor from "@monaco-editor/react";
import { randomTestDataFor } from "./randomTestData";

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * 底部：標準輸入／標準輸出（被偵錯程式自己的 I/O），以及播放模式的 TTS 大字幕層。
 * 原本還有兩個 xterm（GDB 主控台、gdbgui 唯讀輸出）；偵錯引擎改成瀏覽器內的 wasm 引擎後，
 * GDB 主控台輸入一律回「unsupported」，已經整個拿掉。
 */
export class Terminals extends React.Component<any, { programOutput: string; program_input: string }> {
  constructor(props: any) {
    super(props);

    this.state = {
      programOutput: "",
      program_input: localStorage.getItem("gdbgui_program_input") || store.get("program_input") || "",
    } as any;

    this.sendInputToPty = this.sendInputToPty.bind(this);
    this.randomizeInput = this.randomizeInput.bind(this);
    // @ts-expect-error
    store.connectComponentState(this, [
      "tts_subtitle",
      "edit_mode",
      "program_input",
      "fullname_to_render",
      "user_source_fullname",
      "cached_source_files",
    ]);
  }

  sendInputToPty() {
    const input = (this.state as any).program_input || store.get("program_input") || "";
    if (!input) {
      return;
    }
    const socket = GdbApi.getSocket();
    if (socket && !socket.disconnected) {
      socket.emit("pty_interaction", {
        data: { pty_name: "program_pty", key: input + "\n", action: "write" }
      });
    }
  }

  randomizeInput() {
    const generator = randomTestDataFor(store.get("fullname_to_render"));
    if (!generator) return;
    const val = generator();
    this.setState({ program_input: val });
    store.set("program_input", val);
    localStorage.setItem("gdbgui_program_input", val);
  }

  render() {
    const ttsSubtitle: { text: string; line?: number } | null = (this.state as any).tts_subtitle || null;
    const editMode: boolean = !!(this.state as any).edit_mode;

    return (
      <div className="w-full h-full relative flex flex-col">
        {/* 標準輸入／輸出，或 TTS 字幕 */}
        <div className="flex-1 relative" style={{ minHeight: 0 }}>
          <div style={{ display: "flex", width: "100%", height: "100%" }}>
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
              <div style={{ display: "flex", width: "100%", height: "100%" }}
                className="bg-white">
                {/* Left: Standard Input */}
                <div className="flex-1 border-r-2 border-gray-300 flex flex-col">
                  <div className="bg-gray-100 text-xs font-bold text-gray-600 px-2 py-1 uppercase tracking-wider flex justify-between items-center">
                    <span>標準輸入 (Standard Input)</span>
                    <span>
                      {randomTestDataFor(store.get("fullname_to_render")) && (
                        <button
                          className="text-blue-500 hover:text-blue-700 cursor-pointer outline-none font-normal lowercase mr-3"
                          onClick={this.randomizeInput}
                          title="換一組隨機測資"
                        >
                          🎲 隨機測資
                        </button>
                      )}
                      <button
                        className="text-blue-500 hover:text-blue-700 cursor-pointer outline-none font-normal lowercase"
                        onClick={this.sendInputToPty}
                        title="把輸入送給正在執行的程式"
                      >
                        送出輸入
                      </button>
                    </span>
                  </div>
                  <div className="flex-1 relative">
                    <MonacoEditor
                      height="100%"
                      language="plaintext"
                      theme="light"
                      value={(this.state as any).program_input}
                      editorDidMount={(getValue: any, editor: any) => {
                        editor.onDidChangeModelContent(() => {
                          const val = getValue();
                          this.setState({ program_input: val });
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
                    <span>標準輸出 (Standard Output)</span>
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
    (window as any).gdbgui_flush_program_input = () => { this.sendInputToPty(); };
    const savedInput = localStorage.getItem("gdbgui_program_input") || "";
    if (savedInput) { store.set("program_input", savedInput); }

    window.addEventListener('gdbgui:clear_program_output', () => {
      this.setState({ programOutput: "" });
    });

    // ── program_pty_response → Standard Output Monaco ─────────────────
    GdbApi.getSocket().on("program_pty_response", (pty_response: string) => {
      const cleanText = pty_response.replace(ansiRegex, '');
      this.setState(prev => ({ programOutput: prev.programOutput + cleanText }));
    });
  }
}
